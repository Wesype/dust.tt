import { enterFrameDraftMode } from "@app/lib/api/frames/draft_mode";
import type { FramePublicationFunctionArtifact } from "@app/lib/api/frames/publication_storage";
import {
  createFramePublicationFunctionRows,
  publishFramePublication,
  storeFramePublication,
} from "@app/lib/api/frames/publication_storage";
import { Authenticator } from "@app/lib/auth";
import type { FileResource } from "@app/lib/resources/file_resource";
import { SandboxFunctionResource } from "@app/lib/resources/sandbox_function_resource";
import { FramePublicationModel } from "@app/lib/resources/storage/models/frame_publication";
import { withTransaction } from "@app/lib/utils/sql_utils";
import { ConversationFactory } from "@app/tests/utils/ConversationFactory";
import { FeatureFlagFactory } from "@app/tests/utils/FeatureFlagFactory";
import { FileFactory } from "@app/tests/utils/FileFactory";
import { createTestConversationFrameFile } from "@app/tests/utils/FrameFunctionFactory";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
import { MembershipFactory } from "@app/tests/utils/MembershipFactory";
import { fileStorageMock } from "@app/tests/utils/mocks/file_storage";
import { UserFactory } from "@app/tests/utils/UserFactory";
import type { FrameScheduleManifest } from "@app/types/api/frame_manifest";
import {
  FRAME_MANIFEST_FILE,
  FrameManifestSchema,
  parseFrameManifest,
} from "@app/types/api/frame_manifest";
import type { FramePublishMode } from "@app/types/api/frame_publication";
import type { SandboxFunctionUserIdentityPolicy } from "@app/types/api/sandbox_functions";
import { GLOBAL_AGENTS_SID } from "@app/types/assistant/assistant";
import {
  contentTypeFromFileName,
  DEFAULT_FILE_CONTENT_TYPE,
  frameV2ContentType,
} from "@app/types/files";
import { getConversationFilesBasePath } from "@app/types/mount_path";
import type { WhitelistableFeature } from "@app/types/shared/feature_flags";
import { ONE_DAY_MS } from "@app/types/shared/utils/date_utils";
import assert from "assert";
import type { JSONSchema7 as JSONSchema } from "json-schema";

const inputSchema: JSONSchema = { type: "object" };
const outputSchema: JSONSchema = { type: "object" };

const TEST_PUBLICATION_FUNCTION_NAME = "add-task";
const TEST_PUBLICATION_FUNCTION_CODE = "export async function run() {}";

const testPublicationManifest = FrameManifestSchema.parse({
  version: 1,
  description: "Track tasks.",
  functions: [
    {
      name: TEST_PUBLICATION_FUNCTION_NAME,
      description: "Add a task.",
      entryPoint: "functions/add_task.ts",
    },
  ],
});

/**
 * Store a one-function publication of `frame` the way publishing does (against the global
 * `fileStorageMock`), then move its `frame_publications` row's `createdAt` back by
 * `publishedDaysAgo`: storing always stamps now, and retention reads the age from that row.
 * Returns the publication id; the caller activates it if it should be the frame's active one.
 *
 * Lives apart from `FrameFunctionFactory` on purpose: this is the one Frame fixture that pulls the
 * real publish pipeline — and with it `@app/lib/api/viz/authorized_file_access` — into a suite's
 * module graph. A suite that mocks anything in that graph and imports the factory only for an
 * unrelated Frame helper would otherwise fail to initialize.
 */
export async function storeTestFramePublication(
  auth: Authenticator,
  frame: FileResource,
  {
    publishedDaysAgo,
    withFunctionRows = true,
  }: { publishedDaysAgo: number; withFunctionRows?: boolean }
): Promise<string> {
  const stored = await storeFramePublication(auth, {
    frame,
    functionArtifacts: [
      {
        name: TEST_PUBLICATION_FUNCTION_NAME,
        bundleCode: TEST_PUBLICATION_FUNCTION_CODE,
        userIdentity: "optional",
        inputSchema,
        outputSchema,
      },
    ],
    manifest: testPublicationManifest,
    sourceFiles: [
      {
        relativePath: "index.tsx",
        content: Buffer.from("export default function App() {}"),
        contentType: "text/typescript",
      },
      {
        relativePath: "functions/add_task.ts",
        content: Buffer.from(TEST_PUBLICATION_FUNCTION_CODE),
        contentType: "text/typescript",
      },
    ],
    uiBundleCode: "export default function App() {}",
  });
  if (stored.isErr()) {
    throw stored.error;
  }
  const { publicationId } = stored.value;

  await FramePublicationModel.update(
    { createdAt: new Date(Date.now() - publishedDaysAgo * ONE_DAY_MS) },
    {
      where: {
        workspaceId: auth.getNonNullableWorkspace().id,
        fileId: frame.id,
        publicationId,
      },
    }
  );

  if (withFunctionRows) {
    await withTransaction((transaction) =>
      SandboxFunctionResource.createForFramePublication(
        auth,
        {
          frame,
          publicationId,
          functions: [
            {
              name: TEST_PUBLICATION_FUNCTION_NAME,
              description: "Add a task.",
              userIdentity: "optional",
              executionMode: "durable",
              defaultStake: "low",
              bundleCode: TEST_PUBLICATION_FUNCTION_CODE,
              inputSchema,
              outputSchema,
            },
          ],
        },
        transaction
      )
    );
  }

  return publicationId;
}

