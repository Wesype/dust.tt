import type { Authenticator } from "@app/lib/auth";
import {
  InferenceHookCheckpointModel,
  InferenceHookEvaluationModel,
  InferenceHookModel,
  InferenceHookVersionModel,
} from "@app/lib/models/inference_hook";
import { BaseResource } from "@app/lib/resources/base_resource";
import { defineCachedResourceList } from "@app/lib/resources/cached_resource_store";
import { GroupResource } from "@app/lib/resources/group_resource";
import type { ReadonlyAttributesType } from "@app/lib/resources/storage/types";
import type { ModelStaticWorkspaceAware } from "@app/lib/resources/storage/wrappers/workspace_models";
import {
  getResourceIdFromSId,
  isResourceSId,
  makeSId,
} from "@app/lib/resources/string_ids";
import { withTransaction } from "@app/lib/utils/sql_utils";
import type {
  InferenceHookEnforcement,
  InferenceHookLifecycleEvent,
  InferenceHookOnError,
  InferenceHookProviderConfig,
  InferenceHookProviderIdType,
  InferenceHookType,
} from "@app/types/inference_hook";
import type { ModelId } from "@app/types/shared/model_id";
import type { Result } from "@app/types/shared/result";
import { Ok } from "@app/types/shared/result";
import assert from "assert";
import type { Attributes, Transaction, WhereOptions } from "sequelize";
import { Op } from "sequelize";

const INFERENCE_HOOKS_CACHE_VERSION = 1;

export type CreateInferenceHookParams = {
  name: string;
  provider: InferenceHookProviderIdType;
  events: InferenceHookLifecycleEvent[];
  enforcement: InferenceHookEnforcement | null;
  onError: InferenceHookOnError;
  timeoutMs: number;
  excludedGroupIds?: ModelId[];
  credentialId?: string | null;
  providerConfig?: InferenceHookProviderConfig;
};

type FetchOptions = {
  where?: WhereOptions<InferenceHookModel>;
  version?: number;
  transaction?: Transaction;
};

type CachedInferenceHookData = {
  id: ModelId;
  workspaceId: ModelId;
  provider: InferenceHookProviderIdType;
  name: string;
  currentVersion: number;
  createdByUserId: ModelId;
  createdAt: number;
  updatedAt: number;
  version: {
    id: ModelId;
    version: number;
    events: InferenceHookLifecycleEvent[];
    enforcement: InferenceHookEnforcement | null;
    onError: InferenceHookOnError;
    timeoutMs: number;
    excludedGroupIds: ModelId[];
    credentialId: string | null;
    providerConfig: InferenceHookProviderConfig;
    authorId: ModelId;
    createdAt: number;
    updatedAt: number;
  };
};

export interface InferenceHookResource extends ReadonlyAttributesType<InferenceHookModel> {}

/**
 * A hook at one of its versions: the current one, unless fetched by version.
 *
 * @cc [owner:sfriquet,label:architecture;backend] inference-hook-models-behind-resource
 * Runtime code MUST read and write the inference hook models of `lib/models/inference_hook.ts`
 * (hooks, their versions, checkpoints and evaluations) only through `InferenceHookResource`.
 *
 * @cc [owner:frankaloia,label:backend;performance] inference-hook-list-cache-consistency
 * A mutation that changes the set of non-archived hooks or a hook's current version MUST
 * invalidate the workspace's `listByWorkspace` cache: before returning when it owns its
 * transaction, or once the caller's transaction commits.
 */
export class InferenceHookResource extends BaseResource<InferenceHookModel> {
  static model: ModelStaticWorkspaceAware<InferenceHookModel> =
    InferenceHookModel;

  private readonly hookVersion: Attributes<InferenceHookVersionModel>;

  constructor(
    model: ModelStaticWorkspaceAware<InferenceHookModel>,
    blob: Attributes<InferenceHookModel>,
    hookVersion: Attributes<InferenceHookVersionModel>
  ) {
    super(model, blob);
    this.hookVersion = hookVersion;
  }

