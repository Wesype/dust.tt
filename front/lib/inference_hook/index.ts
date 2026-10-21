import type { ConversationWindowCheckpointIdentity } from "@app/lib/api/assistant/conversation_rendering/conversation_window_checkpoint";
import { concurrentExecutor } from "@app/lib/utils/async_utils";
import type { GenericErrorContent } from "@app/types/assistant/agent";
import type { AgentLoopRuntimeData } from "@app/types/assistant/agent_run";
import type {
  ModelConversationTypeMultiActions,
  NormalizedModelOutput,
} from "@app/types/assistant/generation";
import type { WhitelistableFeature } from "@app/types/shared/feature_flags";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";
import { normalizeError } from "@app/types/shared/utils/error_utils";

const INFERENCE_HOOK_CONCURRENCY = 8;

export type InferenceHookDenyVerdict = {
  action: "deny";
  reason: string;
};

export type InferenceHookVerdict =
  | { action: "allow" }
  | InferenceHookDenyVerdict;

export const INFERENCE_HOOK_LIFECYCLE_EVENTS = [
  "before_model_call",
  "after_model_call",
] as const;

export type InferenceHookLifecycleEvent =
  (typeof INFERENCE_HOOK_LIFECYCLE_EVENTS)[number];

type BeforeModelCallCheckpointRef = ConversationWindowCheckpointIdentity & {
  lifecycleEvent: "before_model_call";
};

type AfterModelCallCheckpointRef = ConversationWindowCheckpointIdentity & {
  lifecycleEvent: "after_model_call";
  dustRunId: string;
};

export type InferenceHookCheckpointRef =
  | BeforeModelCallCheckpointRef
  | AfterModelCallCheckpointRef;

export type InferenceHookExecutionRef = {
  hookId: string;
  checkpoint: InferenceHookCheckpointRef;
};

type InferenceHookInputContext = {
  agentConfiguration: AgentLoopRuntimeData["agentConfiguration"];
  conversationWindow: ModelConversationTypeMultiActions;
};

export type BeforeModelCallHookInput = BeforeModelCallCheckpointRef &
  InferenceHookInputContext;

export type AfterModelCallHookInput = AfterModelCallCheckpointRef &
  InferenceHookInputContext & {
    modelOutput: NormalizedModelOutput;
  };

export type InferenceHookInput =
  | BeforeModelCallHookInput
  | AfterModelCallHookInput;

/**
 * @cc [owner:frankaloia,label:concurrency;product] inference-hook-consumer-cancellation
 * Consumers MUST treat `input` as immutable and stop their provider work when `signal` is aborted.
 * They MUST normalize provider decisions to `InferenceHookVerdict`; provider failures MUST reject
 * so the runner can apply the policy's `onError` behavior.
 */
export interface InferenceHookConsumer {
  evaluate(
    input: InferenceHookInput,
    options: { signal: AbortSignal }
  ): Promise<InferenceHookVerdict>;
}

export type InferenceHookOnError = "allow" | "deny";

export type InferenceHook = {
  consumer: InferenceHookConsumer;
  timeoutMs: number;
};

export type EnforcedInferenceHook = InferenceHook & {
  onError: InferenceHookOnError;
};

export type InferenceHookCheckpointResult =
  | InferenceHookVerdict
  | { action: "cancelled" };

/**
 * @cc [owner:frankaloia,label:product;performance] disabled-inference-hooks-have-no-effects
 * When `featureFlags` excludes `inference_hooks` or no hooks are configured, the checkpoint MUST
 * return an `allow` verdict without invoking consumers.
 */
/**
 * @cc [owner:frankaloia,label:concurrency;product] inference-hook-cancellation-wins
 * When hooks are active and `signal` is aborted before evaluation or while consumers run, the
 * checkpoint MUST return `cancelled` instead of a verdict. Its abort MUST abort in-flight consumers,
 * and queued consumers MUST NOT start.
 */
