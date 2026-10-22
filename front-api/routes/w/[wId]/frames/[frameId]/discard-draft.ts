import { discardFrameDraft } from "@app/lib/api/frames/discard_draft";
import { FileResource } from "@app/lib/resources/file_resource";
import type { DiscardFrameDraftResponseBody } from "@app/types/api/frame_discard_draft";
import { DiscardFrameDraftRequestBodySchema } from "@app/types/api/frame_discard_draft";
import { frameDiscardDraftApiError } from "@front-api/lib/api/frame_discard_draft_errors";
import { workspaceApp } from "@front-api/middlewares/ctx";
import { apiError } from "@front-api/middlewares/utils";
import { validate } from "@front-api/middlewares/validator";
import { z } from "zod";

const ParamsSchema = z.object({
  frameId: z.string(),
});

// Mounted at /api/w/:wId/frames/:frameId/discard-draft.
const app = workspaceApp();

/** @ignoreswagger */
app.post(
  "/",
  validate("param", ParamsSchema),
  validate("json", DiscardFrameDraftRequestBodySchema),
  async (ctx) => {
    const auth = ctx.get("auth");
    const { frameId } = ctx.req.valid("param");
    const { draftPublicationId } = ctx.req.valid("json");

    const frame = await FileResource.fetchById(auth, frameId);
    if (!frame?.isFrameV2) {
      return apiError(ctx, {
        status_code: 404,
        api_error: { type: "file_not_found", message: "Frame not found." },
      });
    }

    const result = await discardFrameDraft(auth, {
      frame,
      draftPublicationId,
    });
    if (result.isErr()) {
      return apiError(
        ctx,
        frameDiscardDraftApiError(result.error),
        result.error
      );
    }

    return ctx.json<DiscardFrameDraftResponseBody>(result.value);
  }
);

export default app;
