import type { Authenticator } from "@app/lib/auth";
import type {
  InferenceHookInput,
  InferenceHookCheckpointRef,
} from "@app/lib/inference_hook";
import type { Result } from "@app/types/shared/result";
import { Err } from "@app/types/shared/result";

// TODO(inference-hooks tasks#11318): Load the conversation window persisted for this step and,
// for `after_model_call`, the step contents written by `dustRunId`.
export async function loadInferenceHookInputFromCheckpoint(
  _auth: Authenticator,
  _checkpoint: InferenceHookCheckpointRef
): Promise<Result<InferenceHookInput, Error>> {
  return new Err(
    new Error(
      "Loading inference hook inputs from checkpoints is not implemented."
    )
  );
}