/**
 * Stores and publishes a client-only Frames v2 bundle for `frame`, through the real publish path:
 * `live` activates it, `draft` only moves the latest pointer. Returns its publication id.
 */
export async function publishTestFrameBundle(
  auth: Authenticator,
  {
    frame,
    uiBundleCode,
    mode,
  }: { frame: FileResource; uiBundleCode: string; mode: FramePublishMode }
): Promise<string> {
  const published = await publishFramePublication(auth, {
    frame,
    functionArtifacts: [],
    manifest: FrameManifestSchema.parse({
      version: 1,
      description: "Track tasks.",
    }),
    sourceFiles: [
      {
        relativePath: "index.tsx",
        content: Buffer.from(uiBundleCode),
        contentType: "text/typescript",
      },
    ],
    uiBundleCode,
    mode,
  });
  if (published.isErr()) {
    throw published.error;
  }
  return published.value.publicationId;
}

/** A Frame source tree: relative path to file content, `manifest.json` included. */
export type TestFrameSourceTree = Record<string, string>;

/**
 * Publish `tree` as a publication of `frame` through the real publish path, so it gets a stored
 * `source.tar`. Each file is typed as publish types it: by extension, else the GCS default.
 */
export async function publishTestFrameSourceTree(
  auth: Authenticator,
  {
    frame,
    tree,
    mode,
  }: { frame: FileResource; tree: TestFrameSourceTree; mode: FramePublishMode }
): Promise<string> {
  const manifest = parseFrameManifest(Buffer.from(tree[FRAME_MANIFEST_FILE]));
  assert(manifest.isOk(), "test Frame manifest parses");
  const published = await publishFramePublication(auth, {
    frame,
    functionArtifacts: [],
    manifest: manifest.value,
    sourceFiles: Object.entries(tree).map(([relativePath, content]) => ({
      relativePath,
      content: Buffer.from(content),
      contentType:
        contentTypeFromFileName(relativePath) ?? DEFAULT_FILE_CONTENT_TYPE,
    })),
    // Any change to the tree changes the bundle, so a changed tree is never "same as live".
    uiBundleCode: `export default ${JSON.stringify(tree)};`,
    mode,
  });
  assert(published.isOk(), "test Frame publish succeeds");
  return published.value.publicationId;
}

/**
 * A conversation Frame whose source folder holds `tree`, published live from it. The source files
 * live in `fileStorageMock`, which cannot enumerate its objects: listing and existence checks are
 * wired to the paths seeded through `setSource`. With `atMountRoot`, the manifest sits directly at
 * the conversation's mount root instead of in a `folderName` subfolder.
 */
export async function createTestLiveFrameWithSource(
  auth: Authenticator,
  {
    conversationId,
    tree,
    folderName = "Frame",
    atMountRoot = false,
  }: {
    conversationId: string;
    tree: TestFrameSourceTree;
    folderName?: string;
    atMountRoot?: boolean;
  }
) {
  const conversationFilesPath = getConversationFilesBasePath({
    workspaceId: auth.getNonNullableWorkspace().sId,
    conversationId,
  });
  const frame = atMountRoot
    ? await FileFactory.create(auth, null, {
        contentType: frameV2ContentType,
        fileName: FRAME_MANIFEST_FILE,
        fileSize: 100,
        status: "created",
        useCase: "conversation",
        useCaseMetadata: { conversationId },
        mountFilePath: `${conversationFilesPath}${FRAME_MANIFEST_FILE}`,
      })
    : await createTestConversationFrameFile(auth, {
        conversationId,
        folderName,
      });
  const sourceDirectory = atMountRoot
    ? conversationFilesPath.replace(/\/$/, "")
    : `${conversationFilesPath}${folderName}`;

  const seededPaths = new Set<string>();
  const setSource = (relativePath: string, content: string) => {
    const objectPath = `${sourceDirectory}/${relativePath}`;
    seededPaths.add(objectPath);
    fileStorageMock.setObject(objectPath, content);
  };
  const getSource = (relativePath: string) =>
    fileStorageMock.getObject(`${sourceDirectory}/${relativePath}`);
  fileStorageMock.setFileExists(
    (filePath) => fileStorageMock.getObject(filePath) !== undefined
  );
  fileStorageMock.setFilesByPrefix((prefix) =>
    [...seededPaths]
      .filter(
        (name) =>
          name.startsWith(prefix) &&
          fileStorageMock.getObject(name) !== undefined
      )
      .map((name) => ({
        name,
        metadata: { contentType: "text/plain", size: "10" },
      }))
  );

  for (const [relativePath, content] of Object.entries(tree)) {
    setSource(relativePath, content);
  }
  const liveId = await publishTestFrameSourceTree(auth, {
    frame,
    tree,
    mode: "live",
  });

  return { frame, liveId, sourceDirectory, setSource, getSource };
}

