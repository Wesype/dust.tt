import {
  canAccessConversation,
  getConversationParticipantGrant,
} from "@app/lib/api/dfs/conversation_grants";
import { updateGrantsInBatches } from "@app/lib/api/dfs/grants";
import {
  createGroupSubject,
  createUserSubject,
} from "@app/lib/api/dfs/sessions";
import type { Authenticator } from "@app/lib/auth";
import type { DfsClient } from "@app/lib/dfs/client";
import type { DfsFileSystem } from "@app/lib/dfs/file_system";
import {
  conversationFolderUri,
  podFolderUri,
  userFolderUri,
} from "@app/lib/dfs/folders";
import { ConversationResource } from "@app/lib/resources/conversation_resource";
import { DfsUserFolderResource } from "@app/lib/resources/dfs_user_folder_resource";
import { SpaceResource } from "@app/lib/resources/space_resource";
import { UserResource } from "@app/lib/resources/user_resource";
import { concurrentExecutor } from "@app/lib/utils/async_utils";
import type { DfsGrant, DfsObjectId } from "@app/types/dfs";
import { DfsError, isDfsObjectId } from "@app/types/dfs";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";
import { removeNulls } from "@app/types/shared/utils/general";

/**
 * @cc [owner:fabiencelier,label:product] folder-mime-types
 * Pod and conversation folders created by `getOrCreatePodFolder` and `getOrCreateConversationFolder`
 * MUST get `DFS_POD_FOLDER_MIME_TYPE` and `DFS_CONVERSATION_FOLDER_MIME_TYPE`, so that clients can
 * recognize them wherever they are. Changing a value leaves existing folders with the previous one.
 */
export const DFS_POD_FOLDER_MIME_TYPE = "application/vnd.dust.pod";
// The pod's actual name, since its folder's name is sanitized (see `podFolderName`).
export const DFS_DISPLAY_NAME_XATTR = "dust.display_name";

export const DFS_CONVERSATION_FOLDER_MIME_TYPE =
  "application/vnd.dust.conversation";

export interface DfsFolderContext {
  // A session of the user the pod and conversation folders are created for (see
  // `createDfsSession`): they are created under that user's folder, which only that user can write.
  fs: DfsFileSystem;
  // A superuser session, only to create user folders, which no grant lets a user create (see
  // `superuser-session-uses`).
  getSuperuserFs: () => Promise<Result<DfsFileSystem, DfsError>>;
  // Authenticated with the tenant key of the authenticated workspace, to set grants.
  tenantClient: Pick<DfsClient, "updateGrants">;
  // The tenant root (`DfsTenantResource.rootId`).
  rootId: DfsObjectId;
}

/** The folder at `uri`, created if missing. `created` is false when it already existed. */
async function ensureFolder(
  fs: DfsFileSystem,
  uri: string,
  options: { mimeType?: string; xattrs?: Record<string, Uint8Array> } = {}
): Promise<Result<{ id: DfsObjectId; created: boolean }, DfsError>> {
  const made = await fs.mkdir(uri, options);
  if (made.isOk()) {
    return realId(made.value.attr.id, true);
  }
  if (made.error.code !== "already_exists") {
    return made;
  }
  const existing = await fs.stat(uri);
  if (existing.isErr()) {
    return existing;
  }
  if (!existing.value) {
    return new Err(new DfsError("not_found", `Not found: ${uri}.`));
  }
  if (existing.value.attr.kind !== "directory") {
    return new Err(new DfsError("not_directory", `Not a folder: ${uri}.`));
  }
  return realId(existing.value.attr.id, false);
}

function realId(
  id: string,
  created: boolean
): Result<{ id: DfsObjectId; created: boolean }, DfsError> {
  return isDfsObjectId(id)
    ? new Ok({ id, created })
    : new Err(new DfsError("invalid_response", "Expected a real object."));
}

/**
 * @cc [owner:fabiencelier,label:backend] stored-folder-first
 * The `getOrCreate*Folder` functions MUST return the stored folder ID when there is one, without
 * calling dfs. Otherwise they MUST create the folder if missing, reuse it if it exists, store its
 * ID unless a concurrent call stored one first, and return the stored ID. Concurrent first calls
 * for the same user folder MAY fail on the unique `(workspaceId, userId)` index instead.
 */

/**
 * The folder of `user` (`users/<userSId>` under the tenant root). A folder created here is only
 * accessible to `user`.
 */
export async function getOrCreateUserFolder(
  auth: Authenticator,
  context: DfsFolderContext,
  user: UserResource
): Promise<Result<DfsObjectId, DfsError>> {
  const stored = await DfsUserFolderResource.fetchByUser(auth, user);
  if (stored) {
    return new Ok(stored.dfsObjectId);
  }
  const superuserFs = await context.getSuperuserFs();
  if (superuserFs.isErr()) {
    return superuserFs;
  }
  const folder = await ensureFolder(
    superuserFs.value,
    userFolderUri(context.rootId, user.sId)
  );
  if (folder.isErr()) {
    return folder;
  }
  if (folder.value.created) {
    const granted = await context.tenantClient.updateGrants({
      objectId: folder.value.id,
      changes: [
        { grant: { type: "deny", mode: 0o6 }, remove: false },
        {
          grant: {
            type: "allow",
            subject: createUserSubject(user),
            mode: 0o6,
          },
          remove: false,
        },
      ],
    });
    if (granted.isErr()) {
      return granted;
    }
  }
  const created = await DfsUserFolderResource.makeNew(auth, {
    user,
    dfsObjectId: folder.value.id,
  });
  return new Ok(created.dfsObjectId);
}

