import {
  makeInferenceHookDeniedError,
  runBlockingInferenceHooks,
} from "@app/lib/inference_hook";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
import { InferenceHookConsumerFactory } from "@app/tests/utils/InferenceHookConsumerFactory";
import { InferenceHookInputFactory } from "@app/tests/utils/InferenceHookInputFactory";
import { describe, expect, it, vi } from "vitest";

const notCancelled = new AbortController().signal;

describe("runBlockingInferenceHooks", () => {
  it("does no hook work when inference hooks are disabled", async () => {
    const { authenticator } = await createResourceTest({ role: "admin" });
    const input =
      await InferenceHookInputFactory.beforeModelCall(authenticator);
    const consumer = InferenceHookConsumerFactory.allow();

    const result = await runBlockingInferenceHooks({
      featureFlags: [],
      hooks: [InferenceHookConsumerFactory.blocking(consumer)],
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

    const result = await runBlockingInferenceHooks({
      featureFlags: ["inference_hooks"],
      hooks: [
        InferenceHookConsumerFactory.blocking(allowConsumer),
        InferenceHookConsumerFactory.blocking(denyConsumer),
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

    const result = await runBlockingInferenceHooks({
      featureFlags: ["inference_hooks"],
      hooks: [
        InferenceHookConsumerFactory.blocking(pending, { timeoutMs: 60_000 }),
        InferenceHookConsumerFactory.blocking(
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

    const run = runBlockingInferenceHooks({
      featureFlags: ["inference_hooks"],
      hooks: [
        InferenceHookConsumerFactory.blocking(first),
        InferenceHookConsumerFactory.blocking(second),
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
      runBlockingInferenceHooks({
        featureFlags: ["inference_hooks"],
        hooks: [
          InferenceHookConsumerFactory.blocking(
            InferenceHookConsumerFactory.failing(),
            { onError: "allow" }
          ),
        ],
        input,
        signal: notCancelled,
      })
    ).resolves.toEqual({ action: "allow" });

    await expect(
      runBlockingInferenceHooks({
        featureFlags: ["inference_hooks"],
        hooks: [
          InferenceHookConsumerFactory.blocking(
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
      runBlockingInferenceHooks({
        featureFlags: ["inference_hooks"],
        hooks: [
          InferenceHookConsumerFactory.blocking(
            InferenceHookConsumerFactory.slow({ delayMs: 100 }),
            { timeoutMs: 1, onError: "allow" }
          ),
        ],
        input,
        signal: notCancelled,
      })
    ).resolves.toEqual({ action: "allow" });

    await expect(
      runBlockingInferenceHooks({
        featureFlags: ["inference_hooks"],
        hooks: [
          InferenceHookConsumerFactory.blocking(
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
      runBlockingInferenceHooks({
        featureFlags: ["inference_hooks"],
        hooks: [
          InferenceHookConsumerFactory.blocking(
            InferenceHookConsumerFactory.hanging(),
            { timeoutMs: 10, onError: "allow" }
          ),
          InferenceHookConsumerFactory.blocking(
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
      runBlockingInferenceHooks({
        featureFlags: ["inference_hooks"],
        hooks: [
          InferenceHookConsumerFactory.blocking(
            InferenceHookConsumerFactory.slow({ delayMs: 50 }),
            { timeoutMs: 10, onError: "deny" }
          ),
          InferenceHookConsumerFactory.blocking(
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
      runBlockingInferenceHooks({
        featureFlags: ["inference_hooks"],
        hooks: [
          InferenceHookConsumerFactory.blocking(
            InferenceHookConsumerFactory.hanging(),
            { timeoutMs: 10, onError: "allow" }
          ),
        ],
        input,
        signal: notCancelled,
      })
    ).resolves.toEqual({ action: "allow" });

    await expect(
      runBlockingInferenceHooks({
        featureFlags: ["inference_hooks"],
        hooks: [
          InferenceHookConsumerFactory.blocking(
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

    const result = await runBlockingInferenceHooks({
      featureFlags: ["inference_hooks"],
      hooks: [
        ...Array.from({ length: 8 }, () =>
          InferenceHookConsumerFactory.blocking(
            InferenceHookConsumerFactory.hanging(),
            { timeoutMs: 20, onError: "allow" }
          )
        ),
        InferenceHookConsumerFactory.blocking(queued, {
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

    const result = await runBlockingInferenceHooks({
      featureFlags: ["inference_hooks"],
      hooks: [InferenceHookConsumerFactory.blocking(consumer)],
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

    const result = await runBlockingInferenceHooks({
      featureFlags: ["inference_hooks"],
      hooks: [
        InferenceHookConsumerFactory.blocking(consumer, { timeoutMs: 60_000 }),
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
