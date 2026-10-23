import { importGcsPodConversationFile } from "@app/lib/api/dfs/gcs_import/pod_conversation";
import { importGcsStandaloneConversationFile } from "@app/lib/api/dfs/gcs_import/standalone_conversation";
import type { GcsReplicationSource } from "@app/lib/api/dfs/gcs_notifications";
import { Authenticator } from "@app/lib/auth";
import { ConversationResource } from "@app/lib/resources/conversation_resource";
import { UserResource } from "@app/lib/resources/user_resource";
import { concurrentExecutor } from "@app/lib/utils/async_utils";
import type { Logger } from "@app/logger/logger";
import type { DfsBackfillCounts } from "@app/scripts/dfs/backfill_helpers";
import {
  getFirstEditor,
  listGcsReplicationSources,
  listGcsResourceIds,
  withGcsImportContext,
} from "@app/scripts/dfs/backfill_helpers";
import { makeScript } from "@app/scripts/helpers";
import { runOnAllWorkspaces } from "@app/scripts/workspace_helpers";
import type { ModelId } from "@app/types/shared/model_id";
import { Ok } from "@app/types/shared/result";
import { removeNulls } from "@app/types/shared/utils/general";
import type { LightWorkspaceType } from "@app/types/user";
import chunk from "lodash/chunk";

const CONCURRENCY_DEFAULT = 4;
const CONVERSATION_BATCH_SIZE = 128;
const GCS_LIST_CONCURRENCY = 16;

interface ConversationImporter {
  kind: "pod" | "standalone";
  user: UserResource;
}

/**
 * The importer of the files of `conversation` and the user to run it as: the pod's first editor for
 * a pod conversation (the default owner of the pod folder), the creator for a root conversation
 * outside pods (see `gcs-standalone-conversation-access`). Null when the importers would reject the
 * conversation.
 */
async function getConversationImporter(
  auth: Authenticator,
  conversation: ConversationResource,
  firstEditorsByPodId: Map<ModelId, UserResource | null>
): Promise<ConversationImporter | null> {
  if (conversation.spaceId !== null) {
    const pod = conversation.space;
    const editor = pod?.isProject() ? firstEditorsByPodId.get(pod.id) : null;
    return editor ? { kind: "pod", user: editor } : null;
  }
  const [creator] = await ConversationResource.listParticipantDetails(
    auth,
    conversation
  );
  if (!creator) {
    return null;
  }
  const user = await UserResource.fetchByModelId(creator.userId);
  return user ? { kind: "standalone", user } : null;
}

// `sources` are the files of the GCS folder `conversationId`. `conversation` is null when no
// conversation of the workspace has that ID.
async function backfillConversationFiles(
  auth: Authenticator,
  {
    conversationId,
    conversation,
    sources,
    firstEditorsByPodId,
  }: {
    conversationId: string;
    conversation: ConversationResource | null;
    sources: GcsReplicationSource[];
    firstEditorsByPodId: Map<ModelId, UserResource | null>;
  },
  { execute, logger }: { execute: boolean; logger: Logger }
): Promise<DfsBackfillCounts> {
  const workspaceId = auth.getNonNullableWorkspace().sId;
  if (sources.length === 0) {
    return { imported: 0, failed: 0, skipped: 0 };
  }

  if (!conversation) {
    logger.info(
      { workspaceId, conversationId, files: sources.length },
      "[backfill_dfs_conversation_files] Conversation not found, skipping"
    );
    return { imported: 0, failed: 0, skipped: sources.length };
  }
  const importer = await getConversationImporter(
    auth,
    conversation,
    firstEditorsByPodId
  );
  if (!importer) {
    logger.info(
      { workspaceId, conversationId, files: sources.length },
      "[backfill_dfs_conversation_files] Conversation not importable, skipping"
    );
    return { imported: 0, failed: 0, skipped: sources.length };
  }
  const userAuth = await Authenticator.fromUserIdAndWorkspaceId(
    importer.user.sId,
    workspaceId
  );
  if (!userAuth.isUser()) {
    logger.info(
      { workspaceId, conversationId, files: sources.length },
      "[backfill_dfs_conversation_files] Owner not a workspace member, skipping"
    );
    return { imported: 0, failed: 0, skipped: sources.length };
  }

  if (!execute) {
    for (const { objectName } of sources) {
      logger.info(
        { workspaceId, conversationId, kind: importer.kind, objectName },
        "[backfill_dfs_conversation_files] Would import file (dry-run)"
      );
    }
    return { imported: sources.length, failed: 0, skipped: 0 };
  }

  const importFile =
    importer.kind === "pod"
      ? importGcsPodConversationFile
      : importGcsStandaloneConversationFile;
  const counts = await withGcsImportContext(userAuth, async (context) => {
    let imported = 0;
    let failed = 0;
    for (const source of sources) {
      const res = await importFile(userAuth, source, context);
      if (res.isErr()) {
        logger.error(
          {
            workspaceId,
            conversationId,
            objectName: source.objectName,
            err: res.error,
          },
          "[backfill_dfs_conversation_files] Failed to import file"
        );
        failed++;
        continue;
      }
      imported++;
    }
    return new Ok({ imported, failed, skipped: 0 });
  });
  if (counts.isErr()) {
    logger.error(
      { workspaceId, conversationId, err: counts.error },
      "[backfill_dfs_conversation_files] Failed to open the dfs sessions"
    );
    return { imported: 0, failed: sources.length, skipped: 0 };
  }
  return counts.value;
}