/**
 * @cc [owner:frankaloia,label:product] inference-hook-input-matches-model-step
 * `conversationWindow` MUST be the exact conversation rendered for the model at this step after
 * compaction and token-budget pruning. An `after_model_call` input MUST also contain the complete
 * normalized output from that model call and its matching Dust run ID.
 */
export async function runInferenceHooks({
  featureFlags,
  hooks,
  input,
  signal,
}: {
  featureFlags: readonly WhitelistableFeature[];
  hooks: readonly EnforcedInferenceHook[];
  input: InferenceHookInput;
  signal: AbortSignal;
}): Promise<InferenceHookCheckpointResult> {
  if (!featureFlags.includes("inference_hooks") || hooks.length === 0) {
    return { action: "allow" };
  }

  if (signal.aborted) {
    return { action: "cancelled" };
  }

  const verdict = await evaluateInferenceHooks(hooks, input, signal);

  if (signal.aborted) {
    return { action: "cancelled" };
  }

  return verdict;
}

export function makeInferenceHookDeniedError(
  lifecycleEvent: InferenceHookLifecycleEvent,
  verdict: InferenceHookDenyVerdict
): GenericErrorContent {
  return {
    code: "inference_hook_denied",
    message: verdict.reason,
    metadata: {
      category: "hook_blocked",
      lifecycleEvent,
    },
  };
}

/**
 * @cc [owner:frankaloia,label:product;performance] inference-hook-deadline
 * Consumers MUST run concurrently, up to `INFERENCE_HOOK_CONCURRENCY` at a time.
 * Each consumer's `timeoutMs` timer MUST start when the checkpoint starts, including while it is
 * queued. Once that timer fires, the runner MUST stop waiting for the consumer even if it ignores
 * its signal, and MUST NOT start it if it is still queued. A timeout is an error. An
 * explicit denial ends the evaluation of the other consumers. An explicit denial, or an error from
 * any consumer configured with `onError: "deny"`, MUST deny the checkpoint.
 */
async function evaluateInferenceHooks(
  hooks: readonly EnforcedInferenceHook[],
  input: InferenceHookInput,
  cancellationSignal: AbortSignal
): Promise<InferenceHookVerdict> {
  const denialController = new AbortController();
  const runs = hooks.map((hook) => ({
    hook,
    signal: AbortSignal.any([
      cancellationSignal,
      denialController.signal,
      AbortSignal.timeout(hook.timeoutMs),
    ]),
  }));

  const results = await concurrentExecutor(
    runs,
    async ({ hook, signal }) => {
      const result = await evaluateInferenceHookConsumer(
        hook.consumer,
        input,
        signal
      );
      if (result.isOk() && result.value.action === "deny") {
        denialController.abort();
      }
      return { hook, result };
    },
    { concurrency: INFERENCE_HOOK_CONCURRENCY }
  );

  for (const { result } of results) {
    if (result.isOk() && result.value.action === "deny") {
      return result.value;
    }
  }

  for (const { hook, result } of results) {
    if (hook.onError === "deny" && result.isErr()) {
      return { action: "deny", reason: "Inference hook evaluation failed" };
    }
  }

  return { action: "allow" };
}

export async function evaluateInferenceHookConsumer(
  consumer: InferenceHookConsumer,
  input: InferenceHookInput,
  signal: AbortSignal
): Promise<Result<InferenceHookVerdict, Error>> {
  const getAbortedResult = () => new Err(normalizeError(signal.reason));

  if (signal.aborted) {
    return getAbortedResult();
  }

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<Result<InferenceHookVerdict, Error>>(
    (resolve) => {
      onAbort = () => resolve(getAbortedResult());
      signal.addEventListener("abort", onAbort, { once: true });
    }
  );
  // Catches its own rejection: a consumer settling after the abort must not reject unhandled.
  const evaluation = (async (): Promise<
    Result<InferenceHookVerdict, Error>
  > => {
    try {
      return new Ok(await consumer.evaluate(input, { signal }));
    } catch (error) {
      return new Err(normalizeError(error));
    }
  })();

  try {
    return await Promise.race([evaluation, aborted]);
  } finally {
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}
