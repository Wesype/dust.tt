import { withDfsFolderContext } from "@app/lib/api/dfs/folder_context";
import type { DfsFolderContext } from "@app/lib/api/dfs/folders";
import { fetchConversationOwner } from "@app/lib/api/dfs/folders";
import { listAllowModes } from "@app/lib/api/dfs/grants";
import { parseUserSubject } from "@app/lib/api/dfs/sessions";
import type { Authenticator } from "@app/lib/auth";
import { hasFeatureFlag } from "@app/lib/auth";
import type { DfsClient } from "@app/lib/dfs/client";
import { formatDfsUri } from "@app/lib/dfs/uri";
import type { ConversationResource } from "@app/lib/resources/conversation_resource";
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
import { removeNulls } from "@app/types/shared/utils/general";
import { toLightUser } from "@app/types/user";

export type ConversationSharingErrorType =
  | "sharing_not_enabled"
  | "not_supported_in_pod"
  | "sharing_unavailable"
  | "not_shared"
  | "dfs_error";

export class ConversationSharingError extends Error {
  constructor(
    readonly type: ConversationSharingErrorType,
    message: string
  ) {
    super(message);
  }
}

type FolderContext = DfsFolderContext & { tenantClient: DfsClient };

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
