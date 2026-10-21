import type { InferenceHook } from "@app/lib/inference_hook";

// TODO(inference-hooks tasks#11317): Resolve hooks from persisted policies instead of code.
const INFERENCE_HOOKS: Record<string, InferenceHook> = {};

export function getInferenceHook(hookId: string): InferenceHook | null {
  return INFERENCE_HOOKS[hookId] ?? null;
}
