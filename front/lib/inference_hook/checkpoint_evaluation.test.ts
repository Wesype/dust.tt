import type { InferenceHookCheckpointRef } from "@app/lib/inference_hook";
import { evaluateInferenceHookAtCheckpoint } from "@app/lib/inference_hook/checkpoint_evaluation";
import { loadInferenceHookInputFromCheckpoint } from "@app/lib/inference_hook/checkpoint_input";
import { loadInferenceHook } from "@app/lib/inference_hook/resolve";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
import { InferenceHookInputFactory } from "@app/tests/utils/InferenceHookInputFactory";
import { InferenceHookProviderFactory } from "@app/tests/utils/InferenceHookProviderFactory";
import { Err, Ok } from "@app/types/shared/result";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@app/lib/inference_hook/resolve", () => ({
  loadInferenceHook: vi.fn(),
}));

vi.mock("@app/lib/inference_hook/checkpoint_input", () => ({
  loadInferenceHookInputFromCheckpoint: vi.fn(),
}));

const checkpoint: InferenceHookCheckpointRef = {
  lifecycleEvent: "after_model_call",
  workspaceId: "w1",
  conversationId: "c1",
  agentMessageId: "m1",
  agentMessageVersion: 0,
  step: 0,
  dustRunId: "run_1",
};

describe("evaluateInferenceHookAtCheckpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("evaluates the input loaded for the checkpoint", async () => {
    const { authenticator: auth } = await createResourceTest({ role: "admin" });
    const input = await InferenceHookInputFactory.afterModelCall(auth);
    const provider = InferenceHookProviderFactory.deny("Flagged");
    vi.mocked(loadInferenceHook).mockResolvedValue(
      new Ok(
        InferenceHookProviderFactory.hook(provider, {
          enforcement: "monitor",
        })
      )
    );
    vi.mocked(loadInferenceHookInputFromCheckpoint).mockResolvedValue(
      new Ok(input)
    );

    const result = await evaluateInferenceHookAtCheckpoint(auth, {
      hookId: "hook_a",
      hookVersion: 1,
      checkpoint,
    });

    expect(loadInferenceHookInputFromCheckpoint).toHaveBeenCalledWith(
      auth,
      checkpoint
    );
    expect(provider.inputs).toEqual([input]);
    expect(result.isOk() && result.value).toEqual({
      action: "deny",
      reason: "Flagged",
    });
  });

  it("applies onError when the provider exceeds its timeout", async () => {
    const { authenticator: auth } = await createResourceTest({ role: "admin" });
    vi.mocked(loadInferenceHook).mockResolvedValue(
      new Ok(
        InferenceHookProviderFactory.hook(
          InferenceHookProviderFactory.hanging(),
          { enforcement: "monitor", timeoutMs: 10 }
        )
      )
    );
    vi.mocked(loadInferenceHookInputFromCheckpoint).mockResolvedValue(
      new Ok(await InferenceHookInputFactory.afterModelCall(auth))
    );

    const result = await evaluateInferenceHookAtCheckpoint(auth, {
      hookId: "hook_a",
      hookVersion: 1,
      checkpoint,
    });

    expect(result.isOk() && result.value).toEqual({
      action: "deny",
      reason: "Inference hook evaluation failed",
    });
  });

  it("returns an error without evaluating when the input cannot be loaded", async () => {
    const { authenticator: auth } = await createResourceTest({ role: "admin" });
    const provider = InferenceHookProviderFactory.allow();
    vi.mocked(loadInferenceHook).mockResolvedValue(
      new Ok(
        InferenceHookProviderFactory.hook(provider, {
          enforcement: "monitor",
        })
      )
    );
    vi.mocked(loadInferenceHookInputFromCheckpoint).mockResolvedValue(
      new Err(new Error("Checkpoint not found"))
    );

    const result = await evaluateInferenceHookAtCheckpoint(auth, {
      hookId: "hook_a",
      hookVersion: 1,
      checkpoint,
    });

    expect(result.isErr()).toBe(true);
    expect(provider.inputs).toEqual([]);
  });

  it("returns an error for an unknown hook", async () => {
    const { authenticator: auth } = await createResourceTest({ role: "admin" });
    vi.mocked(loadInferenceHook).mockResolvedValue(
      new Err(new Error("Unknown inference hook version: missing v1"))
    );

    const result = await evaluateInferenceHookAtCheckpoint(auth, {
      hookId: "missing",
      hookVersion: 1,
      checkpoint,
    });

    expect(result.isErr()).toBe(true);
    expect(loadInferenceHookInputFromCheckpoint).not.toHaveBeenCalled();
  });
});
