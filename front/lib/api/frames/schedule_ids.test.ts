import { describe, expect, it } from "vitest";

import {
  deriveFrameScheduleId,
  getFramePublicationSchedules,
  MAX_FRAME_SCHEDULE_ID_LENGTH,
} from "@app/lib/api/frames/schedule_ids";
import {
  FrameManifestSchema,
  MAX_FRAME_FUNCTION_NAME_LENGTH,
} from "@app/types/api/frame_manifest";

describe("deriveFrameScheduleId", () => {
  const SCHEDULE = {
    cron: "0 9 * * 1-5",
    timezone: "Europe/Paris",
    input: { source: "crm", limit: 50 },
  };
  const SCHEDULE_ID = deriveFrameScheduleId({
    functionName: "add-task",
    ...SCHEDULE,
  });

  it("prefixes the id with the function name", () => {
    expect(SCHEDULE_ID).toMatch(/^add-task-[0-9a-f]{16}$/);
  });

  it("derives the same id for the same declaration and a new one for any change", () => {
    const same = deriveFrameScheduleId({
      functionName: "add-task",
      ...SCHEDULE,
      input: { limit: 50, source: "crm" },
    });
    expect(same).toBe(SCHEDULE_ID);

    for (const changed of [
      { ...SCHEDULE, cron: "0 10 * * 1-5" },
      { ...SCHEDULE, timezone: "UTC" },
      { ...SCHEDULE, input: { source: "billing", limit: 50 } },
    ]) {
      expect(
        deriveFrameScheduleId({ functionName: "add-task", ...changed })
      ).not.toBe(SCHEDULE_ID);
    }
    expect(
      deriveFrameScheduleId({ functionName: "list-tasks", ...SCHEDULE })
    ).not.toBe(SCHEDULE_ID);
  });

  it("keeps derived ids within the id length limit", () => {
    const id = deriveFrameScheduleId({
      functionName: "a".repeat(MAX_FRAME_FUNCTION_NAME_LENGTH),
      ...SCHEDULE,
    });

    expect(id).toHaveLength(MAX_FRAME_SCHEDULE_ID_LENGTH);
    expect(id).toMatch(/-[0-9a-f]{16}$/);
  });

  it("keeps functions apart even when their names agree on the visible prefix", () => {
    const prefix = "a".repeat(MAX_FRAME_SCHEDULE_ID_LENGTH);
    const first = deriveFrameScheduleId({
      functionName: `${prefix}-one`,
      ...SCHEDULE,
    });
    const second = deriveFrameScheduleId({
      functionName: `${prefix}-two`,
      ...SCHEDULE,
    });

    expect(first.slice(0, -17)).toBe(second.slice(0, -17));
    expect(first).not.toBe(second);
  });
});

describe("getFramePublicationSchedules", () => {
  const SCHEDULE = {
    cron: "0 9 * * 1-5",
    timezone: "Europe/Paris",
    input: { source: "crm" },
  };

  it("flattens the stored manifest's schedules with their derived ids", () => {
    const manifest = FrameManifestSchema.parse({
      version: 1,
      description: "Track tasks.",
      functions: [
        {
          name: "add-task",
          description: "Add a task.",
          entryPoint: "functions/add_task.ts",
          executionMode: "durable",
          schedules: [SCHEDULE, { ...SCHEDULE, cron: "0 18 * * *" }],
        },
        {
          name: "list-tasks",
          description: "List tasks.",
          entryPoint: "functions/list_tasks.ts",
          executionMode: "durable",
          schedules: [SCHEDULE],
        },
      ],
    });

    expect(getFramePublicationSchedules({ manifest })).toEqual([
      {
        ...SCHEDULE,
        functionName: "add-task",
        id: deriveFrameScheduleId({ functionName: "add-task", ...SCHEDULE }),
      },
      {
        ...SCHEDULE,
        cron: "0 18 * * *",
        functionName: "add-task",
        id: deriveFrameScheduleId({
          functionName: "add-task",
          ...SCHEDULE,
          cron: "0 18 * * *",
        }),
      },
      {
        ...SCHEDULE,
        functionName: "list-tasks",
        id: deriveFrameScheduleId({ functionName: "list-tasks", ...SCHEDULE }),
      },
    ]);
  });

  it("returns no schedules for a manifest without any", () => {
    const manifest = FrameManifestSchema.parse({
      version: 1,
      description: "Track tasks.",
    });

    expect(getFramePublicationSchedules({ manifest })).toEqual([]);
  });
});
