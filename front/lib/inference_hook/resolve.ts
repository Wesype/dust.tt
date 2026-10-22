import type { Authenticator } from "@app/lib/auth";
import type {
  InferenceHook,
  InferenceHookProvider,
  InferenceHookVersionRef,
} from "@app/lib/inference_hook";
import { makeDustInferenceHookProvider } from "@app/lib/inference_hook/providers/dust";
import { InferenceHookResource } from "@app/lib/resources/inference_hook_resource";
import type {
  InferenceHookLifecycleEvent,
  InferenceHookProviderIdType,
} from "@app/types/inference_hook";
import type { WhitelistableFeature } from "@app/types/shared/feature_flags";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";
import { assertNever } from "@app/types/shared/utils/assert_never";

export type InferenceHookPlan = Record<
  InferenceHookLifecycleEvent,
  InferenceHook[]
>;

/**
 * @cc [owner:frankaloia,label:product;performance] inference-hooks-read-current-version
 * When `featureFlags` excludes `inference_hooks`, resolution MUST NOT read hook rows. Otherwise
 * each checkpoint MUST get the current version of every non-archived hook listing that event:
 * each hook under its resolved `enforcement` (`block` or `monitor`).
 * A hook MUST be skipped when the authenticated user is in one of its excluded groups; a run with
 * no user MUST NOT skip any hook.
 */
export async function resolveInferenceHooks(
  auth: Authenticator,
  { featureFlags }: { featureFlags: readonly WhitelistableFeature[] }
): Promise<InferenceHookPlan> {
  const plan: InferenceHookPlan = {
    before_model_call: [],
    after_model_call: [],
  };
  if (!featureFlags.includes("inference_hooks")) {
    return plan;
  }

  const hooks = await InferenceHookResource.listApplicable(auth);
  for (const hook of hooks) {
    const runtimeHook = toRuntimeHook(hook);
    for (const event of hook.events) {
      plan[event].push(runtimeHook);
    }
  }

  return plan;
}

export async function loadInferenceHook(
  auth: Authenticator,
  { hookId, hookVersion }: InferenceHookVersionRef
): Promise<Result<InferenceHook, Error>> {
  const resource = await InferenceHookResource.fetchById(auth, hookId, {
    version: hookVersion,
  });
  if (!resource) {
    return new Err(
      new Error(`Unknown inference hook version: ${hookId} v${hookVersion}`)
    );
  }
  return new Ok(toRuntimeHook(resource));
}

function toRuntimeHook(hook: InferenceHookResource): InferenceHook {
  return {
    hookId: hook.sId,
    hookVersion: hook.version,
    // TODO(inference-hooks): Ask the provider adapter for its enforcement. Until then a hook
    // with no stored enforcement blocks, so a configured hook is never skipped.
    enforcement: hook.enforcement ?? "block",
    provider: makeProvider(hook.provider),
    timeoutMs: hook.timeoutMs,
    onError: hook.onError,
  };
}

function makeProvider(
  provider: InferenceHookProviderIdType
): InferenceHookProvider {
  switch (provider) {
    case "dust":
      return makeDustInferenceHookProvider();
    case "datadog_ai_guard":
      // Not implemented yet. Rejecting makes the runner apply the hook's `onError`.
      return {
        async evaluate() {
          throw new Error(
            `Inference hook provider "${provider}" is not implemented`
          );
        },
      };
    default:
      assertNever(provider);
  }
}
