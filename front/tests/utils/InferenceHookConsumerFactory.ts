import type {
  BlockingInferenceHook,
  InferenceHookConsumer,
  InferenceHookInput,
  InferenceHookOnError,
  InferenceHookVerdict,
} from "@app/lib/inference_hook";

export interface FakeInferenceHookConsumer extends InferenceHookConsumer {
  readonly inputs: InferenceHookInput[];
  readonly signals: AbortSignal[];
}

function createFakeInferenceHookConsumer(
  evaluate: (
    input: InferenceHookInput,
    options: { signal: AbortSignal }
  ) => Promise<InferenceHookVerdict>
): FakeInferenceHookConsumer {
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

export class InferenceHookConsumerFactory {
  static custom(
    evaluate: (
      input: InferenceHookInput,
      options: { signal: AbortSignal }
    ) => Promise<InferenceHookVerdict>
  ): FakeInferenceHookConsumer {
    return createFakeInferenceHookConsumer(evaluate);
  }

  static allow(): FakeInferenceHookConsumer {
    return createFakeInferenceHookConsumer(async () => ({ action: "allow" }));
  }

  static deny(
    reason = "Denied by the fake inference hook consumer"
  ): FakeInferenceHookConsumer {
    return createFakeInferenceHookConsumer(async () => ({
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
  }): FakeInferenceHookConsumer {
    return createFakeInferenceHookConsumer(
      (_input, { signal }) =>
        new Promise((resolve, reject) => {
          const onAbort = () => {
            clearTimeout(timer);
            reject(new Error("Fake inference hook consumer aborted"));
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
  static hanging(): FakeInferenceHookConsumer {
    return createFakeInferenceHookConsumer(() => new Promise(() => {}));
  }

  static failing(
    error = new Error("Fake inference hook consumer failed")
  ): FakeInferenceHookConsumer {
    return createFakeInferenceHookConsumer(async () => {
      throw error;
    });
  }

  static blocking(
    consumer: InferenceHookConsumer,
    {
      timeoutMs = 1_000,
      onError = "deny",
    }: {
      timeoutMs?: number;
      onError?: InferenceHookOnError;
    } = {}
  ): BlockingInferenceHook {
    return { consumer, timeoutMs, onError };
  }
}