async function backfillWorkspace(
  workspace: LightWorkspaceType,
  { execute, logger }: { execute: boolean; logger: Logger }
): Promise<void> {
  const workspaceId = workspace.sId;
  const auth = await Authenticator.internalAdminForWorkspace(workspaceId);

  const replicationEnabled = await auth.hasFeatureFlag("dfs_gcs_replication");
  if (!replicationEnabled) {
    logger.info(
      { workspaceId },
      "[backfill_dfs_conversation_files] Replication disabled, skipping workspace"
    );
    return;
  }

  const conversationIds = await listGcsResourceIds(
    workspaceId,
    "conversations"
  );
  const counts: DfsBackfillCounts = { imported: 0, failed: 0, skipped: 0 };
  for (const batchIds of chunk(conversationIds, CONVERSATION_BATCH_SIZE)) {
    // The importers check the access of the user they run as.
    const conversations = await ConversationResource.fetchByIds(
      auth,
      batchIds,
      { dangerouslySkipPermissionFiltering: true }
    );
    // Sub-conversations are not backfilled.
    const subConversationIds = new Set(
      conversations.filter((c) => c.depth !== 0).map((c) => c.sId)
    );
    const rootConversations = conversations.filter((c) => c.depth === 0);
    const backfilledIds = batchIds.filter(
      (conversationId) => !subConversationIds.has(conversationId)
    );
    const conversationsById = new Map(rootConversations.map((c) => [c.sId, c]));
    const pods = [
      ...new Map(
        removeNulls(rootConversations.map((c) => c.space)).map((pod) => [
          pod.id,
          pod,
        ])
      ).values(),
    ];
    const firstEditors = await concurrentExecutor(
      pods,
      (pod) => getFirstEditor(auth, pod),
      { concurrency: 8 }
    );
    const firstEditorsByPodId = new Map(
      pods.map((pod, i) => [pod.id, firstEditors[i]])
    );
    // Listing is read-only and runs concurrently, unlike the imports below.
    const sourcesByBatchIndex = await concurrentExecutor(
      backfilledIds,
      (conversationId) =>
        listGcsReplicationSources(workspaceId, "conversations", conversationId),
      { concurrency: GCS_LIST_CONCURRENCY }
    );

    // One conversation at a time: concurrent first imports may fail creating the workspace's dfs
    // tenant or a user folder (see `stored-folder-first`).
    for (const [i, conversationId] of backfilledIds.entries()) {
      const conversationCounts = await backfillConversationFiles(
        auth,
        {
          conversationId,
          conversation: conversationsById.get(conversationId) ?? null,
          sources: sourcesByBatchIndex[i],
          firstEditorsByPodId,
        },
        { execute, logger }
      );
      counts.imported += conversationCounts.imported;
      counts.failed += conversationCounts.failed;
      counts.skipped += conversationCounts.skipped;
    }
  }

  logger.info(
    { workspaceId, ...counts, execute },
    "[backfill_dfs_conversation_files] Workspace done"
  );
}

makeScript(
  {
    wId: {
      type: "string",
      describe: "Workspace ID to backfill (omit to run on all workspaces).",
    },
    fromWorkspaceModelId: {
      type: "number",
      describe:
        "Skip workspaces with model id below this value (for resuming).",
    },
    concurrency: {
      type: "number",
      default: CONCURRENCY_DEFAULT,
      describe: "Workspaces backfilled concurrently.",
    },
  },
  async ({ execute, wId, fromWorkspaceModelId, concurrency }, logger) => {
    await runOnAllWorkspaces(
      (workspace) => backfillWorkspace(workspace, { execute, logger }),
      { wId, fromWorkspaceId: fromWorkspaceModelId, concurrency }
    );
  }
);
