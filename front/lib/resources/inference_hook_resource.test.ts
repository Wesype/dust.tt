import type { Authenticator } from "@app/lib/auth";
import {
  InferenceHookCheckpointModel,
  InferenceHookEvaluationModel,
  InferenceHookModel,
  InferenceHookVersionModel,
} from "@app/lib/models/inference_hook";
import { InferenceHookResource } from "@app/lib/resources/inference_hook_resource";
import { AgentConfigurationFactory } from "@app/tests/utils/AgentConfigurationFactory";
import { ConversationFactory } from "@app/tests/utils/ConversationFactory";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
import { InferenceHookCheckpointFactory } from "@app/tests/utils/InferenceHookCheckpointFactory";
import { InferenceHookEvaluationFactory } from "@app/tests/utils/InferenceHookEvaluationFactory";
import { InferenceHookFactory } from "@app/tests/utils/InferenceHookFactory";
import { isAgentMessageType } from "@app/types/assistant/conversation";
import type { ModelId } from "@app/types/shared/model_id";
import type { LightWorkspaceType } from "@app/types/user";
import { beforeEach, describe, expect, it } from "vitest";

async function countRows(workspace: LightWorkspaceType) {
  return {
    hooks: await InferenceHookModel.count({
      where: { workspaceId: workspace.id },
    }),
    versions: await InferenceHookVersionModel.count({
      where: { workspaceId: workspace.id },
    }),
  };
}