/**
 * The folder of the pod `space`, under the folder of `user`, or of its first editor when no user is
 * given (backfill). `context.fs` MUST be a session of that user.
 */
/**
 * @cc [owner:fabiencelier,label:security] pod-folder-grants
 * The pod folder MUST get, for each group of the pod's grants, an ALLOW with `r` for a `reader`
 * grant and `rw` for any other, mirroring the pod's own access.
 */
export async function getOrCreatePodFolder(
  auth: Authenticator,
  context: DfsFolderContext,
  space: SpaceResource,
  { user }: { user?: UserResource } = {}
): Promise<Result<DfsObjectId, DfsError>> {
  if (!space.isProject()) {
    return new Err(new DfsError("invalid_input", "Only pods have a folder."));
  }
  if (space.dfsObjectId) {
    return new Ok(space.dfsObjectId);
  }
  const owner = user ?? (await getFirstEditor(auth, space));
  if (!owner) {
    return new Err(
      new DfsError("invalid_input", `Pod ${space.sId} has no editor.`)
    );
  }
  const userFolderId = await getOrCreateUserFolder(auth, context, owner);
  if (userFolderId.isErr()) {
    return userFolderId;
  }
  const folder = await ensureFolder(
    context.fs,
    podFolderUri(userFolderId.value, space),
    {
      mimeType: DFS_POD_FOLDER_MIME_TYPE,
      xattrs: { [DFS_DISPLAY_NAME_XATTR]: Buffer.from(space.name, "utf8") },
    }
  );
  if (folder.isErr()) {
    return folder;
  }
  // Attached even when the folder already existed, see `pod-folder-grants`.
  // Later permission changes are reflected by `syncPodFolderGrants`.
  const granted = await context.tenantClient.updateGrants({
    objectId: folder.value.id,
    changes: (await getPodFolderGrants(space)).map((grant) => ({
      grant,
      remove: false,
    })),
  });
  if (granted.isErr()) {
    return granted;
  }
  // A concurrent call may have stored another folder first: return the stored one.
  const stored = await space.setDfsObjectId(auth, folder.value.id);
  if (!stored) {
    return new Err(
      new DfsError("not_found", `Pod ${space.sId} no longer exists.`)
    );
  }
  return new Ok(stored);
}

/** The grants of the pod folder of `space`, see `pod-folder-grants`. */
export async function getPodFolderGrants(
  space: SpaceResource
): Promise<DfsGrant[]> {
  const references = await space.fetchGrantReferences();
  return references.map((reference) => ({
    type: "allow",
    subject: createGroupSubject(reference.groupSId),
    // Only the workspace global group holds a `reader` grant, on open pods.
    mode: reference.isReader() ? 0o4 : 0o6,
  }));
}

async function getFirstEditor(
  auth: Authenticator,
  space: SpaceResource
): Promise<UserResource | null> {
  const editors = await space.fetchActiveEditorUsers(auth);
  return editors.sort((a, b) => a.id - b.id)[0] ?? null;
}

/**
 * The folder of `conversation`: under the folder of the conversation that spawned it for a
 * sub-conversation, else under its pod's folder for a
 * conversation in a pod, else under the folder of `user`, or of its first participant when no user
 * is given (backfill). `context.fs` MUST be a session that can write the parent folder.
 */
/**
 * @cc [owner:fabiencelier,label:security] conversation-folder-grants
 * The folder of a sub-conversation or of a conversation in a pod MUST get no grant: its access is
 * its parent conversation's or pod's folder's. A folder created here for any other conversation
 * MUST get an ALLOW with `rw` for each of its participants for whom `canAccessConversation` holds,
 * and for no other participant. A folder that already existed in dfs MUST be reused without
 * changing its grants.
 */
