import { updateAuthorizedTools } from "@app/lib/api/frames/tool_authorization";
import { FileResource } from "@app/lib/resources/file_resource";
import type { PostFrameToolAuthorizationResponseBody } from "@app/types/api/frame_permissions";
import { FrameToolCallPairSchema } from "@app/types/api/frame_publication";
import { assertNever } from "@app/types/shared/utils/assert_never";
import { workspaceApp } from "@front-api/middlewares/ctx";
import { apiError } from "@front-api/middlewares/utils";
import { validate } from "@front-api/middlewares/validator";
import { z } from "zod";

const ParamsSchema = z.object({
  frameId: z.string(),
});

const BodySchema = z.object({
  // Client must echo the requiredTools it consented to; we only persist when they
  // match the active publication so a stale consent UI cannot under-authorize.
  authorizedTools: z.array(FrameToolCallPairSchema),
});

// Mounted at /api/w/:wId/frames/:frameId/tool-authorizations.
const app = workspaceApp();

/** @ignoreswagger */
app.post(
  "/",
  validate("param", ParamsSchema),
  validate("json", BodySchema),
  async (ctx) => {
    const auth = ctx.get("auth");
    const user = auth.user();
    if (!user) {
      return apiError(ctx, {
        status_code: 401,
        api_error: {
          type: "not_authenticated",
          message: "Authentication required.",
        },
      });
    }

    const { frameId } = ctx.req.valid("param");
    const { authorizedTools } = ctx.req.valid("json");
    const frame = await FileResource.fetchById(auth, frameId);

    if (!frame) {
      return apiError(ctx, {
        status_code: 404,
        api_error: { type: "file_not_found", message: "Frame not found." },
      });
    }

    const result = await updateAuthorizedTools(auth, {
      frame,
      authorizedTools,
    });

    if (result.isErr()) {
      switch (result.error.code) {
        case "file_not_found":
          return apiError(ctx, {
            status_code: 404,
            api_error: {
              type: "file_not_found",
              message: result.error.message,
            },
          });
        case "invalid_request_error":
          return apiError(ctx, {
            status_code: 400,
            api_error: {
              type: "invalid_request_error",
              message: result.error.message,
            },
          });
        default:
          assertNever(result.error.code);
      }
    }

    const authorization = result.value;

    return ctx.json<PostFrameToolAuthorizationResponseBody>({
      authorizedTools: authorization.authorizedTools,
    });
  }
);

export default app;
