import type { ConversationSharingError } from "@app/lib/api/assistant/conversation/sharing";
import { getConversationSharing } from "@app/lib/api/assistant/conversation/sharing";
import { ConversationResource } from "@app/lib/resources/conversation_resource";
import { ConversationError } from "@app/types/assistant/conversation";
import { assertNever } from "@app/types/shared/utils/assert_never";
import { apiErrorForConversation } from "@front-api/lib/api/assistant/conversation/helper";
import { workspaceApp } from "@front-api/middlewares/ctx";
import { apiError } from "@front-api/middlewares/utils";
import { validate } from "@front-api/middlewares/validator";
import { z } from "zod";

const ParamsSchema = z.object({
  cId: z.string(),
});

function apiErrorForSharing(
  ctx: Parameters<typeof apiError>[0],
  error: ConversationSharingError
) {
  switch (error.type) {
    case "sharing_not_enabled":
      return apiError(ctx, {
        status_code: 403,
        api_error: { type: "feature_not_enabled", message: error.message },
      });
    case "not_supported_in_pod":
      return apiError(ctx, {
        status_code: 400,
        api_error: {
          type: "conversation_sharing_not_supported_in_pod",
          message: error.message,
        },
      });
    case "sharing_unavailable":
      return apiError(ctx, {
        status_code: 409,
        api_error: {
          type: "conversation_sharing_unavailable",
          message: error.message,
        },
      });
    case "not_shared":
      return apiError(ctx, {
        status_code: 403,
        api_error: {
          type: "conversation_access_restricted",
          message: error.message,
        },
      });
    case "dfs_error":
      return apiError(
        ctx,
        {
          status_code: 500,
          api_error: {
            type: "internal_server_error",
            message: "Failed to access the conversation's sharing.",
          },
        },
        error
      );
    default:
      assertNever(error.type);
  }
}

// Mounted at /api/w/:wId/assistant/conversations/:cId/sharing.
const app = workspaceApp();

/**
 * @swagger
 * /api/w/{wId}/assistant/conversations/{cId}/sharing:
 *   get:
 *     summary: Get conversation sharing
 *     description: Returns who a conversation is shared with, from the grants of its DFS folder.
 *     tags:
 *       - Private Conversations
 *     parameters:
 *       - in: path
 *         name: wId
 *         required: true
 *         description: ID of the workspace
 *         schema:
 *           type: string
 *       - in: path
 *         name: cId
 *         required: true
 *         description: ID of the conversation
 *         schema:
 *           type: string
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Success
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PrivateConversationSharingResponse'
 *       403:
 *         description: >
 *           Conversation sharing is not enabled for the workspace, or the conversation isn't shared
 *           with the user
 *       404:
 *         description: Conversation not found
 */

app.get("/", validate("param", ParamsSchema), async (ctx) => {
  const auth = ctx.get("auth");
  const { cId } = ctx.req.valid("param");

  const conversation = await ConversationResource.fetchById(auth, cId);
  if (!conversation) {
    return apiErrorForConversation(
      ctx,
      new ConversationError("conversation_not_found")
    );
  }

  const sharing = await getConversationSharing(auth, conversation);
  if (sharing.isErr()) {
    return apiErrorForSharing(ctx, sharing.error);
  }

  return ctx.json({ sharing: sharing.value });
});

export default app;
