import type { InputConfig } from "@app/lib/model_constructors/types/input/configuration";
import type { WhitelistableFeature } from "@app/types/shared/feature_flags";

export function withAnthropicServerSideFallback(
  config: InputConfig,
  featureFlags: WhitelistableFeature[]
): InputConfig {
  if (!featureFlags.includes("anthropic_server_side_fallback")) {
    return config;
  }

  return { ...config, serverSideFallback: true };
}
