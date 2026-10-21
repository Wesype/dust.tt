import { Authenticator } from "@app/lib/auth";
import { DfsClient } from "@app/lib/dfs/client";
import { DfsFileSystem } from "@app/lib/dfs/file_system";
import { FakeDfsTransport } from "@app/tests/utils/dfs/FakeDfsTransport";
import { InMemoryDfs } from "@app/tests/utils/dfs/InMemoryDfs";
import { GcsNotificationFactory } from "@app/tests/utils/GcsNotificationFactory";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
import { SpaceFactory } from "@app/tests/utils/SpaceFactory";
import { Ok } from "@app/types/shared/result";

export class GcsImportFactory {
  static context(dfs = new InMemoryDfs()) {
    const transport = new FakeDfsTransport({ UpdateGrants: new Ok({}) });
    const fs = new DfsFileSystem(dfs);

    return {
      dfs,
      fs,
      transport,
      context: {
        client: dfs,
        folders: {
          fs,
          getSuperuserFs: async () => new Ok(fs),
          tenantClient: new DfsClient(transport, "t".repeat(64)),
          rootId: dfs.rootId,
        },
      },
    };
  }

  static async user() {
    const { workspace, user, authenticator } = await createResourceTest({});
    const source = GcsNotificationFactory.replicationSource({
      workspaceId: workspace.sId,
      objectName: `w/${workspace.sId}/users/${user.sId}/files/MEMORY.md`,
    });

    return { auth: authenticator, workspace, user, source };
  }

  static async pod({
    withActiveEditor = true,
  }: { withActiveEditor?: boolean } = {}) {
    const { workspace, user, globalGroup } = await createResourceTest({});
    const pod = await SpaceFactory.project(
      workspace,
      withActiveEditor ? user.id : undefined,
      { name: "Quarterly plan" }
    );
    const auth = await Authenticator.internalAdminForWorkspace(workspace.sId, {
      dangerouslyRequestAllGroups: true,
    });
    const source = GcsNotificationFactory.replicationSource({
      workspaceId: workspace.sId,
      objectName: `w/${workspace.sId}/pods/${pod.sId}/files/nested/report.txt`,
    });

    return { auth, workspace, user, globalGroup, pod, source };
  }
}
