import { Authenticator } from "@app/lib/auth";
import {
  InferenceHookModel,
  InferenceHookVersionModel,
} from "@app/lib/models/inference_hook";
import { InferenceHookResource } from "@app/lib/resources/inference_hook_resource";
import { InferenceHookFactory } from "@app/tests/utils/InferenceHookFactory";
import { UserFactory } from "@app/tests/utils/UserFactory";
import { WorkspaceFactory } from "@app/tests/utils/WorkspaceFactory";
import type { WorkspaceType } from "@app/types/user";
import { describe, expect, it } from "vitest";

async function countRows(workspace: WorkspaceType) {
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
  describe("deleteAllForWorkspace", () => {
    it("deletes the hooks and versions of the workspace only", async () => {
      const user = await UserFactory.basic();
      const workspace = await WorkspaceFactory.basic();
      const otherWorkspace = await WorkspaceFactory.basic();
      await InferenceHookFactory.basic(workspace, user);
      await InferenceHookFactory.basic(workspace, user);
      await InferenceHookFactory.basic(otherWorkspace, user);

      await InferenceHookResource.deleteAllForWorkspace(
        await Authenticator.internalAdminForWorkspace(workspace.sId)
      );

      expect(await countRows(workspace)).toEqual({ hooks: 0, versions: 0 });
      expect(await countRows(otherWorkspace)).toEqual({
        hooks: 1,
        versions: 1,
      });
    });
  });

  describe("delete", () => {
    it("deletes the hook and its versions", async () => {
      const user = await UserFactory.basic();
      const workspace = await WorkspaceFactory.basic();
      const hook = await InferenceHookFactory.basic(workspace, user);
      const otherHook = await InferenceHookFactory.basic(workspace, user);

      const result = await hook.delete(
        await Authenticator.internalAdminForWorkspace(workspace.sId),
        {}
      );

      expect(result.isOk()).toBe(true);
      const remainingHooks = await InferenceHookModel.findAll({
        where: { workspaceId: workspace.id },
      });
      const remainingVersions = await InferenceHookVersionModel.findAll({
        where: { workspaceId: workspace.id },
      });
      expect(remainingHooks.map((h) => h.id)).toEqual([otherHook.id]);
      expect(remainingVersions.map((v) => v.hookId)).toEqual([otherHook.id]);
    });
  });
});
