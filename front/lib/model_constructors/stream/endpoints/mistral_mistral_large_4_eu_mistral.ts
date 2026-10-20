import { WithMistralLarge4Config } from "@app/lib/model_constructors/providers/mistral/models/mistral_large_4";
import { MistralStream } from "@app/lib/model_constructors/stream/clients/mistral";
import type { StreamEndpointConstructor } from "@app/lib/model_constructors/stream/configuration";
import { MISTRAL_LAB } from "@app/lib/model_constructors/types/labs";
import { EUROPE } from "@app/lib/model_constructors/types/regions";

export class MistralMistralLarge4EuropeMistralStream extends WithMistralLarge4Config(
  MistralStream
) {
  // 1.1x list price: https://docs.mistral.ai/inference/regional-inference (2026-09-22).
  static readonly tokenPricing = {
    standardInput: 1.496,
    standardOutput: 4.598,
    cacheHit: 0.154,
  };

  // Inference runs in the EU; the endpoint remains usable from both US and EU.
  static readonly lab = MISTRAL_LAB;

  static readonly region = EUROPE;

  static readonly id = this.buildId();
}

MistralMistralLarge4EuropeMistralStream satisfies StreamEndpointConstructor;
