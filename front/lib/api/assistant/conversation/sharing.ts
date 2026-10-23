import { withDfsFolderContext } from "@app/lib/api/dfs/folder_context";
import type { DfsFolderContext } from "@app/lib/api/dfs/folders";
import { fetchConversationOwner } from "@app/lib/api/dfs/folders";
import { listAllowModes, setSubjectGrants } from "@app/lib/api/dfs/grants";
import { createUserSubject, parseUserSubject } from "@app/lib/api/dfs/sessions";
import type { Authenticator } from "@app/lib/auth";
import { hasFeatureFlag } from "@app/lib/auth";
import type { DfsClient } from "@app/lib/dfs/client";
import { formatDfsUri } from "@app/lib/dfs/uri";
import type { ConversationResource } from "@app/lib/resources/conversation_resource";
import { MembershipResource } from "@app/lib/resources/membership_resource";
import { UserResource } from "@app/lib/resources/user_resource";
import type {
  ConversationSharingPermission,
  ConversationSharingType,
} from "@app/types/assistant/conversation_sharing";
import type { DfsError, DfsObjectId } from "@app/types/dfs";
import {
  DFS_READ_MODE,
  DFS_READ_WRITE_MODE,
  isDfsObjectId,
} from "@app/types/dfs";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";
import { assertNever } from "@app/types/shared/utils/assert_never";
import { removeNulls } from "@app/types/shared/utils/general";
import { toLightUser } from "@app/types/user";

function getPermissionMode(
  permission: ConversationSharingChange["permission"]
): number | null {
  switch (permission) {
    case "none":
      return null;
    case "read":
      return DFS_READ_MODE;
    case "write":
      return DFS_READ_WRITE_MODE;
    default:
      assertNever(permission);
  }
}

export type ConversationSharingErrorType =
  | "sharing_not_enabled"
  | "not_supported_in_pod"
  | "sharing_unavailable"
  | "not_shared"
  | "not_allowed"
  | "user_not_found"
  | "user_not_member"
  | "owner_not_editable"
  | "dfs_error";

export class ConversationSharingError extends Error {
  constructor(
    readonly type: ConversationSharingErrorType,
    message: string
  ) {
    super(message);
  }
}

export interface ConversationSharingChange {
  userId: string;
  permission: ConversationSharingPermission | "none";
}

type FolderContext = DfsFolderContext & { tenantClient: DfsClient };

// The outcome of a sharing update, run with the authenticated user's folder context.
type SharingUpdate =
  | { type: "rejected"; error: ConversationSharingError }
  | { type: "updated"; sharing: ConversationSharingType | null };

/**
 * The folder whose grants decide who can access `conversation`: only conversations outside pods,
 * with a folder, in workspaces with `dfs_conversation_sharing`.
 */
async function getShareableFolderId(
  auth: Authenticator,
  conversation: ConversationResource
): Promise<Result<DfsObjectId, ConversationSharingError>> {
  const enabled = await hasFeatureFlag(auth, "dfs_conversation_sharing");
  if (!enabled) {
    return new Err(
      new ConversationSharingError(
        "sharing_not_enabled",
        "Conversation sharing is not enabled for this workspace."
      )
    );
  }
  if (conversation.space?.isProject()) {
    return new Err(
      new ConversationSharingError(
        "not_supported_in_pod",
        "Conversations in a Pod are shared through the Pod's members."
      )
    );
  }
  const folderId = conversation.dfsObjectId;
  if (!folderId || !isDfsObjectId(folderId)) {
    return new Err(
      new ConversationSharingError(
        "sharing_unavailable",
        "This conversation has no folder to share yet."
      )
    );
  }
  return new Ok(folderId);
}

