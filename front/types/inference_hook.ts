export const INFERENCE_HOOK_LIFECYCLE_EVENTS = [
  "before_model_call",
  "after_model_call",
] as const;

export type InferenceHookLifecycleEvent =
  (typeof INFERENCE_HOOK_LIFECYCLE_EVENTS)[number];

export type InferenceHookOnError = "allow" | "deny";

export type InferenceHookProviderIdType = "datadog_ai_guard" | "dust";

export type InferenceHookEnforcement = "monitor" | "block";

type DatadogAIGuardProviderConfig = {
  site: string;
  service: string;
  env: string;
};

type DustProviderConfig = Record<string, never>;

export type InferenceHookProviderConfig =
  | DatadogAIGuardProviderConfig
  | DustProviderConfig;

export type InferenceHookType = {
  sId: string;
  name: string;
  provider: InferenceHookProviderIdType;
  version: number;
  events: InferenceHookLifecycleEvent[];
  enforcement: InferenceHookEnforcement | null;
  onError: InferenceHookOnError;
  timeoutMs: number;
  excludedGroupIds: string[];
};