  get sId(): string {
    return InferenceHookResource.modelIdToSId({
      id: this.id,
      workspaceId: this.workspaceId,
    });
  }

  get version(): number {
    return this.hookVersion.version;
  }

  static modelIdToSId({
    id,
    workspaceId,
  }: {
    id: ModelId;
    workspaceId: ModelId;
  }): string {
    return makeSId("inference_hook", { id, workspaceId });
  }

  static async makeNew(
    auth: Authenticator,
    params: CreateInferenceHookParams,
    { transaction }: { transaction?: Transaction } = {}
  ): Promise<InferenceHookResource> {
    assert(auth.isAdmin(), "Only admins can create inference hooks");
    const workspaceId = auth.getNonNullableWorkspace().id;
    const userId = auth.getNonNullableUser().id;

    const resource = await withTransaction(async (t) => {
      const hook = await this.model.create(
        {
          workspaceId,
          provider: params.provider,
          name: params.name,
          currentVersion: 1,
          createdByUserId: userId,
        },
        { transaction: t }
      );
      const hookVersion = await InferenceHookVersionModel.create(
        {
          workspaceId,
          hookId: hook.id,
          version: 1,
          authorId: userId,
          events: params.events,
          enforcement: params.enforcement,
          onError: params.onError,
          timeoutMs: params.timeoutMs,
          excludedGroupIds: params.excludedGroupIds ?? [],
          credentialId: params.credentialId ?? null,
          providerConfig: params.providerConfig ?? {},
        },
        { transaction: t }
      );
      return new this(this.model, hook.get(), hookVersion.get());
    }, transaction);

    await this.store.invalidate(workspaceId, transaction);

    return resource;
  }

  private static async baseFetch(
    workspaceId: ModelId,
    { where = {}, version, transaction }: FetchOptions = {}
  ): Promise<InferenceHookResource[]> {
    const hooks = await this.model.findAll({
      where: { ...where, workspaceId },
      transaction,
    });
    if (hooks.length === 0) {
      return [];
    }

    const versions = await InferenceHookVersionModel.findAll({
      where: {
        workspaceId,
        [Op.or]: hooks.map((hook) => ({
          hookId: hook.id,
          version: version ?? hook.currentVersion,
        })),
      },
      transaction,
    });
    const versionsByHookId = new Map(versions.map((v) => [v.hookId, v]));

    return hooks.flatMap((hook) => {
      const hookVersion = versionsByHookId.get(hook.id);
      if (!hookVersion) {
        assert(
          version !== undefined,
          `Inference hook ${hook.id} has no row for its current version ${hook.currentVersion}`
        );
        return [];
      }
      return [new this(this.model, hook.get(), hookVersion.get())];
    });
  }

  private static readonly store = defineCachedResourceList<
    ModelId,
    CachedInferenceHookData[],
    InferenceHookResource
  >({
    id: "inference_hooks_by_workspace",
    version: INFERENCE_HOOKS_CACHE_VERSION,
    key: (workspaceId) => String(workspaceId),
    loadFromDatabase: (workspaceId, transaction) =>
      InferenceHookResource.baseFetch(workspaceId, {
        where: { archivedAt: null },
        transaction,
      }),
    toSnapshot: (hooks) =>
      hooks.map((hook) => ({
        id: hook.id,
        workspaceId: hook.workspaceId,
        provider: hook.provider,
        name: hook.name,
        currentVersion: hook.currentVersion,
        createdByUserId: hook.createdByUserId,
        createdAt: hook.createdAt.getTime(),
        updatedAt: hook.updatedAt.getTime(),
        version: {
          id: hook.hookVersion.id,
          version: hook.hookVersion.version,
          events: hook.hookVersion.events,
          enforcement: hook.hookVersion.enforcement,
          onError: hook.hookVersion.onError,
          timeoutMs: hook.hookVersion.timeoutMs,
          excludedGroupIds: hook.hookVersion.excludedGroupIds,
          credentialId: hook.hookVersion.credentialId,
          providerConfig: hook.hookVersion.providerConfig,
          authorId: hook.hookVersion.authorId,
          createdAt: hook.hookVersion.createdAt.getTime(),
          updatedAt: hook.hookVersion.updatedAt.getTime(),
        },
      })),
    fromSnapshot: (hooks) =>
      hooks.map(
        ({ version, ...hook }) =>
          new InferenceHookResource(
            InferenceHookModel,
            {
              ...hook,
              archivedAt: null,
              createdAt: new Date(hook.createdAt),
              updatedAt: new Date(hook.updatedAt),
            },
            {
              ...version,
              workspaceId: hook.workspaceId,
              hookId: hook.id,
              createdAt: new Date(version.createdAt),
              updatedAt: new Date(version.updatedAt),
            }
          )
      ),
  });

