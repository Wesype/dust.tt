import type { ConversationSharingError } from "@app/lib/api/assistant/conversation/sharing";
import {
  getConversationSharing,
  updateConversationSharing,
} from "@app/lib/api/assistant/conversation/sharing";
import { ConversationResource } from "@app/lib/resources/conversation_resource";
import { ConversationError } from "@app/types/assistant/conversation";
import { assertNever } from "@app/types/shared/utils/assert_never";
import { apiErrorForConversation } from "@front-api/lib/api/assistant/conversation/helper";
import { workspaceApp } from "@front-api/middlewares/ctx";
import { apiError } from "@front-api/middlewares/utils";
import { validate } from "@front-api/middlewares/validator";
import { z } from "zod";

// See `UpdateGrants` in `dfs/design-docs/API.md`, which takes up to 512 changes.
const MAX_SHARING_CHANGES = 100;

const ParamsSchema = z.object({
  cId: z.string(),
});

const PatchSharingBodySchema = z.object({
  changes: z
    .array(
      z.object({
        userId: z.string(),
        permission: z.enum(["read", "write", "none"]),
      })
    )
    .min(1)
    .max(MAX_SHARING_CHANGES)
    .refine(
      (changes) =>
        new Set(changes.map((change) => change.userId)).size === changes.length,
      { message: "Each user can only appear once." }
    ),
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
    case "not_allowed":
      return apiError(ctx, {
        status_code: 403,
        api_error: {
          type: "conversation_sharing_not_allowed",
          message: error.message,
        },
      });
    case "user_not_found":
      return apiError(ctx, {
        status_code: 404,
        api_error: { type: "user_not_found", message: error.message },
      });
    case "user_not_member":
      return apiError(ctx, {
        status_code: 400,
        api_error: { type: "workspace_user_not_found", message: error.message },
      });
    case "owner_not_editable":
      return apiError(ctx, {
        status_code: 400,
        api_error: {
          type: "conversation_owner_access_not_editable",
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
 *   patch:
 *     summary: Update conversation sharing
 *     description: >
 *       Gives users read or write access to a conversation, or removes it with `none`, by
 *       updating the grants of its DFS folder. Requires write access to the conversation.
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
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - changes
 *             properties:
 *               changes:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required:
 *                     - userId
 *                     - permission
 *                   properties:
 *                     userId:
 *                       type: string
 *                     permission:
 *                       type: string
 *                       enum: [read, write, none]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: The updated sharing
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PrivateConversationSharingResponse'
 *       204:
 *         description: Updated, and the user can't access the conversation anymore
 *       400:
 *         description: Invalid request
 *       403:
 *         description: Not allowed to change the sharing
 *       404:
 *         description: Conversation or user not found
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

app.patch(
  "/",
  validate("param", ParamsSchema),
  validate("json", PatchSharingBodySchema),
  async (ctx) => {
    const auth = ctx.get("auth");
    const { cId } = ctx.req.valid("param");
    const { changes } = ctx.req.valid("json");

    const conversation = await ConversationResource.fetchById(auth, cId);
    if (!conversation) {
      return apiErrorForConversation(
        ctx,
        new ConversationError("conversation_not_found")
      );
    }

    const sharing = await updateConversationSharing(
      auth,
      conversation,
      changes
    );
    if (sharing.isErr()) {
      return apiErrorForSharing(ctx, sharing.error);
    }

    // The caller can't read the conversation anymore, e.g. they removed their own access.
    if (!sharing.value) {
      return ctx.body(null, 204);
    }

    return ctx.json({ sharing: sharing.value });
  }
);

export default app;
