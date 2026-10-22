import { canWriteFrameV2Source } from "@app/lib/api/frames/permissions";
import { deriveFrameScheduleId } from "@app/lib/api/frames/schedule_ids";
import { invokeScheduledFrameFunction } from "@app/lib/api/frames/scheduled_invocation";
import { revokeAndTrackMembership } from "@app/lib/api/membership";
import { resolveActiveFrameFunctionForUse } from "@app/lib/api/sandbox_functions/frame_share_capability";
import { SandboxFunctionInvocationResource } from "@app/lib/resources/sandbox_function_invocation_resource";
import { launchSandboxFunctionInvocationWorkflow } from "@app/temporal/sandbox_functions/client";
import {
  createTestScheduledFramePublication,
  TEST_SCHEDULED_FUNCTION_NAME,
} from "@app/tests/utils/FramePublicationFactory";
import { fileStorageMock } from "@app/tests/utils/mocks/file_storage";
import { Ok } from "@app/types/shared/result";
import assert from "assert";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@app/temporal/sandbox_functions/client", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@app/temporal/sandbox_functions/client")
    >();
  return {
    ...actual,
    launchSandboxFunctionInvocationWorkflow: vi.fn(
      async () => new Ok(undefined)
    ),
  };
});

vi.mock("@app/lib/api/frames/permissions", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@app/lib/api/frames/permissions")>();
  return {
    ...actual,
    canWriteFrameV2Source: vi.fn(actual.canWriteFrameV2Source),
  };
});

const SCHEDULE = {
  cron: "0 * * * *",
  timezone: "Europe/Paris",
  input: { source: "crm" },
};
const SCHEDULE_ID = deriveFrameScheduleId({
  functionName: TEST_SCHEDULED_FUNCTION_NAME,
  ...SCHEDULE,
});

const FIRE_TIME = new Date("2026-10-21T09:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  fileStorageMock.reset();
});

