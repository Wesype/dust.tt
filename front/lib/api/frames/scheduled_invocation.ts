import { canWriteFrameV2Source } from "@app/lib/api/frames/permissions";
import { loadFramePublicationDescriptor } from "@app/lib/api/frames/publication_storage";
import { getFramePublicationSchedules } from "@app/lib/api/frames/schedule_ids";
import { runOnRedis } from "@app/lib/api/redis";
import { resolveActiveFrameFunctionForUse } from "@app/lib/api/sandbox_functions/frame_share_capability";
import { Authenticator, getFeatureFlags } from "@app/lib/auth";
import { FileResource } from "@app/lib/resources/file_resource";
import { FramePublicationResource } from "@app/lib/resources/frame_publication_resource";
import type { SandboxFunctionInvocationResource } from "@app/lib/resources/sandbox_function_invocation_resource";
import { UserResource } from "@app/lib/resources/user_resource";
import { isFramesV2SchedulesEnabled } from "@app/types/shared/feature_flags";
import type { Result } from "@app/types/shared/result";
import { Err } from "@app/types/shared/result";

export type FrameScheduledInvocationErrorCode =
  | "schedules_disabled"
  | "frame_not_found"
  | "publication_not_active"
  | "publication_unreadable"
  | "schedule_not_found"
  | "function_not_found"
  | "publisher_unavailable"
  | "publisher_access_lost"
  | "duplicate_fire"
  | "invocation_refused";

// How long a fire instant is remembered. It only has to outlive the retries and replays of that
// one instant, not the gap to the next fire: each fire time has its own claim.
const FIRE_GUARD_TTL_SECONDS = 24 * 60 * 60;

/**
 * @cc [owner:smb2268,label:product] one-invocation-per-scheduled-fire
 * A fire is identified by `(workspace, frame, schedule, scheduledFireTime)`; fires of the same
 * schedule at different times are independent. For one fire, at most one invocation MAY be
 * created: a second request for the same fire within `FIRE_GUARD_TTL_SECONDS` of the first MUST be
 * refused with `duplicate_fire` before any invocation row exists. The claim MUST be taken only
 * after every refusal that needs no invocation, and MUST NOT be released afterwards, since an
 * invocation row may exist whatever `invoke` returns.
 */
async function claimScheduledFire(key: string): Promise<boolean> {
  const claimed = await runOnRedis(
    { origin: "frame_schedule_fires" },
    (redis) => redis.set(key, "1", { NX: true, EX: FIRE_GUARD_TTL_SECONDS })
  );
  return claimed === "OK";
}

export class FrameScheduledInvocationError extends Error {
  constructor(
    readonly code: FrameScheduledInvocationErrorCode,
    message: string
  ) {
    super(message);
    this.name = "FrameScheduledInvocationError";
  }
}

function refused(code: FrameScheduledInvocationErrorCode, message: string) {
  return new Err(new FrameScheduledInvocationError(code, message));
}

/**
 * @cc [owner:smb2268,label:security;product] scheduled-run-is-publisher-bound
 * A scheduled invocation MUST run as the user recorded as publisher of the Frame's current active
 * publication, and only when that publication is `expectedPublicationId`, the publisher is still a
 * workspace member who can write the Frame's source, and the schedule is declared in that
 * publication. Any other state MUST be refused before an invocation row exists; no other identity
 * MAY be substituted for a missing or ineligible publisher. The `scheduled` origin MUST be set
 * only here: API routes derive origins from the caller's auth method, never from the client.
 */
export async function invokeScheduledFrameFunction({
  workspaceId,
  frameId,
  scheduleId,
  expectedPublicationId,
  scheduledFireTime,
}: {
  workspaceId: string;
  frameId: string;
  scheduleId: string;
  expectedPublicationId: string;
  scheduledFireTime: Date;
}): Promise<
  Result<SandboxFunctionInvocationResource, FrameScheduledInvocationError>
