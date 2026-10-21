import {
  makeInferenceHookDeniedError,
  runInferenceHooks,
} from "@app/lib/inference_hook";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
import { InferenceHookConsumerFactory } from "@app/tests/utils/InferenceHookConsumerFactory";
import { InferenceHookInputFactory } from "@app/tests/utils/InferenceHookInputFactory";
import { describe, expect, it, vi } from "vitest";

const notCancelled = new AbortController().signal;

describe("runInferenceHooks", () => {
  it("does no hook work when inference hooks are disabled", async () => {
    const { authenticator } = await createResourceTest({ role: "admin" });
    const input =
      await InferenceHookInputFactory.beforeModelCall(authenticator);
    const consumer = InferenceHookConsumerFactory.allow();

    const result = await runInferenceHooks({
      featureFlags: [],
      hooks: [InferenceHookConsumerFactory.enforced(consumer)],
      input,
      signal: notCancelled,
    });

    expect(result).toEqual({ action: "allow" });
    expect(consumer.inputs).toHaveLength(0);
  });

  it("returns an explicit denial from any consumer", async () => {
    const { authenticator } = await createResourceTest({ role: "admin" });
    const input = await InferenceHookInputFactory.afterModelCall(authenticator);
    const allowConsumer = InferenceHookConsumerFactory.allow();
    const denyConsumer = InferenceHookConsumerFactory.deny("Policy denied");

    const result = await runInferenceHooks({
      featureFlags: ["inference_hooks"],
      hooks: [
        InferenceHookConsumerFactory.enforced(allowConsumer),
        InferenceHookConsumerFactory.enforced(denyConsumer),
      ],
      input,
      signal: notCancelled,
    });

    expect(result).toEqual({ action: "deny", reason: "Policy denied" });
    expect(allowConsumer.inputs).toEqual([input]);
    expect(denyConsumer.inputs).toEqual([input]);
  });

  it("returns a denial without waiting for the other consumers", async () => {
    const { authenticator } = await createResourceTest({ role: "admin" });
    const input =
      await InferenceHookInputFactory.beforeModelCall(authenticator);
    const pending = InferenceHookConsumerFactory.slow({ delayMs: 60_000 });

    const result = await runInferenceHooks({
      featureFlags: ["inference_hooks"],
      hooks: [
        InferenceHookConsumerFactory.enforced(pending, { timeoutMs: 60_000 }),
        InferenceHookConsumerFactory.enforced(
          InferenceHookConsumerFactory.deny("Policy denied")
        ),
      ],
      input,
      signal: notCancelled,
    });

    expect(result).toEqual({ action: "deny", reason: "Policy denied" });
    expect(pending.signals[0].aborted).toBe(true);
  });

  it("starts all consumers concurrently", async () => {
    const { authenticator } = await createResourceTest({ role: "admin" });
    const input =
      await InferenceHookInputFactory.beforeModelCall(authenticator);
    let releaseConsumers = () => {};
    const waitForRelease = new Promise<void>((resolve) => {
      releaseConsumers = resolve;
    });
    const first = InferenceHookConsumerFactory.custom(async () => {
      await waitForRelease;
      return { action: "allow" };
    });
    const second = InferenceHookConsumerFactory.custom(async () => {
      await waitForRelease;
      return { action: "allow" };
    });

    const run = runInferenceHooks({
      featureFlags: ["inference_hooks"],
      hooks: [
        InferenceHookConsumerFactory.enforced(first),
        InferenceHookConsumerFactory.enforced(second),
      ],
      input,
      signal: notCancelled,
    });

    await vi.waitFor(() => {
      expect(first.inputs).toEqual([input]);
      expect(second.inputs).toEqual([input]);
    });
    releaseConsumers();

    await expect(run).resolves.toEqual({ action: "allow" });
  });

  it("applies each consumer's onError policy to provider failures", async () => {
    const { authenticator } = await createResourceTest({ role: "admin" });
    const input =
      await InferenceHookInputFactory.beforeModelCall(authenticator);

    await expect(
      runInferenceHooks({
        featureFlags: ["inference_hooks"],
        hooks: [
          InferenceHookConsumerFactory.enforced(
            InferenceHookConsumerFactory.failing(),
            { onError: "allow" }
          ),
        ],
        input,
        signal: notCancelled,
      })
    ).resolves.toEqual({ action: "allow" });

    await expect(
      runInferenceHooks({
        featureFlags: ["inference_hooks"],
        hooks: [
          InferenceHookConsumerFactory.enforced(
            InferenceHookConsumerFactory.failing(),
            { onError: "deny" }
          ),
        ],
        input,
        signal: notCancelled,
      })
    ).resolves.toEqual({
      action: "deny",
      reason: "Inference hook evaluation failed",
    });
  });

  it("applies each consumer's onError policy when it times out", async () => {
    const { authenticator } = await createResourceTest({ role: "admin" });
    const input =
      await InferenceHookInputFactory.beforeModelCall(authenticator);

    await expect(
      runInferenceHooks({
        featureFlags: ["inference_hooks"],
        hooks: [
          InferenceHookConsumerFactory.enforced(
            InferenceHookConsumerFactory.slow({ delayMs: 100 }),
            { timeoutMs: 1, onError: "allow" }
          ),
        ],
        input,
        signal: notCancelled,
      })
    ).resolves.toEqual({ action: "allow" });

    await expect(
      runInferenceHooks({
        featureFlags: ["inference_hooks"],
        hooks: [
          InferenceHookConsumerFactory.enforced(
            InferenceHookConsumerFactory.slow({ delayMs: 100 }),
            { timeoutMs: 1, onError: "deny" }
          ),
        ],
        input,
        signal: notCancelled,
      })
    ).resolves.toEqual({
      action: "deny",
      reason: "Inference hook evaluation failed",
    });
  });

  it("respects each consumer's own timeoutMs", async () => {
    const { authenticator } = await createResourceTest({ role: "admin" });
    const input =
      await InferenceHookInputFactory.beforeModelCall(authenticator);

    await expect(
      runInferenceHooks({
        featureFlags: ["inference_hooks"],
        hooks: [
          InferenceHookConsumerFactory.enforced(
            InferenceHookConsumerFactory.hanging(),
            { timeoutMs: 10, onError: "allow" }
          ),
          InferenceHookConsumerFactory.enforced(
            InferenceHookConsumerFactory.slow({
              delayMs: 50,
              verdict: { action: "deny", reason: "Long hook denied" },
            }),
            { timeoutMs: 500, onError: "allow" }
          ),
        ],
        input,
        signal: notCancelled,
      })
    ).resolves.toEqual({ action: "deny", reason: "Long hook denied" });

    await expect(
      runInferenceHooks({
        featureFlags: ["inference_hooks"],
        hooks: [
          InferenceHookConsumerFactory.enforced(
            InferenceHookConsumerFactory.slow({ delayMs: 50 }),
            { timeoutMs: 10, onError: "deny" }
          ),
          InferenceHookConsumerFactory.enforced(
            InferenceHookConsumerFactory.allow(),
            { timeoutMs: 500, onError: "allow" }
          ),
        ],
        input,
        signal: notCancelled,
      })
    ).resolves.toEqual({
      action: "deny",
      reason: "Inference hook evaluation failed",
    });
  });

  it("stops waiting at the timeout for a consumer that ignores its signal", async () => {
    const { authenticator } = await createResourceTest({ role: "admin" });
    const input =
      await InferenceHookInputFactory.beforeModelCall(authenticator);

    await expect(
      runInferenceHooks({
        featureFlags: ["inference_hooks"],
        hooks: [
          InferenceHookConsumerFactory.enforced(
            InferenceHookConsumerFactory.hanging(),
            { timeoutMs: 10, onError: "allow" }
          ),
        ],
        input,
        signal: notCancelled,
      })
    ).resolves.toEqual({ action: "allow" });

    await expect(
      runInferenceHooks({
        featureFlags: ["inference_hooks"],
        hooks: [
          InferenceHookConsumerFactory.enforced(
            InferenceHookConsumerFactory.hanging(),
            { timeoutMs: 10, onError: "deny" }
          ),
        ],
        input,
        signal: notCancelled,
      })
    ).resolves.toEqual({
      action: "deny",
      reason: "Inference hook evaluation failed",
    });
  });

  it("does not start a queued consumer whose timeout has passed", async () => {
    const { authenticator } = await createResourceTest({ role: "admin" });
    const input =
      await InferenceHookInputFactory.beforeModelCall(authenticator);
    const queued = InferenceHookConsumerFactory.allow();

    const result = await runInferenceHooks({
      featureFlags: ["inference_hooks"],
      hooks: [
        ...Array.from({ length: 8 }, () =>
          InferenceHookConsumerFactory.enforced(
            InferenceHookConsumerFactory.hanging(),
            { timeoutMs: 20, onError: "allow" }
          )
        ),
        InferenceHookConsumerFactory.enforced(queued, {
          timeoutMs: 5,
          onError: "deny",
        }),
      ],
      input,
      signal: notCancelled,
    });

    expect(result).toEqual({
      action: "deny",
      reason: "Inference hook evaluation failed",
    });
    expect(queued.inputs).toHaveLength(0);
  });

  it("returns cancelled without evaluating when already cancelled", async () => {
    const { authenticator } = await createResourceTest({ role: "admin" });
    const input =
      await InferenceHookInputFactory.beforeModelCall(authenticator);
    const consumer = InferenceHookConsumerFactory.deny();
    const controller = new AbortController();
    controller.abort();

    const result = await runInferenceHooks({
      featureFlags: ["inference_hooks"],
      hooks: [InferenceHookConsumerFactory.enforced(consumer)],
      input,
      signal: controller.signal,
    });

    expect(result).toEqual({ action: "cancelled" });
    expect(consumer.inputs).toHaveLength(0);
  });

  it("aborts consumers and returns cancelled when cancelled during evaluation", async () => {
    const { authenticator } = await createResourceTest({ role: "admin" });
    const input = await InferenceHookInputFactory.afterModelCall(authenticator);
    const consumer = InferenceHookConsumerFactory.slow({
      delayMs: 60_000,
      verdict: { action: "deny", reason: "Blocked by policy" },
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);

    const result = await runInferenceHooks({
      featureFlags: ["inference_hooks"],
      hooks: [
        InferenceHookConsumerFactory.enforced(consumer, { timeoutMs: 60_000 }),
      ],
      input,
      signal: controller.signal,
    });

    expect(result).toEqual({ action: "cancelled" });
    expect(consumer.signals[0].aborted).toBe(true);
  });
});

describe("makeInferenceHookDeniedError", () => {
  it("builds a hook-blocked error tagged with the lifecycle event", () => {
    expect(
      makeInferenceHookDeniedError("after_model_call", {
        action: "deny",
        reason: "Blocked by policy",
      })
    ).toEqual({
      code: "inference_hook_denied",
      message: "Blocked by policy",
      metadata: {
        category: "hook_blocked",
        lifecycleEvent: "after_model_call",
      },
    });
  });
});