export const TEST_SCHEDULED_FUNCTION_NAME = "refresh";

/**
 * A workspace with an admin, a separate publisher (plain member) and a conversation Frame whose
 * active publication declares one durable `refresh` function with `schedule`, stored and
 * activated through the real publish path as the publisher. `flags` are enabled for the
 * workspace before publishing.
 */
export async function createTestScheduledFramePublication({
  schedule,
  flags = ["frames_v2_functions", "frames_v2_schedules"],
  userIdentity = "workspace_user_required",
}: {
  schedule: FrameScheduleManifest;
  flags?: WhitelistableFeature[];
  userIdentity?: SandboxFunctionUserIdentityPolicy;
}) {
  const { workspace, authenticator: adminAuth } = await createResourceTest({
    role: "admin",
  });
  for (const flag of flags) {
    await FeatureFlagFactory.basic(adminAuth, flag);
  }
  const publisher = await UserFactory.basic();
  await MembershipFactory.associate(workspace, publisher, { role: "user" });
  const publisherAuth = await Authenticator.fromUserIdAndWorkspaceId(
    publisher.sId,
    workspace.sId
  );

  const conversation = await ConversationFactory.create(publisherAuth, {
    agentConfigurationId: GLOBAL_AGENTS_SID.DUST,
    messagesCreatedAt: [new Date()],
  });
  const frame = await FileFactory.create(publisherAuth, null, {
    contentType: frameV2ContentType,
    fileName: FRAME_MANIFEST_FILE,
    fileSize: 0,
    status: "created",
    useCase: "conversation",
    useCaseMetadata: { conversationId: conversation.sId },
    mountFilePath: `${getConversationFilesBasePath({
      workspaceId: workspace.sId,
      conversationId: conversation.sId,
    })}Frame/${FRAME_MANIFEST_FILE}`,
  });

  const functionArtifacts = [
    {
      name: TEST_SCHEDULED_FUNCTION_NAME,
      bundleCode: TEST_PUBLICATION_FUNCTION_CODE,
      userIdentity,
      inputSchema: {
        type: "object",
        properties: { source: { type: "string" } },
        required: ["source"],
      },
      outputSchema,
    },
  ] satisfies FramePublicationFunctionArtifact[];
  const manifest = FrameManifestSchema.parse({
    version: 1,
    description: "Refresh cached data.",
    functions: [
      {
        name: TEST_SCHEDULED_FUNCTION_NAME,
        description: "Refresh it.",
        entryPoint: "functions/refresh.ts",
        schedules: [schedule],
      },
    ],
  });
  const stored = await storeFramePublication(publisherAuth, {
    frame,
    functionArtifacts,
    manifest,
    sourceFiles: [
      {
        relativePath: "index.tsx",
        content: Buffer.from("export default function App() {}"),
        contentType: "text/typescript",
      },
      {
        relativePath: "functions/refresh.ts",
        content: Buffer.from(TEST_PUBLICATION_FUNCTION_CODE),
        contentType: "text/typescript",
      },
    ],
    uiBundleCode: "export default function App() {}",
  });
  if (stored.isErr()) {
    throw stored.error;
  }
  const { publicationId, descriptor } = stored.value;
  const rows = await createFramePublicationFunctionRows(publisherAuth, {
    frame,
    publicationId,
    descriptor,
    functionArtifacts,
  });
  if (rows.isErr()) {
    throw rows.error;
  }
  await frame.setActiveFramePublication({
    publicationId,
    description: manifest.description,
  });
  await frame.ensureShareableFrame(publisherAuth);

  return {
    workspace,
    adminAuth,
    publisher,
    publisherAuth,
    frame,
    publicationId,
  };
}

/**
 * `createTestLiveFrameWithSource`, then draft mode turned on and `draftTree` published as the
 * Frame's pending draft.
 */
export async function createTestFrameInDraftMode(
  auth: Authenticator,
  {
    conversationId,
    tree,
    draftTree,
    folderName,
  }: {
    conversationId: string;
    tree: TestFrameSourceTree;
    draftTree: TestFrameSourceTree;
    folderName?: string;
  }
) {
  const live = await createTestLiveFrameWithSource(auth, {
    conversationId,
    tree,
    folderName,
  });
  const entered = await enterFrameDraftMode(auth, { frame: live.frame });
  assert(entered.isOk(), "test Frame enters draft mode");
  const draftId = await publishTestFrameSourceTree(auth, {
    frame: live.frame,
    tree: draftTree,
    mode: "draft",
  });
  return { ...live, draftId };
}
