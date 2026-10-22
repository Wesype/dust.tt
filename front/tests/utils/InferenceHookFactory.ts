import type { Authenticator } from "@app/lib/auth";
import {
  InferenceHookModel,
  InferenceHookVersionModel,
} from "@app/lib/models/inference_hook";
import type { CreateInferenceHookParams } from "@app/lib/resources/inference_hook_resource";
import { InferenceHookResource } from "@app/lib/resources/inference_hook_resource";
import type {
  InferenceHookEnforcement,
  InferenceHookLifecycleEvent,
  InferenceHookOnError,
  InferenceHookProviderConfig,
} from "@app/types/inference_hook";
import type { ModelId } from "@app/types/shared/model_id";
import assert from "assert";

export class InferenceHookFactory {
  static async basic(
    auth: Authenticator,
    params: Partial<CreateInferenceHookParams> = {}
  ): Promise<InferenceHookResource> {
    return InferenceHookResource.makeNew(auth, {
      name: "Test hook",
      provider: "dust",
      events: ["before_model_call"],
      enforcement: null,
      onError: "allow",
      timeoutMs: 5_000,
      ...params,
    });
  }

  static async archived(
    auth: Authenticator,
    params: Partial<CreateInferenceHookParams> = {}
  ): Promise<InferenceHookResource> {
    const hook = await this.basic(auth, params);
    await InferenceHookModel.update(
      { archivedAt: new Date() },
      { where: { id: hook.id, workspaceId: hook.workspaceId } }
    );
    return hook;
  }

  static async withNewVersion(
    auth: Authenticator,
    hook: InferenceHookResource,
    {
      events,
      enforcement,
      onError = "allow",
      timeoutMs = 5_000,
      excludedGroupIds = [],
      credentialId = null,
      providerConfig = {},
    }: {
      events: InferenceHookLifecycleEvent[];
      enforcement: InferenceHookEnforcement | null;
      onError?: InferenceHookOnError;
      timeoutMs?: number;
      excludedGroupIds?: ModelId[];
      credentialId?: string | null;
      providerConfig?: InferenceHookProviderConfig;
    }
  ): Promise<InferenceHookResource> {
    const workspaceId = auth.getNonNullableWorkspace().id;
    const head = await InferenceHookModel.findOne({
      where: { id: hook.id, workspaceId },
    });
    assert(head, "Inference hook not found");
    const version = head.currentVersion + 1;

    await InferenceHookVersionModel.create({
      workspaceId,
      hookId: hook.id,
      version,
      authorId: auth.getNonNullableUser().id,
      events,
      enforcement,
      onError,
      timeoutMs,
      excludedGroupIds,
      credentialId,
      providerConfig,
    });
    await head.update({ currentVersion: version });

    const updated = await InferenceHookResource.fetchById(auth, hook.sId);
    assert(updated, "Inference hook not found");
    return updated;
  }
}
