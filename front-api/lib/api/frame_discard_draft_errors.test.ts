import { FrameDiscardDraftError } from "@app/lib/api/frames/discard_draft";
import { frameDiscardDraftApiError } from "@front-api/lib/api/frame_discard_draft_errors";
import { describe, expect, it } from "vitest";

describe("frameDiscardDraftApiError", () => {
  it("tells the editor a failed restore is only partial", () => {
    const error = new FrameDiscardDraftError("restore_failed", "Write failed.");

    expect(frameDiscardDraftApiError(error)).toEqual({
      status_code: 500,
      api_error: { type: "frame_discard_incomplete", message: "Write failed." },
    });
  });

  it("serves an invalid archive as an internal error", () => {
    const error = new FrameDiscardDraftError(
      "source_archive_invalid",
      "Bad archive."
    );

    expect(frameDiscardDraftApiError(error)).toEqual({
      status_code: 500,
      api_error: { type: "internal_server_error", message: "Bad archive." },
    });
  });
});
