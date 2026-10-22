import { createHash } from "node:crypto";

import type { FrameScheduleManifest } from "@app/types/api/frame_manifest";
import { canonicalFrameScheduleDeclaration } from "@app/types/api/frame_manifest";
import type { FramePublicationDescriptor } from "@app/types/api/frame_publication";

const FRAME_SCHEDULE_ID_HASH_LENGTH = 16;
export const MAX_FRAME_SCHEDULE_ID_LENGTH = 64;

/**
 * @cc [owner:smb2268,label:product] schedule-id-is-derived-from-its-declaration
 * A schedule's id MUST be computed from its function name and its canonical declaration (see
 * canonicalFrameScheduleDeclaration), both hashed, and never declared in the manifest or stored on
 * its own. Identical declarations MUST yield the same id and a change to the function name, cron,
 * timezone or input a different one, so reconciliation treats an edited schedule as a new schedule
 * and `(frameId, scheduleId)` identifies a schedule Frame-wide. The id MUST be at most
 * `MAX_FRAME_SCHEDULE_ID_LENGTH` characters.
 */
export function deriveFrameScheduleId({
  functionName,
  cron,
  timezone,
  input,
}: {
  functionName: string;
  cron: string;
  timezone: string;
  input: unknown;
}): string {
  // The name is hashed too: the readable prefix is truncated, so it alone cannot keep two long
  // function names apart.
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        functionName,
        canonicalFrameScheduleDeclaration({ cron, timezone, input }),
      ])
    )
    .digest("hex")
    .slice(0, FRAME_SCHEDULE_ID_HASH_LENGTH);
  const prefixLength =
    MAX_FRAME_SCHEDULE_ID_LENGTH - FRAME_SCHEDULE_ID_HASH_LENGTH - 1;
  return `${functionName.slice(0, prefixLength)}-${digest}`;
}

export type FramePublicationSchedule = FrameScheduleManifest & {
  id: string;
  functionName: string;
};

// The schedules of a stored publication, in manifest order, with their derived ids.
export function getFramePublicationSchedules(
  descriptor: Pick<FramePublicationDescriptor, "manifest">
): FramePublicationSchedule[] {
  return descriptor.manifest.functions.flatMap((fn) =>
    fn.schedules.map((schedule) => ({
      ...schedule,
      id: deriveFrameScheduleId({
        functionName: fn.name,
        cron: schedule.cron,
        timezone: schedule.timezone,
        input: schedule.input,
      }),
      functionName: fn.name,
    }))
  );
}
