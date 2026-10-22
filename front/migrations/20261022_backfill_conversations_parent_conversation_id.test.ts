import type { Authenticator } from "@app/lib/auth";
import { MessageModel } from "@app/lib/models/agent/conversation";
import { ConversationResource } from "@app/lib/resources/conversation_resource";
import baseLogger from "@app/logger/logger";
import { backfillWorkspaceConversationsParentConversationId } from "@app/migrations/20261022_backfill_conversations_parent_conversation_id";
import { ConversationFactory } from "@app/tests/utils/ConversationFactory";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
import assert from "node:assert";
import { describe, expect, it } from "vitest";

const logger = baseLogger.child({}, { level: "silent" });

async function fetchParentConversationId(
  auth: Authenticator,
  conversationId: string
) {
  const conversation = await ConversationResource.fetchById(
    auth,
    conversationId
  );
  return conversation?.parentConversationId;
}

describe("backfillWorkspaceConversationsParentConversationId", () => {
  it("sets the parent from the first run_agent message, and only with execute", async () => {
    const { authenticator: auth, workspace } = await createResourceTest({});
    const parent = await ConversationFactory.create(auth, {
      agentConfigurationId: "dust",
      messagesCreatedAt: [new Date()],
    });
    const originMessage = await MessageModel.findOne({
      where: { workspaceId: workspace.id, conversationId: parent.id, rank: 1 },
    });
    assert(originMessage, "Origin agent message not found.");
    const sub = await ConversationFactory.create(auth, {
      agentConfigurationId: "dust",
      messagesCreatedAt: [],
      depth: 1,
    });
    await ConversationFactory.createUserMessage({
      auth,
      workspace,
      conversation: sub,
      content: "sub-agent trigger",
      agenticMessageType: "run_agent",
      agenticOriginMessageId: originMessage.sId,
    });
    // A sub-conversation whose first message is not posted yet has no known parent.
    const orphan = await ConversationFactory.create(auth, {
      agentConfigurationId: "dust",
      messagesCreatedAt: [],
      depth: 1,
    });

    await backfillWorkspaceConversationsParentConversationId(workspace, {
      execute: false,
      logger,
    });
    expect(await fetchParentConversationId(auth, sub.sId)).toBeNull();

    await backfillWorkspaceConversationsParentConversationId(workspace, {
      execute: true,
      logger,
    });
    expect(await fetchParentConversationId(auth, sub.sId)).toBe(parent.id);
    expect(await fetchParentConversationId(auth, orphan.sId)).toBeNull();
    expect(await fetchParentConversationId(auth, parent.sId)).toBeNull();
  });
});
