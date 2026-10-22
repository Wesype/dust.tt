import type { FrameDiscardDraftError } from "@app/lib/api/frames/discard_draft";
import type { APIErrorWithContentfulStatusCode } from "@app/types/error";
import { assertNever } from "@app/types/shared/utils/assert_never";

/** Maps a discard-draft failure to the API error it is served as. */
export function frameDiscardDraftApiError(
  error: FrameDiscardDraftError
): APIErrorWithContentfulStatusCode {
  const { message } = error;
  const code = error.code;
  switch (code) {
    case "unauthorized":
      return {
        status_code: 403,
        api_error: { type: "file_read_only", message },
      };
    case "frame_not_found":
      return {
        status_code: 404,
        api_error: { type: "file_not_found", message },
      };
    case "not_in_draft_mode":
    case "draft_conflict":
      return {
        status_code: 409,
        api_error: { type: "frame_draft_conflict", message },
      };
    case "source_not_stored":
    case "unsupported_source_folder":
      return {
        status_code: 409,
        api_error: { type: "frame_discard_unavailable", message },
      };
    // The archive was written and checked when the publication was stored: one that no longer
    // parses is a server fault the caller can retry at best.
    case "source_archive_invalid":
      return {
        status_code: 500,
        api_error: { type: "internal_server_error", message },
      };
    // The source may be partly restored: the editor must know that discarding again finishes it.
    case "restore_failed":
      return {
        status_code: 500,
        api_error: { type: "frame_discard_incomplete", message },
      };
    default:
      return assertNever(code);
  }
}