  /**
   * Non-archived hooks at their current version.
   */
  static async listByWorkspace(
    auth: Authenticator
  ): Promise<InferenceHookResource[]> {
    return this.store.fetch(auth.getNonNullableWorkspace().id);
  }

  /**
   * Defaults to the current version. A given `version` is returned even if no longer current.
   */
  static async fetchById(
    auth: Authenticator,
    sId: string,
    { version }: { version?: number } = {}
  ): Promise<InferenceHookResource | null> {
    if (!isResourceSId("inference_hook", sId)) {
      return null;
    }
    const id = getResourceIdFromSId(sId);
    if (id === null) {
      return null;
    }

    const [hook] = await this.baseFetch(auth.getNonNullableWorkspace().id, {
      where: { id },
      version,
    });
    return hook ?? null;
  }

  static async deleteAllForWorkspace(auth: Authenticator): Promise<void> {
    assert(auth.isAdmin(), "Only admins can delete inference hooks");
    const workspaceId = auth.getNonNullableWorkspace().id;

    await withTransaction(async (transaction) => {
      await InferenceHookVersionModel.destroy({
        where: { workspaceId },
        transaction,
      });
      await this.model.destroy({
        where: { workspaceId },
        transaction,
      });
    });

    await this.store.invalidate(workspaceId);
  }

  static async deleteCheckpointsByAgentMessageModelIds(
    auth: Authenticator,
    { agentMessageModelIds }: { agentMessageModelIds: ModelId[] }
  ): Promise<number> {
    const workspaceId = auth.getNonNullableWorkspace().id;
    const checkpoints = await InferenceHookCheckpointModel.findAll({
      attributes: ["id"],
      where: {
        workspaceId,
        agentMessageId: { [Op.in]: agentMessageModelIds },
      },
    });
    const checkpointModelIds = checkpoints.map((c) => c.id);

    await InferenceHookEvaluationModel.destroy({
      where: { workspaceId, checkpointId: { [Op.in]: checkpointModelIds } },
    });

    return InferenceHookCheckpointModel.destroy({
      where: { workspaceId, id: { [Op.in]: checkpointModelIds } },
    });
  }

  async delete(
    auth: Authenticator,
    { transaction }: { transaction?: Transaction }
  ): Promise<Result<undefined, Error>> {
    assert(auth.isAdmin(), "Only admins can delete inference hooks");
    const workspaceId = auth.getNonNullableWorkspace().id;
    assert(
      this.workspaceId === workspaceId,
      "Can only delete inference hooks of the current workspace"
    );

    await withTransaction(async (t) => {
      await InferenceHookVersionModel.destroy({
        where: { workspaceId, hookId: this.id },
        transaction: t,
      });
      await this.model.destroy({
        where: { workspaceId, id: this.id },
        transaction: t,
      });
    }, transaction);

    await InferenceHookResource.store.invalidate(workspaceId, transaction);

    return new Ok(undefined);
  }

  toJSON(): InferenceHookType {
    return {
      sId: this.sId,
      name: this.name,
      provider: this.provider,
      version: this.version,
      events: this.hookVersion.events,
      enforcement: this.hookVersion.enforcement,
      onError: this.hookVersion.onError,
      timeoutMs: this.hookVersion.timeoutMs,
      excludedGroupIds: this.hookVersion.excludedGroupIds.map((id) =>
        GroupResource.modelIdToSId({ id, workspaceId: this.workspaceId })
      ),
    };
  }
}
