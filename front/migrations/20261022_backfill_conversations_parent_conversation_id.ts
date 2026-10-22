import {
  ConversationModel,
  MessageModel,
  UserMessageModel,
} from "@app/lib/models/agent/conversation";
import type { Logger } from "@app/logger/logger";
import { makeScript } from "@app/scripts/helpers";
import { runOnAllWorkspaces } from "@app/scripts/workspace_helpers";
import type { LightWorkspaceType } from "@app/types/user";
import { Op } from "sequelize";

const BATCH_SIZE = 1000;

/**
 * Sets `conversations.parentConversationId` on the sub-conversations of `workspace` (`depth > 0`) created before the
 * column was written: the parent is the conversation of the agent message that the
 * sub-conversation's first `run_agent` user message originates from. Sub-conversations without such
 * a message, or whose origin message no longer exists, are left with no parent. Only rows without a
 * parent are updated, so the script can be re-run safely.
 */
export async function backfillWorkspaceConversationsParentConversationId(
  workspace: LightWorkspaceType,
  { execute, logger }: { execute: boolean; logger: Logger }
): Promise<void> {
  let lastId = 0;
  let scanned = 0;
  let backfilled = 0;

  for (;;) {
    const subConversations = await ConversationModel.findAll({
      attributes: ["id"],
      where: {
        workspaceId: workspace.id,
        id: { [Op.gt]: lastId },
        depth: { [Op.gt]: 0 },
        parentConversationId: { [Op.is]: null },
      },
      order: [["id", "ASC"]],
      limit: BATCH_SIZE,
    });
    if (subConversations.length === 0) {
      break;
    }
    lastId = subConversations[subConversations.length - 1].id;
    scanned += subConversations.length;

    const runAgentMessages = await MessageModel.findAll({
      attributes: ["conversationId"],
      where: {
        workspaceId: workspace.id,
        conversationId: subConversations.map((c) => c.id),
      },
      include: [
        {
          model: UserMessageModel,
          as: "userMessage",
          required: true,
          attributes: ["agenticOriginMessageId"],
          where: {
            agenticMessageType: "run_agent",
            agenticOriginMessageId: { [Op.ne]: null },
          },
        },
      ],
      order: [["rank", "ASC"]],
    });
    // The first `run_agent` message of each sub-conversation.
    const originIdByConversationModelId = new Map<number, string>();
    for (const message of runAgentMessages) {
      const originId = message.userMessage?.agenticOriginMessageId;
      if (
        originId &&
        !originIdByConversationModelId.has(message.conversationId)
      ) {
        originIdByConversationModelId.set(message.conversationId, originId);
      }
    }

    const originMessages = await MessageModel.findAll({
      attributes: ["sId", "conversationId"],
      where: {
        workspaceId: workspace.id,
        sId: [...new Set(originIdByConversationModelId.values())],
      },
    });
    const conversationModelIdByOriginId = new Map(
      originMessages.map((m) => [m.sId, m.conversationId])
    );

    const childModelIdsByParentModelId = new Map<number, number[]>();
    for (const [
      childConversationModelId,
      originId,
    ] of originIdByConversationModelId) {
      const parentConversationModelId =
        conversationModelIdByOriginId.get(originId);
      if (
        parentConversationModelId === undefined ||
        parentConversationModelId === childConversationModelId
      ) {
        continue;
      }
      const childConversationModelIds =
        childModelIdsByParentModelId.get(parentConversationModelId) ?? [];
      childConversationModelIds.push(childConversationModelId);
      childModelIdsByParentModelId.set(
        parentConversationModelId,
        childConversationModelIds
      );
    }

    // One update per parent: the sub-conversations of a batch mostly share a few parents.
    for (const [
      parentConversationModelId,
      childConversationModelIds,
    ] of childModelIdsByParentModelId) {
      if (execute) {
        await ConversationModel.update(
          { parentConversationId: parentConversationModelId },
          {
            where: {
              workspaceId: workspace.id,
              id: childConversationModelIds,
              parentConversationId: { [Op.is]: null },
            },
          }
        );
      }
      backfilled += childConversationModelIds.length;
    }
  }

  logger.info(
    { workspaceId: workspace.sId, scanned, backfilled, execute },
    execute
      ? "Backfilled sub-conversations parent."
      : "Dry run: would backfill sub-conversations parent."
  );
}

if (
  process.argv[1]?.endsWith(
    "20261022_backfill_conversations_parent_conversation_id.ts"
  )
) {
  makeScript(
    {
      wId: { type: "string", required: false },
      fromWorkspaceId: { type: "number", required: false },
    },
    async ({ wId, fromWorkspaceId, execute }, logger) => {
      await runOnAllWorkspaces(
        (workspace) =>
          backfillWorkspaceConversationsParentConversationId(workspace, {
            execute,
            logger,
          }),
        { concurrency: 4, wId, fromWorkspaceId }
      );
    }
  );
}
