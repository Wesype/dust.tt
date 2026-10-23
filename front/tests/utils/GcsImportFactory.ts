import assert from "node:assert";
import { Authenticator } from "@app/lib/auth";
import { DfsClient } from "@app/lib/dfs/client";
import { DfsFileSystem } from "@app/lib/dfs/file_system";
import { ConversationResource } from "@app/lib/resources/conversation_resource";
import type { SpaceResource } from "@app/lib/resources/space_resource";
import { ConversationFactory } from "@app/tests/utils/ConversationFactory";
import { FakeDfsTransport } from "@app/tests/utils/dfs/FakeDfsTransport";
import { InMemoryDfs } from "@app/tests/utils/dfs/InMemoryDfs";
import { GcsNotificationFactory } from "@app/tests/utils/GcsNotificationFactory";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
import { MembershipFactory } from "@app/tests/utils/MembershipFactory";
import { SpaceFactory } from "@app/tests/utils/SpaceFactory";
import { UserFactory } from "@app/tests/utils/UserFactory";
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

  static async podConversation({
    withActiveEditor = true,
    depth = 0,
  }: { withActiveEditor?: boolean; depth?: number } = {}) {
    const fixture = await this.pod({ withActiveEditor });
    const conversation = await this.createPodConversation(fixture, depth);

    const source = GcsNotificationFactory.replicationSource({
      workspaceId: fixture.workspace.sId,
      objectName: `w/${fixture.workspace.sId}/conversations/${conversation.sId}/files/nested/report.txt`,
    });

    return { ...fixture, conversation, source };
  }

  // A sub-conversation is spawned by a conversation of the same pod, one level up.
  private static async createPodConversation(
    { auth, pod }: { auth: Authenticator; pod: SpaceResource },
    depth: number
  ): Promise<ConversationResource> {
    const parentConversation =
      depth > 0
        ? await this.createPodConversation({ auth, pod }, depth - 1)
        : undefined;
    const created = await ConversationFactory.create(auth, {
      agentConfigurationId: "dust",
      messagesCreatedAt: [],
      spaceId: pod.id,
      depth,
      parentConversation,
    });
    const conversation = await ConversationResource.fetchById(
      auth,
      created.sId
    );
    assert(conversation);
    return conversation;
  }

  static async standaloneConversation({
    withCreator = true,
    depth = 0,
  }: { withCreator?: boolean; depth?: number } = {}) {
    const fixture = await createResourceTest({});
    const auth = fixture.authenticator;
    const created = await ConversationFactory.create(auth, {
      agentConfigurationId: "dust",
      messagesCreatedAt: [],
      requestedSpaceIds: [fixture.globalSpace.id],
      depth,
    });
    const conversation = await ConversationResource.fetchById(
      auth,
      created.sId
    );
    assert(conversation);

    if (withCreator) {
      await ConversationResource.upsertParticipation(auth, {
        conversation,
        user: fixture.user.toJSON(),
        action: "posted",
      });
    }
    const source = GcsNotificationFactory.replicationSource({
      workspaceId: fixture.workspace.sId,
      objectName: `w/${fixture.workspace.sId}/conversations/${conversation.sId}/files/nested/report.txt`,
    });

    return { ...fixture, auth, conversation, source };
  }

  static async participant(
    auth: Authenticator,
    conversation: ConversationResource
  ) {
    const user = await UserFactory.basic();
    await MembershipFactory.associate(auth.getNonNullableWorkspace(), user, {
      role: "user",
    });
    await ConversationResource.upsertParticipation(auth, {
      conversation,
      user: user.toJSON(),
      action: "subscribed",
    });
    return user;
  }
}
