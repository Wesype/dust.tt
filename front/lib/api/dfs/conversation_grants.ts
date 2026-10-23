import { getDfsTenantClient } from "@app/lib/api/dfs/clients";
import { listAllGrants, updateGrantsInBatches } from "@app/lib/api/dfs/grants";
import { createUserSubject, parseUserSubject } from "@app/lib/api/dfs/sessions";
import { Authenticator, hasFeatureFlag } from "@app/lib/auth";
import type { DfsClient } from "@app/lib/dfs/client";
import type { ConversationResource } from "@app/lib/resources/conversation_resource";
import type { UserResource } from "@app/lib/resources/user_resource";
import { concurrentExecutor } from "@app/lib/utils/async_utils";
import logger from "@app/logger/logger";
import type { DfsGrant, DfsGrantUpdate, DfsObjectId } from "@app/types/dfs";
import type { Result } from "@app/types/shared/result";
import { Ok } from "@app/types/shared/result";
import { removeNulls } from "@app/types/shared/utils/general";

/** The grant of a participant of a conversation outside pods, see `conversation-folder-grants`. */
export function getConversationParticipantGrant(user: UserResource): DfsGrant {
  return { type: "allow", subject: createUserSubject(user), mode: 0o6 };
}

/** Whether the folder of `conversation` has grants of its own, rather than inheriting them. */
function conversationHasIndividualGrants(
  conversation: ConversationResource
): boolean {
  return (
    // In a pod, its access is the pod folder's.
    conversation.spaceId === null &&
    // A sub-conversation's access is its parent conversation's folder's.
    conversation.depth === 0
  );
}

/**
 * @cc [owner:fabiencelier,label:security] conversation-folder-grants-sync
 * With the `dust_file_system` feature flag, on the folder of a conversation outside pods, `user`
 * MUST end up with an ALLOW with `rw` if they participate in the conversation and
 * `canAccessConversation` holds for them when the call reads it, and without it otherwise. It MUST
 * be called with `conversation` read once the participation change is committed, including for a
 * soft-deleted conversation. When its requested spaces change, every user grant attached to its
 * folder whose user fails `canAccessConversation` MUST be detached, and no grant MUST be attached.
 * A conversation without a folder, in a pod or a sub-conversation is left alone. A dfs failure is
 * logged and does not fail the caller.
 */
/**
 * Matches the grant of `user` on the folder of `conversation` with their current participation and
 * access, after they were added to or left the conversation.
 */
export async function reflectConversationParticipationOnDfs(
  auth: Authenticator,
  {
    conversation,
    user,
  }: {
    conversation: ConversationResource;
    user: UserResource;
  }
): Promise<void> {
  await updateConversationFolderGrants(
    auth,
    conversation,
    // Read right before the update, so that an addition and a departure racing each other end on
    // the latest participation.
    async () =>
      new Ok([
        {
          grant: getConversationParticipantGrant(user),
          remove: !(
            (await conversation.isParticipant(auth, user)) &&
            (await canAccessConversation(auth, conversation, user.sId))
          ),
        },
      ])
  );
}

/**
 * Detaches the user grants of the folder of `conversation`, whose requested spaces just changed,
 * whose user can no longer access the conversation (see `conversation-folder-grants-sync`).
 * `conversation` MUST be read once the new requirements are committed.
 */
export async function reflectConversationRequirementsOnDfs(
  auth: Authenticator,
  { conversation }: { conversation: ConversationResource }
): Promise<void> {
  await updateConversationFolderGrants(
    auth,
    conversation,
    async (tenantClient, folderId) => {
      const grants = await listAllGrants(tenantClient, { objectId: folderId });
      return grants.isErr()
        ? grants
        : new Ok(await getGrantsToRevoke(auth, conversation, grants.value));
    }
  );
}

/** The user grants among `grants` whose user fails `canAccessConversation`. */
async function getGrantsToRevoke(
  auth: Authenticator,
  conversation: ConversationResource,
  grants: DfsGrant[]
): Promise<DfsGrantUpdate[]> {
  const revoked = await concurrentExecutor(
    grants,
    async (grant): Promise<DfsGrantUpdate | null> => {
      const userId =
        grant.type === "allow" ? parseUserSubject(grant.subject) : null;
      if (!userId) {
        return null;
      }
      return (await canAccessConversation(auth, conversation, userId))
        ? null
        : { grant, remove: true };
    },
    { concurrency: 8 }
  );
  return removeNulls(revoked);
}

/**
 * Whether the user `userId` may have access to the folder of `conversation`, outside pods: when
 * `ConversationResource.canAccess` returns `allowed` for them, and only then.
 */
export async function canAccessConversation(
  auth: Authenticator,
  conversation: ConversationResource,
  userId: string
): Promise<boolean> {
  const userAuth = await Authenticator.fromUserIdAndWorkspaceId(
    userId,
    auth.getNonNullableWorkspace().sId
  );
  return (await conversation.getAccess(userAuth)) === "allowed";
}

type GetGrantChanges = (
  tenantClient: DfsClient,
  folderId: DfsObjectId
) => Promise<Result<DfsGrantUpdate[], Error>>;

/**
 * Applies the grant changes returned by `getChanges` to the folder of `conversation`, when the
 * workspace has the `dust_file_system` feature flag, the conversation has a folder, and that folder
 * has grants of its own (see `conversationHasIndividualGrants`). A failure is logged.
 */
async function updateConversationFolderGrants(
  auth: Authenticator,
  conversation: ConversationResource,
  getChanges: GetGrantChanges
): Promise<void> {
  const folderId = conversation.dfsObjectId;
  if (
    !folderId ||
    !conversationHasIndividualGrants(conversation) ||
    !(await hasFeatureFlag(auth, "dust_file_system"))
  ) {
    return;
  }
  const updated = await applyGrantChanges(auth, folderId, getChanges);
  if (updated.isErr()) {
    logger.error(
      {
        workspaceId: auth.getNonNullableWorkspace().sId,
        conversationId: conversation.sId,
        err: updated.error,
      },
      "Failed to update conversation folder grants on dfs."
    );
  }
}

async function applyGrantChanges(
  auth: Authenticator,
  folderId: DfsObjectId,
  getChanges: GetGrantChanges
): Promise<Result<void, Error>> {
  const tenantClient = await getDfsTenantClient(auth);
  if (tenantClient.isErr()) {
    return tenantClient;
  }
  const changes = await getChanges(tenantClient.value, folderId);
  if (changes.isErr()) {
    return changes;
  }
  return updateGrantsInBatches(tenantClient.value, {
    objectId: folderId,
    changes: changes.value,
  });
}
