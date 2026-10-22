import type { Authenticator } from "@app/lib/auth";
import type {
  InferenceHookExecutionRef,
  InferenceHookVerdict,
} from "@app/lib/inference_hook";
import { evaluateInferenceHooks } from "@app/lib/inference_hook";
import { loadInferenceHookInputFromCheckpoint } from "@app/lib/inference_hook/checkpoint_input";
import { loadInferenceHook } from "@app/lib/inference_hook/resolve";
import type { Result } from "@app/types/shared/result";
import { Ok } from "@app/types/shared/result";

/**
 * @cc [owner:frankaloia,label:product] inference-hook-evaluates-checkpoint
 * A monitor hook MUST evaluate the input loaded for `checkpoint` with the hook version it was
 * launched with, using the same timeout and `onError` behavior as a block hook.
 */
export async function evaluateInferenceHookAtCheckpoint(
  auth: Authenticator,
  { hookId, hookVersion, checkpoint }: InferenceHookExecutionRef
): Promise<Result<InferenceHookVerdict, Error>> {
  const hookRes = await loadInferenceHook(auth, { hookId, hookVersion });
  if (hookRes.isErr()) {
    return hookRes;
  }

  const inputRes = await loadInferenceHookInputFromCheckpoint(auth, checkpoint);
  if (inputRes.isErr()) {
    return inputRes;
  }

  return new Ok(
    await evaluateInferenceHooks(
      [hookRes.value],
      inputRes.value,
      new AbortController().signal
    )
  );
}
