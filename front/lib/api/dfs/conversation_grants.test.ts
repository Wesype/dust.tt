// @vitest-environment node
import { getDfsTenantClient } from "@app/lib/api/dfs/clients";
import { reflectConversationParticipationOnDfs } from "@app/lib/api/dfs/conversation_grants";
import { withDfsFolderContext } from "@app/lib/api/dfs/folder_context";
import { Authenticator } from "@app/lib/auth";
import { DfsClient } from "@app/lib/dfs/client";
import { newDfsObjectId } from "@app/lib/dfs/object_id";
import { ConversationResource } from "@app/lib/resources/conversation_resource";
import { UserResource } from "@app/lib/resources/user_resource";
import { ConversationFactory } from "@app/tests/utils/ConversationFactory";
import type { FakeDfsAnswer } from "@app/tests/utils/dfs/FakeDfsTransport";
import { FakeDfsTransport } from "@app/tests/utils/dfs/FakeDfsTransport";
import { FeatureFlagFactory } from "@app/tests/utils/FeatureFlagFactory";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
import { MembershipFactory } from "@app/tests/utils/MembershipFactory";
import { SpaceFactory } from "@app/tests/utils/SpaceFactory";
import { UserFactory } from "@app/tests/utils/UserFactory";
import { Ok } from "@app/types/shared/result";
import { Transaction } from "sequelize";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@app/lib/api/dfs/clients", () => ({
  getDfsTenantClient: vi.fn(),
}));

vi.mock("@app/lib/api/dfs/folder_context", () => ({
  withDfsFolderContext: vi.fn(),
}));

beforeEach(() => {
  // Creating a conversation creates no folder unless a test sets one up.
  vi.mocked(withDfsFolderContext).mockResolvedValue(new Ok(undefined));
});

function setup({ listGrants }: { listGrants?: FakeDfsAnswer } = {}) {
  const transport = new FakeDfsTransport({
    UpdateGrants: new Ok({}),
    ...(listGrants ? { ListGrants: listGrants } : {}),
  });
  vi.mocked(getDfsTenantClient).mockResolvedValue(
    new Ok(new DfsClient(transport, "t".repeat(64)))
  );
  return { transport };
}

// Each test runs in a transaction that is rolled back, so `afterCommit` hooks never run on their
// own: `commit` runs the hooks registered since `captureAfterCommit`.
function captureAfterCommit() {
  const hooks: (() => unknown)[] = [];
  const spy = vi
    .spyOn(Transaction.prototype, "afterCommit")
    .mockImplementation(function (this: Transaction, hook) {
      hooks.push(() => hook(this));
    });
  return {
    commit: async () => {
      spy.mockRestore();
      for (const hook of hooks) {
        await hook();
      }
    },
  };
}

async function createConversationWithFolder(
  auth: Authenticator,
  { spaceModelId }: { spaceModelId?: number } = {}
) {
  const created = await ConversationFactory.create(auth, {
    agentConfigurationId: "dust",
    messagesCreatedAt: [],
    spaceId: spaceModelId,
  });
  const conversation = await ConversationResource.fetchById(auth, created.sId);
  if (!conversation) {
    throw new Error("Conversation not found.");
  }
  const folderId = newDfsObjectId();
  await conversation.setDfsObjectId(auth, folderId);
  return { conversation, folderId };
}

