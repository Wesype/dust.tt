import type { AuthenticatorType } from "@app/lib/auth";
import { Authenticator } from "@app/lib/auth";
import type {
  InferenceHookExecutionRef,
  InferenceHookVerdict,
} from "@app/lib/inference_hook";
import { evaluateInferenceHookAtCheckpoint } from "@app/lib/inference_hook/checkpoint_evaluation";
import logger from "@app/logger/logger";

// TODO(inference-hooks tasks#11315): Record verdicts and errors in inference_hook_executions.
export async function evaluateInferenceHookActivity(
  authType: AuthenticatorType,
  execution: InferenceHookExecutionRef
): Promise<InferenceHookVerdict> {
  const auth = await Authenticator.fromJSON(authType);

  const result = await evaluateInferenceHookAtCheckpoint(auth, execution);
  if (result.isErr()) {
    throw result.error;
  }

  logger.info(
    {
      hookId: execution.hookId,
      ...execution.checkpoint,
      verdict: result.value,
    },
    "Inference hook workflow evaluated"
  );
  return result.value;
}
