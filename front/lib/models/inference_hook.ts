import type {
  InferenceHookEnforcement,
  InferenceHookLifecycleEvent,
  InferenceHookOnError,
  InferenceHookProviderConfig,
  InferenceHookProviderIdType,
} from "@app/lib/inference_hook";
import { frontSequelize } from "@app/lib/resources/storage";
import { DataTypes } from "@app/lib/resources/storage/data_types";
import { UserModel } from "@app/lib/resources/storage/models/user";
import { WorkspaceAwareModel } from "@app/lib/resources/storage/wrappers/workspace_models";
import type { ModelId } from "@app/types/shared/model_id";
import type { CreationOptional, ForeignKey } from "sequelize";

/**
 * @cc [owner:sfriquet,label:backend] inference-hook-current-version-pointer
 * `currentVersion` MUST equal the highest `version` among the hook's rows in
 * `inference_hook_versions`, and a hook MUST NOT exist without such a row. A transaction that
 * inserts a version row MUST leave `currentVersion` satisfying this before it commits. The current
 * version is the row matching `(hookId, version) = (inference_hooks.id,
 * inference_hooks.currentVersion)`, served by that unique index.
 */
export class InferenceHookModel extends WorkspaceAwareModel<InferenceHookModel> {
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare provider: InferenceHookProviderIdType;
  declare name: string;
  declare currentVersion: number;
  declare archivedAt: Date | null;

  declare createdByUserId: ForeignKey<UserModel["id"]>;
}

InferenceHookModel.init(
  {
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    provider: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    currentVersion: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    archivedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    modelName: "inference_hook",
    sequelize: frontSequelize,
    indexes: [
      { fields: ["workspaceId"], concurrently: true },
      { fields: ["createdByUserId"], concurrently: true },
    ],
  }
);

UserModel.hasMany(InferenceHookModel, {
  foreignKey: { name: "createdByUserId", allowNull: false },
  onDelete: "RESTRICT",
});
InferenceHookModel.belongsTo(UserModel, {
  foreignKey: { name: "createdByUserId", allowNull: false },
});

/**
 * @cc [owner:sfriquet,label:backend] inference-hook-versions-immutable
 * A row of `inference_hook_versions` MUST NOT be updated after insert. Changing any of its fields
 * MUST insert a new version row, so the settings a hook ran with at any time can be rebuilt.
 */
export class InferenceHookVersionModel extends WorkspaceAwareModel<InferenceHookVersionModel> {
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare version: number;
  declare events: InferenceHookLifecycleEvent[];
  declare enforcement: InferenceHookEnforcement | null;
  declare onError: InferenceHookOnError;
  declare timeoutMs: number;
  declare excludedGroupIds: CreationOptional<ModelId[]>;
  declare credentialId: string | null;
  declare providerConfig: InferenceHookProviderConfig;

  declare hookId: ForeignKey<InferenceHookModel["id"]>;
  declare authorId: ForeignKey<UserModel["id"]>;
}

InferenceHookVersionModel.init(
  {
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    version: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    events: {
      type: DataTypes.ARRAY(DataTypes.STRING),
      allowNull: false,
    },
    enforcement: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    onError: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    timeoutMs: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    excludedGroupIds: {
      type: DataTypes.ARRAY(DataTypes.BIGINT),
      allowNull: false,
      defaultValue: [],
    },
    credentialId: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    providerConfig: {
      type: DataTypes.JSONB,
      allowNull: false,
    },
  },
  {
    modelName: "inference_hook_version",
    sequelize: frontSequelize,
    indexes: [
      { fields: ["workspaceId"], concurrently: true },
      { fields: ["hookId", "version"], unique: true, concurrently: true },
      { fields: ["authorId"], concurrently: true },
    ],
  }
);

InferenceHookModel.hasMany(InferenceHookVersionModel, {
  foreignKey: { name: "hookId", allowNull: false },
  onDelete: "RESTRICT",
});
InferenceHookVersionModel.belongsTo(InferenceHookModel, {
  foreignKey: { name: "hookId", allowNull: false },
  onDelete: "RESTRICT",
});

UserModel.hasMany(InferenceHookVersionModel, {
  foreignKey: { name: "authorId", allowNull: false },
  onDelete: "RESTRICT",
});
InferenceHookVersionModel.belongsTo(UserModel, {
  foreignKey: { name: "authorId", allowNull: false },
});
