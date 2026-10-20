import type { Authenticator } from "@app/lib/auth";
import type {
  AfterModelCallHookInput,
  BeforeModelCallHookInput,
} from "@app/lib/inference_hook";
import { AgentConfigurationFactory } from "@app/tests/utils/AgentConfigurationFactory";

export class InferenceHookInputFactory {
  static async beforeModelCall(
    auth: Authenticator
  ): Promise<BeforeModelCallHookInput> {
    const fullAgentConfiguration =
      await AgentConfigurationFactory.createTestAgent(auth);
    const { model: _model, ...agentConfiguration } = fullAgentConfiguration;

    return {
      lifecycleEvent: "before_model_call",
      agentConfiguration,
      conversationWindow: { messages: [] },
      workspaceId: auth.getNonNullableWorkspace().sId,
      conversationId: "conversation-id",
      agentMessageId: "agent-message-id",
      agentMessageVersion: 0,
      step: 0,
    };
  }

  static async afterModelCall(
    auth: Authenticator
  ): Promise<AfterModelCallHookInput> {
    const fullAgentConfiguration =
      await AgentConfigurationFactory.createTestAgent(auth);
    const { model: _model, ...agentConfiguration } = fullAgentConfiguration;

    return {
      lifecycleEvent: "after_model_call",
      agentConfiguration,
      conversationWindow: { messages: [] },
      workspaceId: auth.getNonNullableWorkspace().sId,
      conversationId: "conversation-id",
      agentMessageId: "agent-message-id",
      agentMessageVersion: 0,
      step: 0,
      modelOutput: {
        actions: [],
        generation: null,
        contents: [],
      },
      dustRunId: "dust-run-id",
    };
  }
}