/** The permission of each user with an ALLOW on the folder, from `listAllowModes`. */
function getUserPermissions(
  allowModes: Map<string, number>
): Map<string, ConversationSharingPermission> {
  const permissions = new Map<string, ConversationSharingPermission>();
  for (const [subject, mode] of allowModes) {
    const userId = parseUserSubject(subject);
    if (!userId) {
      continue;
    }
    if ((mode & DFS_READ_WRITE_MODE) === DFS_READ_WRITE_MODE) {
      permissions.set(userId, "write");
    } else if (mode & DFS_READ_MODE) {
      permissions.set(userId, "read");
    }
  }
  return permissions;
}

/**
 * The sharing of the folder `folderId`, as seen by the session of `context.fs`, or null when that
 * session can't read the folder.
 */
/**
 * @cc [owner:aubin-tchoi,label:security] sharing-requires-read
 * The sharing MUST only be returned when the session of `context.fs` can read the folder. Otherwise
 * this MUST return null without listing the folder's grants with the tenant key.
 */
async function readSharing(
  context: FolderContext,
  folderId: DfsObjectId,
  owner: UserResource | null
): Promise<Result<ConversationSharingType | null, DfsError>> {
  const folderPermissions = await context.fs.permissions(
    formatDfsUri(folderId)
  );
  if (folderPermissions.isErr()) {
    return folderPermissions;
  }
  if (!folderPermissions.value.read) {
    return new Ok(null);
  }
  const allowModes = await listAllowModes(context.tenantClient, {
    objectId: folderId,
  });
  if (allowModes.isErr()) {
    return allowModes;
  }
  const permissions = getUserPermissions(allowModes.value);
  if (owner) {
    permissions.delete(owner.sId);
  }
  const users = await UserResource.fetchByIds([...permissions.keys()]);
  return new Ok({
    canManage: folderPermissions.value.write,
    owner: owner ? toLightUser(owner.toJSON()) : null,
    members: removeNulls(
      users.map((user) => {
        const permission = permissions.get(user.sId);
        return permission
          ? { user: toLightUser(user.toJSON()), permission }
          : null;
      })
    ),
  });
}

function dfsFailure(error: Error): ConversationSharingError {
  return new ConversationSharingError(
    "dfs_error",
    `Failed to access the conversation's folder: ${error.message}`
  );
}

/**
 * Who `conversation` is shared with, from the grants of its folder (see
 * `front/design-docs/SHARING.md`).
 */
export async function getConversationSharing(
  auth: Authenticator,
  conversation: ConversationResource
): Promise<Result<ConversationSharingType, ConversationSharingError>> {
  const folderId = await getShareableFolderId(auth, conversation);
  if (folderId.isErr()) {
    return folderId;
  }
  const owner = await fetchConversationOwner(auth, conversation);
  const read = await withDfsFolderContext(
    auth,
    { allowSuperuser: false },
    (context) => readSharing(context, folderId.value, owner)
  );
  if (read.isErr()) {
    return new Err(dfsFailure(read.error));
  }
  if (!read.value) {
    return new Err(
      new ConversationSharingError(
        "not_shared",
        "This conversation isn't shared with you."
      )
    );
  }
  return new Ok(read.value);
}

/**
 * The users of `changes` with their requested permission, failing when one is the conversation's
 * `owner`, doesn't exist, or would be granted access without being an active member.
 */
async function getUserChanges(
  auth: Authenticator,
  {
    owner,
    changes,
  }: { owner: UserResource | null; changes: ConversationSharingChange[] }
): Promise<
  Result<
    {
      user: UserResource;
      permission: ConversationSharingChange["permission"];
    }[],
    ConversationSharingError
  >
