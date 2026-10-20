import type { AgentLoopContextProvider } from "@app/temporal/agent_loop/lib/agent_loop_context_provider/types";
import { AgentConfigurationFactory } from "@app/tests/utils/AgentConfigurationFactory";
import { ConversationFactory } from "@app/tests/utils/ConversationFactory";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
import { getAgentLoopRuntimeDataWithAuth } from "@app/types/assistant/agent_run";
import { Ok } from "@app/types/shared/result";

export class InferenceHookRunModelFactory {
  static async create(): Promise<{
    auth: Awaited<ReturnType<typeof createResourceTest>>["authenticator"];
    agentMessage: Awaited<
      ReturnType<typeof ConversationFactory.createAgentMessage>
    >["agentMessage"];
    contextProvider: AgentLoopContextProvider;
  }> {
    const { authenticator: auth, workspace } = await createResourceTest({
      role: "admin",
    });
    const agentConfig = await AgentConfigurationFactory.createTestAgent(auth);
    const conversation = await ConversationFactory.create(auth, {
      agentConfigurationId: agentConfig.sId,
      messagesCreatedAt: [],
    });
    const { messageRow: userMessageRow, userMessage } =
      await ConversationFactory.createUserMessage({
        auth,
        workspace,
        conversation,
        content: "Hello",
      });
    const { agentMessage } = await ConversationFactory.createAgentMessage(
      auth,
      {
        workspace,
        conversation,
        agentConfig,
        parentMessageModelId: userMessageRow.id,
        rank: 1,
      }
    );
    const args = {
      agentMessageId: agentMessage.sId,
      agentMessageVersion: agentMessage.version,
      conversationId: conversation.sId,
      conversationTitle: conversation.title,
      userMessageId: userMessage.sId,
      userMessageVersion: userMessage.version,
      userMessageOrigin: userMessage.context.origin,
    };
    const runtimeData = await getAgentLoopRuntimeDataWithAuth(auth, args);
    if (runtimeData.isErr()) {
      throw runtimeData.error;
    }

    return {
      auth,
      agentMessage,
      contextProvider: {
        runtimeData: runtimeData.value,
        render: async () =>
          new Ok({
            modelConversation: {
              messages: [
                {
                  role: "user",
                  name: "user",
                  content: [{ type: "text", text: "Hello" }],
                },
              ],
            },
            tokensUsed: 1,
            prunedContext: false,
            missingActionCatcherFunctionCallIds: [],
          }),
      },
    };
  }
}
