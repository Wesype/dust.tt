import type {
  InferenceHook,
  InferenceHookInput,
  InferenceHookProvider,
  InferenceHookVerdict,
} from "@app/lib/inference_hook";
import type { InferenceHookPlan } from "@app/lib/inference_hook/resolve";
import type {
  InferenceHookEnforcement,
  InferenceHookOnError,
} from "@app/types/inference_hook";

export interface FakeInferenceHookProvider extends InferenceHookProvider {
  readonly inputs: InferenceHookInput[];
  readonly signals: AbortSignal[];
}

function createFakeInferenceHookProvider(
  evaluate: (
    input: InferenceHookInput,
    options: { signal: AbortSignal }
  ) => Promise<InferenceHookVerdict>
): FakeInferenceHookProvider {
  const inputs: InferenceHookInput[] = [];
  const signals: AbortSignal[] = [];

  return {
    inputs,
    signals,
    async evaluate(input, options) {
      inputs.push(input);
      signals.push(options.signal);
      return evaluate(input, options);
    },
  };
}

export class InferenceHookProviderFactory {
  static custom(
    evaluate: (
      input: InferenceHookInput,
      options: { signal: AbortSignal }
    ) => Promise<InferenceHookVerdict>
  ): FakeInferenceHookProvider {
    return createFakeInferenceHookProvider(evaluate);
  }

  static allow(): FakeInferenceHookProvider {
    return createFakeInferenceHookProvider(async () => ({ action: "allow" }));
  }

  static deny(
    reason = "Denied by the fake inference hook provider"
  ): FakeInferenceHookProvider {
    return createFakeInferenceHookProvider(async () => ({
      action: "deny",
      reason,
    }));
  }

  static slow({
    delayMs,
    verdict = { action: "allow" },
  }: {
    delayMs: number;
    verdict?: InferenceHookVerdict;
  }): FakeInferenceHookProvider {
    return createFakeInferenceHookProvider(
      (_input, { signal }) =>
        new Promise((resolve, reject) => {
          const onAbort = () => {
            clearTimeout(timer);
            reject(new Error("Fake inference hook provider aborted"));
          };
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve(verdict);
          }, delayMs);

          signal.addEventListener("abort", onAbort, { once: true });
        })
    );
  }

  // Ignores its abort signal and never settles, like a faulty provider adapter.
  static hanging(): FakeInferenceHookProvider {
    return createFakeInferenceHookProvider(() => new Promise(() => {}));
  }

  static failing(
    error = new Error("Fake inference hook provider failed")
  ): FakeInferenceHookProvider {
    return createFakeInferenceHookProvider(async () => {
      throw error;
    });
  }

  static hook(
    provider: InferenceHookProvider,
    {
      hookId = "test_hook",
      hookVersion = 1,
      enforcement = "block",
      timeoutMs = 1_000,
      onError = "deny",
    }: {
      hookId?: string;
      hookVersion?: number;
      enforcement?: InferenceHookEnforcement;
      timeoutMs?: number;
      onError?: InferenceHookOnError;
    } = {}
  ): InferenceHook {
    return {
      hookId,
      hookVersion,
      enforcement,
      provider,
      timeoutMs,
      onError,
    };
  }

  // The same hooks at both checkpoints.
  static plan(hooks: InferenceHook[] = []): InferenceHookPlan {
    return {
      before_model_call: hooks,
      after_model_call: hooks,
    };
  }
}