> {
  // Admin auth only reads the Frame and its publication row to find the publisher; everything
  // from the permission checks on runs under the publisher's own auth.
  const adminAuth = await Authenticator.internalAdminForWorkspace(workspaceId);
  if (!isFramesV2SchedulesEnabled(await getFeatureFlags(adminAuth))) {
    return refused(
      "schedules_disabled",
      "Frame schedules are not enabled for this workspace."
    );
  }

  const frame = await FileResource.fetchById(adminAuth, frameId);
  if (!frame?.isFrameV2) {
    return refused("frame_not_found", `Frame not found: ${frameId}`);
  }
  const activePublicationId = frame.useCaseMetadata?.activePublicationId;
  if (!activePublicationId || activePublicationId !== expectedPublicationId) {
    return refused(
      "publication_not_active",
      `Publication ${expectedPublicationId} is not the active publication of Frame ${frameId}.`
    );
  }

  const publication = await FramePublicationResource.fetchForFramePublication(
    adminAuth,
    frame,
    activePublicationId
  );
  const [publisher] = publication?.publishedByUserId
    ? await UserResource.fetchByModelIds([publication.publishedByUserId])
    : [];
  if (!publisher) {
    return refused(
      "publisher_unavailable",
      `The active publication of Frame ${frameId} has no publisher to run as.`
    );
  }
  const publisherAuth = await Authenticator.fromUserIdAndWorkspaceId(
    publisher.sId,
    workspaceId
  );
  if (!publisherAuth.isUser()) {
    return refused(
      "publisher_unavailable",
      `The publisher of Frame ${frameId} is no longer a member of the workspace.`
    );
  }
  if (!(await canWriteFrameV2Source(publisherAuth, frame))) {
    return refused(
      "publisher_access_lost",
      `The publisher of Frame ${frameId} can no longer write its source.`
    );
  }

  const descriptor = await loadFramePublicationDescriptor(publisherAuth, {
    frame,
    publicationId: activePublicationId,
  });
  if (descriptor.isErr()) {
    return refused("publication_unreadable", descriptor.error.message);
  }
  const schedule = getFramePublicationSchedules(descriptor.value).find(
    (candidate) => candidate.id === scheduleId
  );
  if (!schedule) {
    return refused(
      "schedule_not_found",
      `Schedule "${scheduleId}" is not declared by the active publication of Frame ${frameId}.`
    );
  }

  // Resolves against the live publication on a fresh Frame read, so a pointer that moved since the
  // checks above fails closed.
  const sandboxFunction = await resolveActiveFrameFunctionForUse(
    publisherAuth,
    { frameId, functionName: schedule.functionName, target: "live" }
  );
  if (
    !sandboxFunction ||
    sandboxFunction.publicationId !== activePublicationId ||
    sandboxFunction.executionMode !== "durable"
  ) {
    return refused(
      "function_not_found",
      `Durable function "${schedule.functionName}" not found in the active publication of Frame ${frameId}.`
    );
  }

  const invocable = await sandboxFunction.checkInvocable(publisherAuth, {
    origin: "scheduled",
  });
  if (invocable.isErr()) {
    return refused("invocation_refused", invocable.error.message);
  }

  const fireKey = `frame_schedule_fire:${workspaceId}:${frameId}:${scheduleId}:${scheduledFireTime.toISOString()}`;
  if (!(await claimScheduledFire(fireKey))) {
    return refused(
      "duplicate_fire",
      `Schedule "${scheduleId}" of Frame ${frameId} already fired at ${scheduledFireTime.toISOString()}.`
    );
  }

  const invocation = await sandboxFunction.invoke(
    publisherAuth,
    {
      input: schedule.input,
      context: {
        timezone: schedule.timezone,
        scheduleId,
        scheduledFireTime: scheduledFireTime.toISOString(),
      },
    },
    { origin: "scheduled" }
  );
  if (invocation.isErr()) {
    return refused("invocation_refused", invocation.error.message);
  }

  return invocation;
}