> {
  if (owner && changes.some((change) => change.userId === owner.sId)) {
    return new Err(
      new ConversationSharingError(
        "owner_not_editable",
        "The access of the conversation's owner can't be changed."
      )
    );
  }

  const users = await UserResource.fetchByIds(
    changes.map((change) => change.userId)
  );
  const usersById = new Map(users.map((user) => [user.sId, user]));
  const userChanges = removeNulls(
    changes.map((change) => {
      const user = usersById.get(change.userId);
      return user ? { user, permission: change.permission } : null;
    })
  );
  if (userChanges.length !== changes.length) {
    return new Err(
      new ConversationSharingError("user_not_found", "User not found.")
    );
  }
  // Removing access needs no membership: former members' grants can be removed.
  const grantedUsers = userChanges
    .filter((change) => change.permission !== "none")
    .map((change) => change.user);
  if (grantedUsers.length > 0) {
    const { memberships } = await MembershipResource.getActiveMemberships({
      users: grantedUsers,
      workspace: auth.getNonNullableWorkspace(),
    });
    const memberUserModelIds = new Set(memberships.map((m) => m.userId));
    if (grantedUsers.some((user) => !memberUserModelIds.has(user.id))) {
      return new Err(
        new ConversationSharingError(
          "user_not_member",
          "Conversations can only be shared with members of the workspace."
        )
      );
    }
  }
  return new Ok(userChanges);
}

/**
 * Gives each user of `changes` the requested permission on `conversation`, or removes their access
 * with `none`, by updating the grants of its folder. Returns the updated sharing, or null when the
 * authenticated user can't read the folder anymore (e.g. they removed their own access).
 */
/**
 * @cc [owner:aubin-tchoi,label:security] sharing-requires-write
 * Grants MUST only change when the authenticated user's own session can read and write the
 * conversation's folder (owner or `rw` grant); otherwise this MUST fail with `not_allowed`, before
 * any check of `changes`, without changing any grant.
 */
/**
 * @cc [owner:aubin-tchoi,label:security] sharing-only-members
 * A permission other than `none` MUST only be granted to active members of the workspace. The
 * owner's access MUST NOT be changed: their access comes from their user folder.
 */
/**
 * @cc [owner:aubin-tchoi,label:product] sharing-exact-permission
 * The grants MUST be set with one `setSubjectGrants` call giving each user of `changes` `r` for
 * `read`, `rw` for `write` and no grant for `none`.
 */
export async function updateConversationSharing(
  auth: Authenticator,
  conversation: ConversationResource,
  changes: ConversationSharingChange[]
): Promise<Result<ConversationSharingType | null, ConversationSharingError>> {
  const folderId = await getShareableFolderId(auth, conversation);
  if (folderId.isErr()) {
    return folderId;
  }
  const owner = await fetchConversationOwner(auth, conversation);

  const updated = await withDfsFolderContext(
    auth,
    { allowSuperuser: false },
    async (context): Promise<Result<SharingUpdate, Error>> => {
      const folderPermissions = await context.fs.permissions(
        formatDfsUri(folderId.value)
      );
      if (folderPermissions.isErr()) {
        return folderPermissions;
      }
      if (!folderPermissions.value.read || !folderPermissions.value.write) {
        return new Ok({
          type: "rejected",
          error: new ConversationSharingError(
            "not_allowed",
            "Only people who can participate in this conversation can change who it's shared with."
          ),
        });
      }
      const userChanges = await getUserChanges(auth, { owner, changes });
      if (userChanges.isErr()) {
        return new Ok({ type: "rejected", error: userChanges.error });
      }
      const set = await setSubjectGrants(context.tenantClient, {
        objectId: folderId.value,
        changes: userChanges.value.map((change) => ({
          subject: createUserSubject(change.user),
          mode: getPermissionMode(change.permission),
        })),
      });
      if (set.isErr()) {
        return set;
      }
      // Null when the update removed the caller's own read access, or another call did.
      const sharing = await readSharing(context, folderId.value, owner);
      if (sharing.isErr()) {
        return sharing;
      }
      return new Ok({ type: "updated", sharing: sharing.value });
    }
  );
  if (updated.isErr()) {
    return new Err(dfsFailure(updated.error));
  }
  if (updated.value.type === "rejected") {
    return new Err(updated.value.error);
  }

  return new Ok(updated.value.sharing);
}
