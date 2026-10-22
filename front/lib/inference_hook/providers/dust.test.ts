import { makeDustInferenceHookProvider } from "@app/lib/inference_hook/providers/dust";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
import { InferenceHookInputFactory } from "@app/tests/utils/InferenceHookInputFactory";
import { describe, expect, it } from "vitest";

const signal = new AbortController().signal;

function userMessage(text: string) {
  return {
    role: "user" as const,
    name: "user",
    content: [{ type: "text" as const, text }],
  };
}

describe("makeDustInferenceHookProvider", () => {
  it("denies when the latest user message mentions the keyword", async () => {
    const { authenticator } = await createResourceTest({ role: "admin" });
    const input =
      await InferenceHookInputFactory.beforeModelCall(authenticator);
    input.conversationWindow = {
      messages: [userMessage("I would like a Banana please")],
    };

    const verdict = await makeDustInferenceHookProvider().evaluate(input, {
      signal,
    });

    expect(verdict.action).toBe("deny");
  });

  it("ignores a mention in an earlier user message", async () => {
    const { authenticator } = await createResourceTest({ role: "admin" });
    const input =
      await InferenceHookInputFactory.beforeModelCall(authenticator);
    input.conversationWindow = {
      messages: [userMessage("banana"), userMessage("Something else")],
    };

    const verdict = await makeDustInferenceHookProvider().evaluate(input, {
      signal,
    });

    expect(verdict).toEqual({ action: "allow" });
  });

  it("denies when the model output mentions the keyword", async () => {
    const { authenticator } = await createResourceTest({ role: "admin" });
    const input = await InferenceHookInputFactory.afterModelCall(authenticator);
    input.modelOutput = {
      ...input.modelOutput,
      contents: [{ type: "text_content", value: "Here is a banana." }],
    };

    const verdict = await makeDustInferenceHookProvider().evaluate(input, {
      signal,
    });

    expect(verdict.action).toBe("deny");
  });
});
