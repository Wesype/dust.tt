import { getConversation } from "@app/lib/api/assistant/conversation/fetch";
import { isLLMTraceId } from "@app/lib/api/llm/traces/buffer";
import type { Authenticator } from "@app/lib/auth";
import { AgentMessageModel } from "@app/lib/models/agent/conversation";
import { ConversationResource } from "@app/lib/resources/conversation_resource";
import { KeyResource } from "@app/lib/resources/key_resource";
import type { ConversationError } from "@app/types/assistant/conversation";
import type {
  PokeAgentMessageType,
  PokeConversationType,
} from "@app/types/poke";
import type { ModelId } from "@app/types/shared/model_id";
import type { Result } from "@app/types/shared/result";
import { Ok } from "@app/types/shared/result";

export async function getPokeConversation(
  auth: Authenticator,
  conversationId: string,
  includeDeleted?: boolean
): Promise<Result<PokeConversationType, ConversationError>> {
  const owner = auth.getNonNullableWorkspace();
  // oxlint-disable-next-line dust/noExpensiveConversationFetch -- intentional full conversation load
  const conversation = await getConversation(
    auth,
    conversationId,
    includeDeleted
  );

  // Enrich the returned conversation with the apps runs linked to the agent messages
  // Decided to do it as a separate step because I didn't want to modify the getConversation to make it more complex based on the use case
  // and I still wanted to use the existing getConversation code for rendering.
  if (conversation.isOk()) {
    const pokeConversation = conversation.value as PokeConversationType;

    const agentMessages = pokeConversation.content
      .flat()
      .filter((m): m is PokeAgentMessageType => m.type === "agent_message");

    const agentMessagesWithRunIds = await AgentMessageModel.findAll({
      where: {
        id: [...new Set(agentMessages.map((m) => m.agentMessageId))],
        workspaceId: owner.id,
      },
      attributes: ["id", "runIds"],
    });
    const runIdsByAgentMessageId = new Map(
      agentMessagesWithRunIds.map((m) => [m.id, m.runIds])
    );

    const conversationResource = await ConversationResource.fetchById(
      auth,
      conversationId,
      { includeDeleted }
    );
    const apiKeyModelIdsByMessageModelId = conversationResource
      ? await conversationResource.getApiKeyModelIdsByMessageModelId(auth)
      : new Map<ModelId, ModelId>();
    const apiKeys = await KeyResource.fetchByWorkspaceAndModelIds({
      workspace: owner,
      modelIds: [...new Set(apiKeyModelIdsByMessageModelId.values())],
    });
    const apiKeysByModelId = new Map(
      apiKeys.map((key) => [key.id, key.toPokeJSON()])
    );

    // Cycle through the messages and actions and enrich them with runId(s) and timestamps.
    for (const messages of pokeConversation.content) {
      for (const m of messages) {
        if (m.type === "user_message") {
          const apiKeyModelId = apiKeyModelIdsByMessageModelId.get(m.id);
          m.apiKey = apiKeyModelId
            ? (apiKeysByModelId.get(apiKeyModelId) ?? null)
            : null;
        }

        if (m.type === "agent_message") {
          const runIds = runIdsByAgentMessageId.get(m.agentMessageId) ?? null;

          m.runIds = runIds;

          // Generate URLs for runIds.
          if (runIds) {
            m.runUrls = runIds.map((runId) => {
              const isLLM = isLLMTraceId(runId);
              const url = `/poke/${owner.sId}/llm-traces/${runId}`;
              return { runId, url, isLLM };
            });
          }

          if (m.actions.length > 0) {
            for (const a of m.actions) {
              a.mcpIO = {
                params: a.params,
                output: a.output,
                generatedFiles: a.generatedFiles,
                isError: a.status === "errored",
              };
              a.created = a.createdAt;
            }
          }
        }
      }
    }
    return new Ok(pokeConversation);
  }

  return conversation;
}
