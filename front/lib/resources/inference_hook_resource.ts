import type { Authenticator } from "@app/lib/auth";
import {
  InferenceHookModel,
  InferenceHookVersionModel,
} from "@app/lib/models/inference_hook";
import { BaseResource } from "@app/lib/resources/base_resource";
import type { ReadonlyAttributesType } from "@app/lib/resources/storage/types";
import type { ModelStaticWorkspaceAware } from "@app/lib/resources/storage/wrappers/workspace_models";
import { withTransaction } from "@app/lib/utils/sql_utils";
import type { Result } from "@app/types/shared/result";
import { Ok } from "@app/types/shared/result";
import assert from "assert";
import type { Attributes, Transaction } from "sequelize";

export interface InferenceHookResource extends ReadonlyAttributesType<InferenceHookModel> {}

export class InferenceHookResource extends BaseResource<InferenceHookModel> {
  static model: ModelStaticWorkspaceAware<InferenceHookModel> =
    InferenceHookModel;

  constructor(
    model: ModelStaticWorkspaceAware<InferenceHookModel>,
    blob: Attributes<InferenceHookModel>
  ) {
    super(model, blob);
  }

  static async deleteAllForWorkspace(auth: Authenticator): Promise<void> {
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
  }

  async delete(
    auth: Authenticator,
    { transaction }: { transaction?: Transaction }
  ): Promise<Result<undefined, Error>> {
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

    return new Ok(undefined);
  }
}