describe("InferenceHookResource", () => {
  describe("makeNew", () => {
    it("creates the hook with its first version as the current one", async () => {
      const { authenticator } = await createResourceTest({ role: "admin" });

      const hook = await InferenceHookResource.makeNew(authenticator, {
        name: "Block keyword",
        provider: "dust",
        events: ["before_model_call"],
        enforcement: "block",
        onError: "deny",
        timeoutMs: 2_000,
      });

      const hooks = await InferenceHookResource.listByWorkspace(authenticator);
      expect(hooks.map((h) => h.toJSON())).toEqual([
        {
          sId: hook.sId,
          name: "Block keyword",
          provider: "dust",
          version: 1,
          events: ["before_model_call"],
          enforcement: "block",
          onError: "deny",
          timeoutMs: 2_000,
          excludedGroupIds: [],
        },
      ]);
    });

    it("refuses non-admins", async () => {
      const { authenticator } = await createResourceTest({ role: "user" });

      await expect(InferenceHookFactory.basic(authenticator)).rejects.toThrow();
    });
  });

  describe("listByWorkspace", () => {
    it("returns non-archived hooks at their current version", async () => {
      const { authenticator } = await createResourceTest({ role: "admin" });
      const hook = await InferenceHookFactory.basic(authenticator, {
        enforcement: "monitor",
      });
      await InferenceHookFactory.withNewVersion(authenticator, hook, {
        events: ["after_model_call"],
        enforcement: "block",
      });
      await InferenceHookFactory.archived(authenticator);

      const hooks = await InferenceHookResource.listByWorkspace(authenticator);

      expect(hooks.map((h) => h.toJSON())).toEqual([
        expect.objectContaining({
          sId: hook.sId,
          version: 2,
          events: ["after_model_call"],
          enforcement: "block",
        }),
      ]);
    });
  });

  describe("fetchById", () => {
    it("returns the current version, or the given one even if no longer current", async () => {
      const { authenticator } = await createResourceTest({ role: "admin" });
      const hook = await InferenceHookFactory.basic(authenticator, {
        enforcement: "monitor",
      });
      await InferenceHookFactory.withNewVersion(authenticator, hook, {
        events: ["before_model_call"],
        enforcement: "block",
      });

      const current = await InferenceHookResource.fetchById(
        authenticator,
        hook.sId
      );
      const pinned = await InferenceHookResource.fetchById(
        authenticator,
        hook.sId,
        { version: 1 }
      );

      expect(current?.toJSON()).toEqual(
        expect.objectContaining({ version: 2, enforcement: "block" })
      );
      expect(pinned?.toJSON()).toEqual(
        expect.objectContaining({ version: 1, enforcement: "monitor" })
      );
      expect(
        await InferenceHookResource.fetchById(authenticator, hook.sId, {
          version: 3,
        })
      ).toBeNull();
    });
  });

  describe("deleteAllForWorkspace", () => {
    it("deletes the hooks and versions of the workspace only", async () => {
      const { authenticator, workspace } = await createResourceTest({
        role: "admin",
      });
      const other = await createResourceTest({ role: "admin" });
      await InferenceHookFactory.basic(authenticator);
      await InferenceHookFactory.basic(authenticator);
      await InferenceHookFactory.basic(other.authenticator);

      await InferenceHookResource.deleteAllForWorkspace(authenticator);

      expect(await countRows(workspace)).toEqual({ hooks: 0, versions: 0 });
      expect(await countRows(other.workspace)).toEqual({
        hooks: 1,
        versions: 1,
      });
    });

    it("refuses non-admins", async () => {
      const { authenticator } = await createResourceTest({ role: "user" });

      await expect(
        InferenceHookResource.deleteAllForWorkspace(authenticator)
      ).rejects.toThrow();
    });
  });

  describe("delete", () => {
    it("deletes the hook and its versions", async () => {
      const { authenticator, workspace } = await createResourceTest({
        role: "admin",
      });
      const hook = await InferenceHookFactory.basic(authenticator);
      const kept = await InferenceHookFactory.basic(authenticator);

      const result = await hook.delete(authenticator, {});

      expect(result.isOk()).toBe(true);
      expect(
        await InferenceHookModel.findOne({
          where: { id: hook.id, workspaceId: workspace.id },
        })
      ).toBeNull();
      expect(
        await InferenceHookVersionModel.count({
          where: { hookId: hook.id, workspaceId: workspace.id },
        })
      ).toBe(0);
      expect(
        await InferenceHookVersionModel.count({
          where: { hookId: kept.id, workspaceId: workspace.id },
        })
      ).toBe(1);
    });
  });

  describe("checkpoints", () => {
    let auth: Authenticator;
    let workspace: LightWorkspaceType;
    let conversationModelId: ModelId;
    let agentMessageModelIds: ModelId[];
    let hook: InferenceHookResource;

    beforeEach(async () => {
      const setup = await createResourceTest({ role: "admin" });
      auth = setup.authenticator;
      workspace = setup.workspace;
      hook = await InferenceHookFactory.basic(auth);

      const agent = await AgentConfigurationFactory.createTestAgent(auth);
      const conversation = await ConversationFactory.create(auth, {
        agentConfigurationId: agent.sId,
        messagesCreatedAt: [new Date(), new Date()],
      });
      conversationModelId = conversation.id;
      agentMessageModelIds = conversation.content
        .flat()
        .filter(isAgentMessageType)
        .map((message) => message.agentMessageId);
    });

    it("keeps one before_model_call checkpoint per agent message step", async () => {
      const [agentMessageModelId] = agentMessageModelIds;
      await InferenceHookCheckpointFactory.basic(workspace, {
        conversationModelId,
        agentMessageModelId,
      });

      await expect(
        InferenceHookCheckpointFactory.basic(workspace, {
          conversationModelId,
          agentMessageModelId,
        })
      ).rejects.toThrow();
    });

    it("keeps one after_model_call checkpoint per model run", async () => {
      const [agentMessageModelId] = agentMessageModelIds;
      const afterModelCall = {
        conversationModelId,
        agentMessageModelId,
        event: "after_model_call" as const,
      };
      await InferenceHookCheckpointFactory.basic(workspace, {
        ...afterModelCall,
        dustRunId: "run-1",
      });
      await InferenceHookCheckpointFactory.basic(workspace, {
        ...afterModelCall,
        dustRunId: "run-2",
      });

      await expect(
        InferenceHookCheckpointFactory.basic(workspace, {
          ...afterModelCall,
          dustRunId: "run-1",
        })
      ).rejects.toThrow();
    });

    it("requires a dustRunId for after_model_call checkpoints only", async () => {
      const [agentMessageModelId] = agentMessageModelIds;

      await expect(
        InferenceHookCheckpointFactory.basic(workspace, {
          conversationModelId,
          agentMessageModelId,
          event: "before_model_call",
          dustRunId: "run-1",
        })
      ).rejects.toThrow("dustRunId must be set for after_model_call");
      await expect(
        InferenceHookCheckpointFactory.basic(workspace, {
          conversationModelId,
          agentMessageModelId,
          event: "after_model_call",
          dustRunId: null,
        })
      ).rejects.toThrow("dustRunId must be set for after_model_call");
    });

    it("deletes the checkpoints of the given agent messages only", async () => {
      const [deletedAgentMessageModelId, keptAgentMessageModelId] =
        agentMessageModelIds;
      await InferenceHookCheckpointFactory.basic(workspace, {
        conversationModelId,
        agentMessageModelId: deletedAgentMessageModelId,
      });
      await InferenceHookCheckpointFactory.basic(workspace, {
        conversationModelId,
        agentMessageModelId: keptAgentMessageModelId,
      });

      await InferenceHookResource.deleteCheckpointsByAgentMessageModelIds(
        auth,
        {
          agentMessageModelIds: [deletedAgentMessageModelId],
        }
      );

      const remaining = await InferenceHookCheckpointModel.findAll({
        where: {
          workspaceId: workspace.id,
          conversationId: conversationModelId,
        },
      });
      expect(remaining.map((c) => c.agentMessageId)).toEqual([
        keptAgentMessageModelId,
      ]);
    });

    it("keeps one evaluation per try of a hook version at a checkpoint", async () => {
      const checkpoint = await InferenceHookCheckpointFactory.basic(workspace, {
        conversationModelId,
        agentMessageModelId: agentMessageModelIds[0],
      });
      await InferenceHookEvaluationFactory.basic(workspace, {
        checkpoint,
        hook,
      });
      await InferenceHookEvaluationFactory.basic(workspace, {
        checkpoint,
        hook,
        index: 1,
      });

      await expect(
        InferenceHookEvaluationFactory.basic(workspace, { checkpoint, hook })
      ).rejects.toThrow();
    });

    it("deletes the evaluations of the deleted checkpoints", async () => {
      const [deletedAgentMessageModelId, keptAgentMessageModelId] =
        agentMessageModelIds;
      const deletedCheckpoint = await InferenceHookCheckpointFactory.basic(
        workspace,
        { conversationModelId, agentMessageModelId: deletedAgentMessageModelId }
      );
      const keptCheckpoint = await InferenceHookCheckpointFactory.basic(
        workspace,
        { conversationModelId, agentMessageModelId: keptAgentMessageModelId }
      );
      await InferenceHookEvaluationFactory.basic(workspace, {
        checkpoint: deletedCheckpoint,
        hook,
      });
      await InferenceHookEvaluationFactory.basic(workspace, {
        checkpoint: keptCheckpoint,
        hook,
      });

      await InferenceHookResource.deleteCheckpointsByAgentMessageModelIds(
        auth,
        { agentMessageModelIds: [deletedAgentMessageModelId] }
      );

      const remaining = await InferenceHookEvaluationModel.findAll({
        where: { workspaceId: workspace.id },
      });
      expect(remaining.map((e) => e.checkpointId)).toEqual([keptCheckpoint.id]);
    });
  });
});