describe("invokeScheduledFrameFunction", () => {
  it("runs the scheduled function as the publisher with the stored input and fire context", async () => {
    const { workspace, publisher, frame, publicationId } =
      await createTestScheduledFramePublication({ schedule: SCHEDULE });

    const result = await invokeScheduledFrameFunction({
      workspaceId: workspace.sId,
      frameId: frame.sId,
      scheduleId: SCHEDULE_ID,
      expectedPublicationId: publicationId,
      scheduledFireTime: FIRE_TIME,
    });

    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      return;
    }
    const invocation = result.value;
    expect(invocation.origin).toBe("scheduled");
    expect(invocation.userId).toBe(publisher.id);
    expect(invocation.status).toBe("created");
    expect((await invocation.getData()).input).toEqual(SCHEDULE.input);
    expect(await invocation.getContext()).toEqual({
      timezone: SCHEDULE.timezone,
      scheduleId: SCHEDULE_ID,
      scheduledFireTime: FIRE_TIME.toISOString(),
    });
    expect(launchSandboxFunctionInvocationWorkflow).toHaveBeenCalledOnce();
  });

  it("creates at most one invocation per scheduled fire", async () => {
    const { adminAuth, workspace, frame, publicationId } =
      await createTestScheduledFramePublication({ schedule: SCHEDULE });
    const fire = {
      workspaceId: workspace.sId,
      frameId: frame.sId,
      scheduleId: SCHEDULE_ID,
      expectedPublicationId: publicationId,
      scheduledFireTime: FIRE_TIME,
    };

    const first = await invokeScheduledFrameFunction(fire);
    const duplicate = await invokeScheduledFrameFunction(fire);
    const nextFire = await invokeScheduledFrameFunction({
      ...fire,
      scheduledFireTime: new Date(FIRE_TIME.getTime() + 60 * 60 * 1000),
    });

    expect(first.isOk()).toBe(true);
    expect(duplicate.isErr() && duplicate.error.code).toBe("duplicate_fire");
    expect(nextFire.isOk()).toBe(true);
    expect(launchSandboxFunctionInvocationWorkflow).toHaveBeenCalledTimes(2);
    const sandboxFunction = await resolveActiveFrameFunctionForUse(adminAuth, {
      frameId: frame.sId,
      functionName: TEST_SCHEDULED_FUNCTION_NAME,
      target: "live",
    });
    assert(sandboxFunction);
    expect(
      await SandboxFunctionInvocationResource.listRows(adminAuth, {
        sandboxFunction,
        limit: 10,
      })
    ).toHaveLength(2);
  });

  it("refuses when Frame schedules are not enabled", async () => {
    const { workspace, frame, publicationId } =
      await createTestScheduledFramePublication({
        schedule: SCHEDULE,
        flags: ["frames_v2_functions"],
      });

    const result = await invokeScheduledFrameFunction({
      workspaceId: workspace.sId,
      frameId: frame.sId,
      scheduleId: SCHEDULE_ID,
      expectedPublicationId: publicationId,
      scheduledFireTime: FIRE_TIME,
    });

    expect(result.isErr() && result.error.code).toBe("schedules_disabled");
    expect(launchSandboxFunctionInvocationWorkflow).not.toHaveBeenCalled();
  });

  it("refuses a fire for a publication that is no longer active", async () => {
    const { workspace, frame } = await createTestScheduledFramePublication({
      schedule: SCHEDULE,
    });

    const result = await invokeScheduledFrameFunction({
      workspaceId: workspace.sId,
      frameId: frame.sId,
      scheduleId: SCHEDULE_ID,
      expectedPublicationId: "11111111-1111-4111-8111-111111111111",
      scheduledFireTime: FIRE_TIME,
    });

    expect(result.isErr() && result.error.code).toBe("publication_not_active");
    expect(launchSandboxFunctionInvocationWorkflow).not.toHaveBeenCalled();
  });

  it("refuses a schedule the active publication does not declare", async () => {
    const { workspace, frame, publicationId } =
      await createTestScheduledFramePublication({ schedule: SCHEDULE });

    const result = await invokeScheduledFrameFunction({
      workspaceId: workspace.sId,
      frameId: frame.sId,
      scheduleId: "nightly-refresh",
      expectedPublicationId: publicationId,
      scheduledFireTime: FIRE_TIME,
    });

    expect(result.isErr() && result.error.code).toBe("schedule_not_found");
    expect(launchSandboxFunctionInvocationWorkflow).not.toHaveBeenCalled();
  });

  it("refuses when the publisher left the workspace, without substituting anyone", async () => {
    const { workspace, adminAuth, publisher, frame, publicationId } =
      await createTestScheduledFramePublication({ schedule: SCHEDULE });
    const revoked = await revokeAndTrackMembership(adminAuth, publisher);
    expect(revoked.isOk()).toBe(true);

    const result = await invokeScheduledFrameFunction({
      workspaceId: workspace.sId,
      frameId: frame.sId,
      scheduleId: SCHEDULE_ID,
      expectedPublicationId: publicationId,
      scheduledFireTime: FIRE_TIME,
    });

    expect(result.isErr() && result.error.code).toBe("publisher_unavailable");
    expect(launchSandboxFunctionInvocationWorkflow).not.toHaveBeenCalled();
  });

  it("refuses when the publisher can no longer write the Frame source", async () => {
    const { workspace, frame, publicationId } =
      await createTestScheduledFramePublication({ schedule: SCHEDULE });
    vi.mocked(canWriteFrameV2Source).mockResolvedValueOnce(false);

    const result = await invokeScheduledFrameFunction({
      workspaceId: workspace.sId,
      frameId: frame.sId,
      scheduleId: SCHEDULE_ID,
      expectedPublicationId: publicationId,
      scheduledFireTime: FIRE_TIME,
    });

    expect(result.isErr() && result.error.code).toBe("publisher_access_lost");
    expect(launchSandboxFunctionInvocationWorkflow).not.toHaveBeenCalled();
  });

  it("refuses a function that requires a live user session", async () => {
    const { workspace, frame, publicationId } =
      await createTestScheduledFramePublication({
        schedule: SCHEDULE,
        userIdentity: "interactive_workspace_user_required",
      });

    const fire = {
      workspaceId: workspace.sId,
      frameId: frame.sId,
      scheduleId: SCHEDULE_ID,
      expectedPublicationId: publicationId,
      scheduledFireTime: FIRE_TIME,
    };

    const result = await invokeScheduledFrameFunction(fire);
    // Refusals come before the claim: a retry is refused for the same reason, not as a duplicate.
    const retry = await invokeScheduledFrameFunction(fire);

    expect(result.isErr() && result.error.code).toBe("invocation_refused");
    expect(retry.isErr() && retry.error.code).toBe("invocation_refused");
    expect(launchSandboxFunctionInvocationWorkflow).not.toHaveBeenCalled();
  });
});