describe("reflectConversationParticipationOnDfs on addition", () => {
  it("grants a participant added to a conversation outside pods read and write access to its folder", async () => {
    const { authenticator, workspace } = await createResourceTest({});
    await FeatureFlagFactory.basic(authenticator, "dust_file_system");
    const { transport } = setup();
    const added = await UserFactory.basic();
    await MembershipFactory.associate(workspace, added, { role: "user" });
    // Fetched before its folder is stored: the folder is re-read.
    const created = await ConversationFactory.create(authenticator, {
      agentConfigurationId: "dust",
      messagesCreatedAt: [],
    });
    const conversation = await ConversationResource.fetchById(
      authenticator,
      created.sId
    );
    const folderId = newDfsObjectId();
    await conversation?.setDfsObjectId(authenticator, folderId);

    const { commit } = captureAfterCommit();
    await ConversationResource.upsertParticipation(authenticator, {
      conversation: created,
      action: "subscribed",
      user: added.toJSON(),
    });
    await commit();

    expect(transport.calls.map((c) => c.request)).toEqual([
      {
        objectId: { value: Buffer.from(folderId, "hex") },
        changes: [
          {
            grant: { allow: { subject: `u:${added.sId}`, mode: 6 } },
            remove: false,
          },
        ],
      },
    ]);
  });

  it("does not grant again a participant who already participates", async () => {
    const { authenticator, user } = await createResourceTest({});
    await FeatureFlagFactory.basic(authenticator, "dust_file_system");
    const { conversation } = await createConversationWithFolder(authenticator);
    await ConversationResource.upsertParticipation(authenticator, {
      conversation,
      action: "posted",
      user: user.toJSON(),
    });
    const { transport } = setup();

    const { commit } = captureAfterCommit();
    await ConversationResource.upsertParticipation(authenticator, {
      conversation,
      action: "posted",
      user: user.toJSON(),
    });
    await commit();

    expect(transport.calls).toEqual([]);
  });

  it("does not grant participants of a conversation in a pod", async () => {
    const { workspace, user } = await createResourceTest({});
    const pod = await SpaceFactory.project(workspace, user.id);
    // Refreshed so that it includes the new pod's groups.
    const auth = await Authenticator.fromUserIdAndWorkspaceId(
      user.sId,
      workspace.sId
    );
    await FeatureFlagFactory.basic(auth, "dust_file_system");
    const { transport } = setup();
    const { conversation } = await createConversationWithFolder(auth, {
      spaceModelId: pod.id,
    });

    const { commit } = captureAfterCommit();
    await ConversationResource.upsertParticipation(auth, {
      conversation,
      action: "posted",
      user: user.toJSON(),
    });
    await commit();

    expect(transport.calls).toEqual([]);
  });

  it("does nothing without the dust_file_system feature flag", async () => {
    const { authenticator, user } = await createResourceTest({});
    const { transport } = setup();
    const { conversation } = await createConversationWithFolder(authenticator);

    const { commit } = captureAfterCommit();
    await ConversationResource.upsertParticipation(authenticator, {
      conversation,
      action: "posted",
      user: user.toJSON(),
    });
    await commit();

    expect(transport.calls).toEqual([]);
  });
  it("does not grant a participant added who cannot access the conversation", async () => {
    const {
      authenticator: adminAuth,
      workspace,
      user: admin,
    } = await createResourceTest({ role: "admin" });
    await FeatureFlagFactory.basic(adminAuth, "dust_file_system");
    const outsider = await UserFactory.basic();
    await MembershipFactory.associate(workspace, outsider, { role: "user" });
    const restrictedSpace = await SpaceFactory.regular(workspace);
    const added = await restrictedSpace.addMembers(adminAuth, {
      userIds: [admin.sId],
    });
    expect(added.isOk()).toBe(true);
    const { conversation, folderId } =
      await createConversationWithFolder(adminAuth);
    // The folder has no grant yet, so restricting it revokes nothing.
    const { transport } = setup({ listGrants: new Ok({ grants: [] }) });
    await conversation.updateRequirements(adminAuth, [restrictedSpace.id]);

    const { commit } = captureAfterCommit();
    await ConversationResource.upsertParticipation(adminAuth, {
      conversation,
      action: "subscribed",
      user: outsider.toJSON(),
    });
    await commit();

    expect(
      transport.calls
        .filter((c) => c.method === "UpdateGrants")
        .map((c) => c.request)
    ).toEqual([
      {
        objectId: { value: Buffer.from(folderId, "hex") },
        changes: [
          {
            grant: { allow: { subject: `u:${outsider.sId}`, mode: 6 } },
            remove: true,
          },
        ],
      },
    ]);
  });
});

describe("reflectConversationParticipationOnDfs on departure", () => {
  it("removes the access of a participant who leaves a conversation outside pods", async () => {
    const { authenticator, workspace, user } = await createResourceTest({});
    await FeatureFlagFactory.basic(authenticator, "dust_file_system");
    const other = await UserFactory.basic();
    await MembershipFactory.associate(workspace, other, { role: "user" });
    const { conversation, folderId } =
      await createConversationWithFolder(authenticator);
    for (const participant of [user, other]) {
      await ConversationResource.upsertParticipation(authenticator, {
        conversation,
        action: "posted",
        user: participant.toJSON(),
      });
    }
    const { transport } = setup();

    const res = await conversation.leaveConversation(authenticator);

    expect(res.isOk() && res.value.affectedCount).toBe(1);
    expect(transport.calls.map((c) => c.request)).toEqual([
      {
        objectId: { value: Buffer.from(folderId, "hex") },
        changes: [
          {
            grant: { allow: { subject: `u:${user.sId}`, mode: 6 } },
            remove: true,
          },
        ],
      },
    ]);
  });

  it("does not update grants when the last participant cannot leave", async () => {
    const { authenticator, user } = await createResourceTest({});
    await FeatureFlagFactory.basic(authenticator, "dust_file_system");
    const { conversation } = await createConversationWithFolder(authenticator);
    await ConversationResource.upsertParticipation(authenticator, {
      conversation,
      action: "posted",
      user: user.toJSON(),
    });
    const { transport } = setup();

    await conversation.leaveConversation(authenticator);

    expect(transport.calls).toEqual([]);
  });

  it("removes the access of a participant who leaves a soft-deleted conversation", async () => {
    const { authenticator, workspace, user } = await createResourceTest({});
    await FeatureFlagFactory.basic(authenticator, "dust_file_system");
    const other = await UserFactory.basic();
    await MembershipFactory.associate(workspace, other, { role: "user" });
    const { conversation, folderId } =
      await createConversationWithFolder(authenticator);
    for (const participant of [user, other]) {
      await ConversationResource.upsertParticipation(authenticator, {
        conversation,
        action: "posted",
        user: participant.toJSON(),
      });
    }
    await conversation.updateVisibilityToDeleted(authenticator);
    const { transport } = setup();

    await conversation.leaveConversation(authenticator);

    expect(transport.calls.map((c) => c.request)).toEqual([
      {
        objectId: { value: Buffer.from(folderId, "hex") },
        changes: [
          {
            grant: { allow: { subject: `u:${user.sId}`, mode: 6 } },
            remove: true,
          },
        ],
      },
    ]);
  });
});