export async function getOrCreateConversationFolder(
  auth: Authenticator,
  context: DfsFolderContext,
  conversation: ConversationResource,
  { user }: { user?: UserResource } = {}
): Promise<Result<DfsObjectId, DfsError>> {
  if (conversation.dfsObjectId) {
    return new Ok(conversation.dfsObjectId);
  }
  const parent = await getOrCreateConversationParentFolder(
    auth,
    context,
    conversation,
    { user }
  );
  if (parent.isErr()) {
    return parent;
  }
  const folder = await ensureFolder(
    context.fs,
    conversationFolderUri(parent.value.id, conversation.sId),
    { mimeType: DFS_CONVERSATION_FOLDER_MIME_TYPE }
  );
  if (folder.isErr()) {
    return folder;
  }
  // A concurrent call may have stored another folder first: return the stored one.
  const stored = await conversation.setDfsObjectId(auth, folder.value.id);
  if (!stored) {
    return new Err(
      new DfsError(
        "not_found",
        `Conversation ${conversation.sId} no longer exists.`
      )
    );
  }
  // Only on a folder created here, see `conversation-folder-grants`.
  const participants =
    parent.value.inheritsAccess || !folder.value.created
      ? []
      : await getEligibleParticipants(auth, conversation);
  if (participants.length > 0) {
    const granted = await updateGrantsInBatches(context.tenantClient, {
      objectId: stored,
      changes: participants.map((participant) => ({
        grant: getConversationParticipantGrant(participant),
        remove: false,
      })),
    });
    if (granted.isErr()) {
      return granted;
    }
  }
  return new Ok(stored);
}

/**
 * The folder holding the folder of `conversation`. `inheritsAccess` is true when the conversation's
 * access is that folder's (a parent conversation's or a pod's), see `conversation-folder-grants`.
 */
async function getOrCreateConversationParentFolder(
  auth: Authenticator,
  context: DfsFolderContext,
  conversation: ConversationResource,
  { user }: { user?: UserResource }
): Promise<Result<{ id: DfsObjectId; inheritsAccess: boolean }, DfsError>> {
  if (conversation.depth > 0) {
    const parent = await conversation.fetchParentConversation(auth);
    if (!parent) {
      return new Err(
        new DfsError(
          "invalid_input",
          `Sub-conversation ${conversation.sId} has no parent conversation.`
        )
      );
    }
    const parentId = await getOrCreateConversationFolder(
      auth,
      context,
      parent,
      { user }
    );
    return parentId.isErr()
      ? parentId
      : new Ok({ id: parentId.value, inheritsAccess: true });
  }
  const pod = await getConversationPod(auth, conversation);
  const parentId = pod
    ? await getOrCreatePodFolder(auth, context, pod, { user })
    : await getOrCreateConversationOwnerFolder(auth, context, conversation, {
        user,
      });
  return parentId.isErr()
    ? parentId
    : new Ok({ id: parentId.value, inheritsAccess: pod !== null });
}

/** The pod `conversation` is in, if any. Its folder's access is then driven by the pod's. */
async function getConversationPod(
  auth: Authenticator,
  conversation: ConversationResource
): Promise<SpaceResource | null> {
  if (!conversation.spaceId) {
    return null;
  }
  const [space] = await SpaceResource.fetchByModelIds(auth, [
    conversation.spaceId,
  ]);
  return space?.isProject() ? space : null;
}

async function getOrCreateConversationOwnerFolder(
  auth: Authenticator,
  context: DfsFolderContext,
  conversation: ConversationResource,
  { user }: { user?: UserResource }
): Promise<Result<DfsObjectId, DfsError>> {
  if (user) {
    return getOrCreateUserFolder(auth, context, user);
  }
  const owner = await fetchConversationOwner(auth, conversation);
  if (!owner) {
    return new Err(
      new DfsError(
        "invalid_input",
        `Conversation ${conversation.sId} has no participant.`
      )
    );
  }
  return getOrCreateUserFolder(auth, context, owner);
}

/**
 * The owner of `conversation`, whose user folder holds its folder when it is created without a
 * user: its first participant who can still access it, since losing access to a requested space
 * keeps the participant row. Null without such a participant.
 */
export async function fetchConversationOwner(
  auth: Authenticator,
  conversation: ConversationResource
): Promise<UserResource | null> {
  const participants = await ConversationResource.listParticipantDetails(
    auth,
    conversation
  );
  // Sequential on purpose: the first participant is usually the owner, so this stops after one
  // access check.
  for (const participant of participants) {
    const user = await UserResource.fetchByModelId(participant.userId);
    if (!user) {
      continue;
    }
    if (await canAccessConversation(auth, conversation, user.sId)) {
      return user;
    }
  }
  return null;
}

/**
 * The participants of `conversation` who can still access it, first participant first: losing
 * access to a requested space keeps the participant row.
 */
async function getEligibleParticipants(
  auth: Authenticator,
  conversation: ConversationResource
): Promise<UserResource[]> {
  const participants = await getParticipants(auth, conversation);
  const accesses = await concurrentExecutor(
    participants,
    (participant) => canAccessConversation(auth, conversation, participant.sId),
    { concurrency: 4 }
  );
  return participants.filter((_, i) => accesses[i]);
}

/** The participants of `conversation`, first participant first. */
async function getParticipants(
  auth: Authenticator,
  conversation: ConversationResource
): Promise<UserResource[]> {
  const details = await ConversationResource.listParticipantDetails(
    auth,
    conversation
  );
  const users = await UserResource.fetchByModelIds(
    details.map((d) => d.userId)
  );
  const usersById = new Map(users.map((u) => [u.id, u]));
  return removeNulls(details.map((d) => usersById.get(d.userId) ?? null));
}
