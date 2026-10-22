import { createHash } from "node:crypto";
import type { InferenceHookCheckpointRef } from "@app/lib/inference_hook";

/**
 * @cc [owner:frankaloia,label:concurrency;product] inference-hook-workflow-id
 * The workflow ID MUST be a deterministic function of the hook ID and every checkpoint field, so
 * repeated starts for one checkpoint resolve to a single execution and distinct checkpoints never
 * share one. It MUST NOT depend on the hook version, so a step retried after a hook edit does not
 * evaluate the same checkpoint twice.
 */
export function makeInferenceHookWorkflowId({
  hookId,
  checkpoint,
}: {
  hookId: string;
  checkpoint: InferenceHookCheckpointRef;
}): string {
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        hookId,
        checkpoint.workspaceId,
        checkpoint.conversationId,
        checkpoint.agentMessageId,
        checkpoint.agentMessageVersion,
        checkpoint.step,
        checkpoint.lifecycleEvent,
        checkpoint.lifecycleEvent === "after_model_call"
          ? checkpoint.dustRunId
          : null,
      ])
    )
    .digest("hex");
  return `inference-hook-${checkpoint.workspaceId}-${hash}`;
}
