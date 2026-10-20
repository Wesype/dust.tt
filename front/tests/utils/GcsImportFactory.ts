import { DfsClient } from "@app/lib/dfs/client";
import { DfsFileSystem } from "@app/lib/dfs/file_system";
import { FakeDfsTransport } from "@app/tests/utils/dfs/FakeDfsTransport";
import { InMemoryDfs } from "@app/tests/utils/dfs/InMemoryDfs";
import { GcsNotificationFactory } from "@app/tests/utils/GcsNotificationFactory";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
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
}
