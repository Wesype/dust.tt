import type {
  InferenceHookProvider,
  InferenceHookInput,
  InferenceHookVerdict,
} from "@app/lib/inference_hook";
import { isTextContent } from "@app/types/assistant/generation";

// TODO(inference-hooks tasks#11320): Replace the keyword check with the native small-model rubric
// (tasks#11313). The keyword only exists so the hook pipeline can be exercised locally.
const DENIED_KEYWORD = "banana";
const DENIED_KEYWORD_PATTERN = new RegExp(`\\b${DENIED_KEYWORD}\\b`, "i");

// Before the model call it inspects the latest user message, so an old mention in the history
// does not deny every later turn. After the model call it inspects the generated text.
function textsToInspect(input: InferenceHookInput): string[] {
  if (input.lifecycleEvent === "before_model_call") {
    const lastUserMessage = input.conversationWindow.messages.findLast(
      (message) => message.role === "user"
    );
    return (
      lastUserMessage?.content.filter(isTextContent).map((c) => c.text) ?? []
    );
  }

  return input.modelOutput.contents.flatMap((content) =>
    content.type === "text_content" ? [content.value] : []
  );
}

export function makeDustInferenceHookProvider(): InferenceHookProvider {
  return {
    async evaluate(input: InferenceHookInput): Promise<InferenceHookVerdict> {
      const mentionsKeyword = textsToInspect(input).some((text) =>
        DENIED_KEYWORD_PATTERN.test(text)
      );
      if (!mentionsKeyword) {
        return { action: "allow" };
      }

      return {
        action: "deny",
        reason: `The ${input.lifecycleEvent} input mentions "${DENIED_KEYWORD}".`,
      };
    },
  };
}
