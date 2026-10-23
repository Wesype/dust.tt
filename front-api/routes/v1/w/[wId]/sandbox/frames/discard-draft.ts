import { discardFrameDraft } from "@app/lib/api/frames/discard_draft";
import { resolveWritableSandboxFrame } from "@app/lib/api/frames/sandbox_frame_lookup";
import { frameDiscardDraftApiError } from "@front-api/lib/api/frame_discard_draft_errors";
import { sandboxFrameLookupApiError } from "@front-api/lib/api/sandbox_frame_lookup_errors";
import { sandboxApp } from "@front-api/middlewares/ctx";
import type { HandlerResult } from "@front-api/middlewares/utils";
import { apiError } from "@front-api/middlewares/utils";
import { validate } from "@front-api/middlewares/validator";
import { z } from "zod";

const FrameDiscardDraftRequestSchema = z.object({
  // Scoped path of the Frame's manifest.json, as `publish` takes it.
  manifestPath: z.string().min(1),
});

type FrameDiscardDraftResponse = {
  frameId: string;
  publicationId: string;
};

// Mounted at /api/v1/w/:wId/sandbox/frames/discard-draft.
const app = sandboxApp();

/**
 * @ignoreswagger
 * internal endpoint
 */
app.post(
  "/",
  validate("json", FrameDiscardDraftRequestSchema),
  async (ctx): HandlerResult<FrameDiscardDraftResponse> => {
    const auth = ctx.get("auth");
    const resolved = await resolveWritableSandboxFrame(auth, {
      claims: ctx.get("sandboxClaims"),
      manifestPath: ctx.req.valid("json").manifestPath,
    });
    if (resolved.isErr()) {
      return apiError(
        ctx,
        sandboxFrameLookupApiError(resolved.error),
        resolved.error
      );
    }
    const { frame } = resolved.value;

    // The sandbox only knows the Frame, not a draft publication: discard whichever draft is
    // pending under the locks.
    const result = await discardFrameDraft(auth, { frame });
    if (result.isErr()) {
      return apiError(
        ctx,
        frameDiscardDraftApiError(result.error),
        result.error
      );
    }

    return ctx.json(
      { frameId: frame.sId, publicationId: result.value.publicationId },
      200
    );
  }
);

export default app;