describe("reflectConversationParticipationOnDfs", () => {
  it("removes the grant of a user who no longer participates when it runs", async () => {
    const { authenticator, workspace } = await createResourceTest({});
    await FeatureFlagFactory.basic(authenticator, "dust_file_system");
    const departed = await UserFactory.basic();
    await MembershipFactory.associate(workspace, departed, { role: "user" });
    const { conversation, folderId } =
      await createConversationWithFolder(authenticator);
    const user = await UserResource.fetchById(departed.sId);
    if (!user) {
      throw new Error("User not found.");
    }
    const { transport } = setup();

    // E.g. an addition whose hook runs after the user left.
    await reflectConversationParticipationOnDfs(authenticator, {
      conversation,
      user,
    });

    expect(transport.calls.map((c) => c.request)).toEqual([
      {
        objectId: { value: Buffer.from(folderId, "hex") },
        changes: [
          {
            grant: { allow: { subject: `u:${departed.sId}`, mode: 6 } },
            remove: true,
          },
        ],
      },
    ]);
  });
});
describe("reflectConversationRequirementsOnDfs", () => {
  it("detaches the grants of users who cannot access the conversation after its requirements change", async () => {
    const {
      authenticator: adminAuth,
      workspace,
      user: admin,
    } = await createResourceTest({ role: "admin" });
    await FeatureFlagFactory.basic(adminAuth, "dust_file_system");
    const other = await UserFactory.basic();
    await MembershipFactory.associate(workspace, other, { role: "user" });
    const restrictedSpace = await SpaceFactory.regular(workspace);
    const added = await restrictedSpace.addMembers(adminAuth, {
      userIds: [admin.sId],
    });
    expect(added.isOk()).toBe(true);
    const { conversation, folderId } =
      await createConversationWithFolder(adminAuth);
    for (const participant of [admin, other]) {
      await ConversationResource.upsertParticipation(adminAuth, {
        conversation,
        action: "posted",
        user: participant.toJSON(),
      });
    }
    const { transport } = setup({
      listGrants: new Ok({
        grants: [
          { allow: { subject: `u:${admin.sId}`, mode: 6 } },
          { allow: { subject: `u:${other.sId}`, mode: 6 } },
          { allow: { subject: "g:group", mode: 6 } },
        ],
      }),
    });

    await conversation.updateRequirements(adminAuth, [restrictedSpace.id]);

    expect(transport.calls.map((c) => c.method)).toEqual([
      "ListGrants",
      "UpdateGrants",
    ]);
    expect(transport.calls[1]?.request).toEqual({
      objectId: { value: Buffer.from(folderId, "hex") },
      changes: [
        {
          grant: { allow: { subject: `u:${other.sId}`, mode: 6 } },
          remove: true,
        },
      ],
    });
  });

  it("leaves the folder of a conversation in a pod alone", async () => {
    const { workspace, user } = await createResourceTest({});
    const pod = await SpaceFactory.project(workspace, user.id);
    // Refreshed so that it includes the new pod's groups.
    const auth = await Authenticator.fromUserIdAndWorkspaceId(
      user.sId,
      workspace.sId
    );
    await FeatureFlagFactory.basic(auth, "dust_file_system");
    const { conversation } = await createConversationWithFolder(auth, {
      spaceModelId: pod.id,
    });
    const { transport } = setup();

    await conversation.updateRequirements(auth, [pod.id]);

    expect(transport.calls).toEqual([]);
  });
});
