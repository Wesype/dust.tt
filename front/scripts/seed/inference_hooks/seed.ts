import { FeatureFlagResource } from "@app/lib/resources/feature_flag_resource";
import { InferenceHookResource } from "@app/lib/resources/inference_hook_resource";
import { makeScript } from "@app/scripts/helpers";
import { createSeedContext } from "@app/scripts/seed/factories";
import type {
  InferenceHookEnforcement,
  InferenceHookOnError,
} from "@app/types/inference_hook";
import { INFERENCE_HOOK_LIFECYCLE_EVENTS } from "@app/types/inference_hook";

const HOOKS: {
  name: string;
  enforcement: InferenceHookEnforcement;
  onError: InferenceHookOnError;
}[] = [
  { name: "Dust provider (block)", enforcement: "block", onError: "deny" },
  { name: "Dust provider (monitor)", enforcement: "monitor", onError: "allow" },
];

makeScript({}, async ({ execute }, logger) => {
  const ctx = await createSeedContext({ execute, logger });

  if (execute) {
    await FeatureFlagResource.enableMany(ctx.workspace, ["inference_hooks"]);
  }
  logger.info(
    `${execute ? "" : "[DRYRUN]: "}Enabled the inference_hooks feature flag.`
  );

  const existingNames = new Set(
    (await InferenceHookResource.listByWorkspace(ctx.auth)).map(
      (hook) => hook.name
    )
  );

  for (const { name, enforcement, onError } of HOOKS) {
    if (existingNames.has(name)) {
      logger.info(`Inference hook "${name}" already exists, skipping.`);
      continue;
    }

    if (execute) {
      await InferenceHookResource.makeNew(ctx.auth, {
        name,
        provider: "dust",
        events: [...INFERENCE_HOOK_LIFECYCLE_EVENTS],
        enforcement,
        onError,
        timeoutMs: 5_000,
      });
    }
    logger.info(
      `${execute ? "" : "[DRYRUN]: "}Created ${enforcement} inference hook "${name}".`
    );
  }
});
