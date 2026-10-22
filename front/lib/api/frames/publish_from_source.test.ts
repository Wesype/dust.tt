// @vitest-environment node

import { enterFrameDraftMode } from "@app/lib/api/frames/draft_mode";
import { getFrameSourceLockName } from "@app/lib/api/frames/operation_lock";
import {
  publishFrameFromSource,
  publishFrameV2FromSource,
} from "@app/lib/api/frames/publish_from_source";
import {
  computeFrameSourcePathSetSha256,
  FRAME_SOURCE_STAGING_ROOT,
} from "@app/lib/api/frames/source_staging";
import { getRedisStreamClient } from "@app/lib/api/redis";
import {
  ensureConversationSandboxReadyWithScope,
  ensureFrameSandboxReady,
} from "@app/lib/api/sandbox/lifecycle";
import { buildSandboxFunctionOnReadySandbox } from "@app/lib/api/sandbox_functions/build_on_sandbox";
import { reconcileDatabaseOnReadySandbox } from "@app/lib/api/sandbox_functions/dsbx_db";
import { Authenticator } from "@app/lib/auth";
import { FileResource } from "@app/lib/resources/file_resource";
import { GroupPermissionResource } from "@app/lib/resources/group_permission_resource";
import { ProjectMetadataResource } from "@app/lib/resources/project_metadata_resource";
import { SandboxResource } from "@app/lib/resources/sandbox_resource";
import { ConversationFactory } from "@app/tests/utils/ConversationFactory";
import { FeatureFlagFactory } from "@app/tests/utils/FeatureFlagFactory";
import { FileFactory } from "@app/tests/utils/FileFactory";
import {
  FrameAppFactory,
  TEST_FRAME_APP_MANIFEST,
  TEST_FRAME_APP_SOURCES,
  TEST_FRAME_MANIFEST,
  TEST_FRAME_UI_SOURCE,
} from "@app/tests/utils/FrameAppFactory";
import {
  enableFrameApps,
  enablePublicFrameFunctions,
} from "@app/tests/utils/FrameFunctionFactory";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
import { GroupFactory } from "@app/tests/utils/GroupFactory";
import { fileStorageMock } from "@app/tests/utils/mocks/file_storage";
import { grantWorkspacePermission } from "@app/tests/utils/permissions";
import { SpaceFactory } from "@app/tests/utils/SpaceFactory";
import {
  FRAME_MANIFEST_FILE,
  FrameManifestSchema,
} from "@app/types/api/frame_manifest";
import { FramePublicationDescriptorSchema } from "@app/types/api/frame_publication";
import { getFramePublicationDescriptorPath } from "@app/types/api/frame_storage";
import { GLOBAL_AGENTS_SID } from "@app/types/assistant/assistant";
import { frameContentType, frameV2ContentType } from "@app/types/files";
import type { MembershipRoleType } from "@app/types/memberships";
import {
  getConversationFilesBasePath,
  getPodFilesBasePath,
} from "@app/types/mount_path";
import { Err, Ok } from "@app/types/shared/result";
import assert from "assert";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@app/lib/api/sandbox/lifecycle", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@app/lib/api/sandbox/lifecycle")>();
  return {
    ...actual,
    ensureFrameSandboxReady: vi.fn(),
    ensureConversationSandboxReadyWithScope: vi.fn(),
  };
});

vi.mock(
  "@app/lib/api/sandbox_functions/build_on_sandbox",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@app/lib/api/sandbox_functions/build_on_sandbox")
      >();
    return { ...actual, buildSandboxFunctionOnReadySandbox: vi.fn() };
  }
);

vi.mock("@app/lib/api/sandbox_functions/dsbx_db", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@app/lib/api/sandbox_functions/dsbx_db")
    >();
  return { ...actual, reconcileDatabaseOnReadySandbox: vi.fn() };
});

vi.mock("@app/lib/api/frames/seed_functions_archive", () => ({
  seedFramePublicationFunctionsArchive: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  fileStorageMock.reset();
  vi.clearAllMocks();
});

describe("publishFrameFromSource", () => {
  it("registers and publishes a v2 Frame that has no prior identity", async () => {
    const { authenticator: auth, workspace } = await createResourceTest({
      role: "admin",
    });
    const conversation = await ConversationFactory.create(auth, {
      agentConfigurationId: "test-agent",
      messagesCreatedAt: [],
    });
    const sourceDirectoryPath = `conversation-${conversation.sId}/Status`;
    const manifestPath = `${sourceDirectoryPath}/${FRAME_MANIFEST_FILE}`;
    const gcsSourceDirectoryPath = `${getConversationFilesBasePath({
      workspaceId: workspace.sId,
      conversationId: conversation.sId,
    })}Status`;
    const sourceByPath = new Map([
      [`${gcsSourceDirectoryPath}/${FRAME_MANIFEST_FILE}`, TEST_FRAME_MANIFEST],
      [`${gcsSourceDirectoryPath}/index.tsx`, TEST_FRAME_UI_SOURCE],
    ]);
    fileStorageMock.setFilesByPrefix((prefix) =>
      prefix === `${gcsSourceDirectoryPath}/`
        ? [...sourceByPath.entries()].map(([name, content]) => ({
            name,
            metadata: {
              contentType: name.endsWith(".tsx")
                ? "text/typescript"
                : frameV2ContentType,
              size: String(Buffer.byteLength(content)),
            },
          }))
        : null
    );
    fileStorageMock.setFileContent(
      (filePath) => sourceByPath.get(filePath) ?? null
    );

    const result = await publishFrameFromSource(auth, {
      conversation,
      publishedByAgentConfigurationId: "test-agent",
      sourcePath: manifestPath,
    });

    assert(result.isOk());
    expect(result.value).toMatchObject({
      kind: "v2",
      sourcePath: manifestPath,
      created: true,
    });
    const frame = await FileResource.fetchById(auth, result.value.frameId);
    expect(frame?.isFrameV2).toBe(true);
    expect(frame?.useCaseMetadata?.activePublicationId).toBe(
      result.value.kind === "v2" ? result.value.publicationId : undefined
    );
  });

  it("rejects a Frame outside the signed conversation scope", async () => {
    const { authenticator: auth, workspace } = await createResourceTest({
      role: "admin",
    });
    const conversation = await ConversationFactory.create(auth, {
      agentConfigurationId: "test-agent",
      messagesCreatedAt: [],
    });
    const otherConversation = await ConversationFactory.create(auth, {
      agentConfigurationId: "test-agent",
      messagesCreatedAt: [],
    });
    const sourcePath = `conversation-${otherConversation.sId}/Legacy.tsx`;
    await FileFactory.create(auth, null, {
      contentType: frameContentType,
      fileName: "Legacy.tsx",
      fileSize: Buffer.byteLength(TEST_FRAME_UI_SOURCE),
      status: "created",
      useCase: "conversation",
      useCaseMetadata: { conversationId: otherConversation.sId },
      mountFilePath: `${getConversationFilesBasePath({
        workspaceId: workspace.sId,
        conversationId: otherConversation.sId,
      })}Legacy.tsx`,
    });

    const result = await publishFrameFromSource(auth, {
      conversation,
      publishedByAgentConfigurationId: "test-agent",
      sourcePath,
    });

    expect(result.isErr() && result.error).toMatchObject({
      code: "invalid_path",
    });
    expect(fileStorageMock.readStreamCalls).toHaveLength(0);
    expect(fileStorageMock.saveFileCalls).toHaveLength(0);
  });

  it("rejects a legacy Frame in a read-only Pod", async () => {
    const {
      authenticator: auth,
      globalGroup,
      user,
      workspace,
    } = await createResourceTest({ role: "admin" });
    const space = await SpaceFactory.project(workspace);
    await SpaceFactory.attachGroup(space, globalGroup, "project_viewer");
    const viewerAuth = await Authenticator.fromUserIdAndWorkspaceId(
      user.sId,
      workspace.sId
    );
    assert(viewerAuth);
    expect(viewerAuth.can("read", space)).toBe(true);
    expect(viewerAuth.can("write", space)).toBe(false);

    const conversation = await ConversationFactory.create(viewerAuth, {
      agentConfigurationId: "test-agent",
      messagesCreatedAt: [],
      spaceId: space.id,
    });
    const sourcePath = `pod-${space.sId}/Legacy.tsx`;
    await FileFactory.create(auth, null, {
      contentType: frameContentType,
      fileName: "Legacy.tsx",
      fileSize: Buffer.byteLength(TEST_FRAME_UI_SOURCE),
      status: "created",
      useCase: "project_context",
      useCaseMetadata: { spaceId: space.sId },
      mountFilePath: `${getPodFilesBasePath({
        workspaceId: workspace.sId,
        podId: space.sId,
      })}Legacy.tsx`,
    });

    const result = await publishFrameFromSource(viewerAuth, {
      conversation,
      publishedByAgentConfigurationId: "test-agent",
      sourcePath,
    });

    expect(result.isErr() && result.error).toMatchObject({
      code: "unauthorized",
    });
    expect(fileStorageMock.readStreamCalls).toHaveLength(0);
    expect(fileStorageMock.saveFileCalls).toHaveLength(0);
  });
});

type LegacyFrameReplacementScope = "conversation" | "pod";

async function setupLegacyFrameReplacement({
  scope,
  replacementUiSource = TEST_FRAME_UI_SOURCE,
  replacementManifest = TEST_FRAME_MANIFEST,
  extraSources = {},
  role = "admin",
}: {
  scope: LegacyFrameReplacementScope;
  replacementUiSource?: string;
  replacementManifest?: string;
  extraSources?: Record<string, string>;
  role?: MembershipRoleType;
}) {
  const {
    authenticator: auth,
    user,
    workspace,
  } = await createResourceTest({ role });
  const pod =
    scope === "pod" ? await SpaceFactory.project(workspace, user.id) : null;
  const podAuth = pod
    ? await Authenticator.fromUserIdAndWorkspaceId(user.sId, workspace.sId)
    : auth;
  assert(podAuth, "Pod authenticator not found");
  const conversation = await ConversationFactory.create(podAuth, {
    agentConfigurationId: "test-agent",
    messagesCreatedAt: [],
    spaceId: pod?.id,
  });

  const scopedRoot = pod
    ? `pod-${pod.sId}`
    : `conversation-${conversation.sId}`;
  const gcsRoot = pod
    ? getPodFilesBasePath({ workspaceId: workspace.sId, podId: pod.sId })
    : getConversationFilesBasePath({
        workspaceId: workspace.sId,
        conversationId: conversation.sId,
      });
  const legacyPath = `${scopedRoot}/dashboards/Sales.tsx`;
  const manifestPath = `${scopedRoot}/dashboards/Sales/${FRAME_MANIFEST_FILE}`;
  const gcsSourceDirectoryPath = `${gcsRoot}dashboards/Sales`;

  const legacyFrame = await FileFactory.create(podAuth, null, {
    contentType: frameContentType,
    fileName: "Sales.tsx",
    fileSize: Buffer.byteLength(TEST_FRAME_UI_SOURCE),
    status: "created",
    useCase: pod ? "project_context" : "conversation",
    useCaseMetadata: pod
      ? { spaceId: pod.sId }
      : { conversationId: conversation.sId },
    mountFilePath: `${gcsRoot}dashboards/Sales.tsx`,
  });
  await legacyFrame.ensureShareableFrame(podAuth);
  const legacyGcsPath = `${gcsRoot}dashboards/Sales.tsx`;
  fileStorageMock.setObject(legacyGcsPath, TEST_FRAME_UI_SOURCE);

  const sourceByPath = new Map([
    [`${gcsSourceDirectoryPath}/${FRAME_MANIFEST_FILE}`, replacementManifest],
    [`${gcsSourceDirectoryPath}/index.tsx`, replacementUiSource],
    [`${gcsSourceDirectoryPath}/theme.ts`, "export const theme = {};"],
    ...Object.entries(extraSources).map(
      ([relativePath, content]): [string, string] => [
        `${gcsSourceDirectoryPath}/${relativePath}`,
        content,
      ]
    ),
  ]);
  fileStorageMock.setFilesByPrefix((prefix) =>
    prefix === `${gcsSourceDirectoryPath}/`
      ? [...sourceByPath.entries()].map(([name, content]) => ({
          name,
          metadata: {
            contentType: name.endsWith(".json")
              ? frameV2ContentType
              : "text/typescript",
            size: String(Buffer.byteLength(content)),
          },
        }))
      : null
  );
  fileStorageMock.setFileContent(
    (filePath) => sourceByPath.get(filePath) ?? null
  );

  return {
    auth: podAuth,
    conversation,
    legacyFrame,
    legacyGcsPath,
    legacyPath,
    manifestPath,
    pod,
    sourceByPath,
  };
}

describe("publishFrameFromSource replacing a legacy Frame", () => {
  it("keeps the legacy Frame's id and share link", async () => {
    const { auth, conversation, legacyFrame, legacyPath, manifestPath } =
      await setupLegacyFrameReplacement({ scope: "conversation" });
    const legacyShare = await legacyFrame.getShareInfo();
    assert(legacyShare, "Legacy Frame is not shared");

    const result = await publishFrameFromSource(auth, {
      conversation,
      publishedByAgentConfigurationId: "test-agent",
      sourcePath: manifestPath,
      replacesPath: legacyPath,
    });

    assert(result.isOk(), "Replacement publish failed");
    expect(result.value).toMatchObject({
      kind: "v2",
      frameId: legacyFrame.sId,
      sourcePath: manifestPath,
    });
    const frame = await FileResource.fetchById(auth, legacyFrame.sId);
    assert(frame, "Frame not found");
    expect(frame.isFrameV2).toBe(true);
    expect(frame.toScopedPath(auth)).toBe(manifestPath);
    expect(frame.useCaseMetadata?.activePublicationId).toBe(
      result.value.kind === "v2" ? result.value.publicationId : undefined
    );
    const share = await frame.getShareInfo();
    expect(share?.shareUrl).toBe(legacyShare.shareUrl);
  });

  it("deletes the legacy entry file once the replacement is active", async () => {
    const { auth, conversation, legacyGcsPath, legacyPath, manifestPath } =
      await setupLegacyFrameReplacement({ scope: "conversation" });

    const result = await publishFrameFromSource(auth, {
      conversation,
      publishedByAgentConfigurationId: "test-agent",
      sourcePath: manifestPath,
      replacesPath: legacyPath,
    });

    assert(result.isOk(), "Replacement publish failed");
    expect(fileStorageMock.getObject(legacyGcsPath)).toBeUndefined();
  });

  it("leaves the legacy Frame untouched when the replacement fails to build", async () => {
    const {
      auth,
      conversation,
      legacyFrame,
      legacyGcsPath,
      legacyPath,
      manifestPath,
    } = await setupLegacyFrameReplacement({
      scope: "conversation",
      replacementUiSource: "export default function App() { return <p>",
    });

    const result = await publishFrameFromSource(auth, {
      conversation,
      publishedByAgentConfigurationId: "test-agent",
      sourcePath: manifestPath,
      replacesPath: legacyPath,
    });

    expect(result.isErr()).toBe(true);
    const frame = await FileResource.fetchById(auth, legacyFrame.sId);
    assert(frame, "Frame not found");
    expect(frame.isInteractiveContent).toBe(true);
    expect(frame.toScopedPath(auth)).toBe(legacyPath);
    expect(fileStorageMock.getObject(legacyGcsPath)).toBe(TEST_FRAME_UI_SOURCE);
  });

  it("leaves the legacy Frame untouched when a member may not create Frame Apps", async () => {
    const {
      auth,
      conversation,
      legacyFrame,
      legacyGcsPath,
      legacyPath,
      manifestPath,
    } = await setupLegacyFrameReplacement({
      scope: "conversation",
      replacementManifest: TEST_FRAME_APP_MANIFEST,
      extraSources: TEST_FRAME_APP_SOURCES,
      role: "user",
    });
    await enableFrameApps(auth);

    const result = await publishFrameFromSource(auth, {
      conversation,
      publishedByAgentConfigurationId: "test-agent",
      sourcePath: manifestPath,
      replacesPath: legacyPath,
    });

    assert(result.isErr());
    expect(result.error).toMatchObject({
      code: "frame_app_creation_not_allowed",
    });
    expect(result.error.message).toContain(
      "not allowed to create or update Frame Apps"
    );
    expect(buildSandboxFunctionOnReadySandbox).not.toHaveBeenCalled();
    const frame = await FileResource.fetchById(auth, legacyFrame.sId);
    assert(frame, "Frame not found");
    expect(frame.isInteractiveContent).toBe(true);
    expect(frame.toScopedPath(auth)).toBe(legacyPath);
    expect(fileStorageMock.getObject(legacyGcsPath)).toBe(TEST_FRAME_UI_SOURCE);
  });

  it("moves the Pod pin and tab to the replacement", async () => {
    const { auth, conversation, legacyPath, manifestPath, pod } =
      await setupLegacyFrameReplacement({ scope: "pod" });
    assert(pod, "Pod not found");
    await ProjectMetadataResource.makeNew(auth, pod, {
      pinnedFramePath: legacyPath,
      frameTabs: [
        { path: legacyPath, title: "Sales", icon: "ActionDocumentIcon" },
      ],
      tabsOrder: ["conversations", legacyPath, "files", "tasks"],
    });

    const result = await publishFrameFromSource(auth, {
      conversation,
      publishedByAgentConfigurationId: "test-agent",
      sourcePath: manifestPath,
      replacesPath: legacyPath,
    });

    assert(result.isOk(), "Replacement publish failed");
    const metadata = await ProjectMetadataResource.fetchBySpace(auth, pod);
    assert(metadata, "Pod metadata not found");
    expect(metadata.pinnedFramePath).toBe(manifestPath);
    expect(metadata.frameTabs.map((tab) => tab.path)).toEqual([manifestPath]);
    expect(metadata.tabsOrder).toContain(manifestPath);
  });

  it("refuses to replace a file that is not a legacy Frame", async () => {
    const { auth, conversation, legacyFrame, manifestPath } =
      await setupLegacyFrameReplacement({ scope: "conversation" });
    const notAFramePath = manifestPath.replace(
      "Sales/manifest.json",
      "notes.md"
    );

    const result = await publishFrameFromSource(auth, {
      conversation,
      publishedByAgentConfigurationId: "test-agent",
      sourcePath: manifestPath,
      replacesPath: notAFramePath,
    });

    expect(result.isErr()).toBe(true);
    const frame = await FileResource.fetchById(auth, legacyFrame.sId);
    expect(frame?.isInteractiveContent).toBe(true);
  });

  it("builds functions on the conversation sandbox and reconciles after conversion", async () => {
    const replacementManifest = JSON.stringify({
      version: 1,
      description: "Sales with functions and a database.",
      functions: [
        {
          name: "run",
          description: "Run it.",
          entryPoint: "functions/run.ts",
        },
      ],
      databases: [{ name: "items", schema: "databases/items.db.ts" }],
    });
    const {
      auth,
      conversation,
      legacyFrame,
      legacyPath,
      manifestPath,
      sourceByPath,
    } = await setupLegacyFrameReplacement({
      scope: "conversation",
      replacementManifest,
      extraSources: {
        ...TEST_FRAME_APP_SOURCES,
        "databases/items.db.ts": "export const items = {};",
      },
    });
    await FeatureFlagFactory.basic(auth, "frames_v2_functions");

    const sandbox = await SandboxResource.makeNew(auth, {
      providerId: "test-provider-id",
      status: "running",
      baseImage: "dust-base",
      version: "0.0.0-test",
    });
    const stagedRelativePaths = [
      FRAME_MANIFEST_FILE,
      "index.tsx",
      "theme.ts",
      "functions/run.ts",
      "databases/items.db.ts",
    ];
    const pathSetSha256 = computeFrameSourcePathSetSha256(stagedRelativePaths);
    vi.spyOn(sandbox, "writeFile").mockResolvedValue(new Ok(undefined));
    // Both conversation staging (function build) and Frame staging (reconcile) harden
    // with a path-set hash; return it on every root command so call order does not matter.
    vi.spyOn(sandbox, "execRoot").mockResolvedValue(
      new Ok({
        exitCode: 0,
        stdout: `${pathSetSha256}  -\n`,
        stderr: "",
      })
    );
    vi.spyOn(sandbox, "readFile").mockImplementation(
      async (_auth, filePath) => {
        const relativePath = stagedRelativePaths.find((path) =>
          filePath.endsWith(`/${path}`)
        );
        if (!relativePath) {
          return new Err(new Error(`Unexpected staged path: ${filePath}`));
        }
        const gcsPath = [...sourceByPath.keys()].find((path) =>
          path.endsWith(`/${relativePath}`)
        );
        const content = gcsPath ? sourceByPath.get(gcsPath) : undefined;
        return content
          ? new Ok(Buffer.from(content))
          : new Err(new Error(`Missing staged content: ${relativePath}`));
      }
    );
    vi.mocked(ensureConversationSandboxReadyWithScope).mockResolvedValue(
      new Ok({
        sandbox,
        freshlyCreated: false,
        scope: { spaceId: null },
      })
    );
    vi.mocked(ensureFrameSandboxReady).mockImplementation(async () => {
      const frame = await FileResource.fetchById(auth, legacyFrame.sId);
      assert(frame?.isFrameV2, "Frame sandbox ensure ran before conversion");
      return new Ok({
        sandbox,
        freshlyCreated: false,
        scope: { spaceId: null },
      });
    });
    vi.mocked(buildSandboxFunctionOnReadySandbox).mockResolvedValue(
      new Ok({
        bundleCode: "export default true;",
        userIdentity: "optional",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
      })
    );
    vi.mocked(reconcileDatabaseOnReadySandbox).mockResolvedValue(
      new Ok({ database: "items", created: true, statements: ["CREATE TABLE"] })
    );

    const result = await publishFrameFromSource(auth, {
      conversation,
      publishedByAgentConfigurationId: "test-agent",
      sourcePath: manifestPath,
      replacesPath: legacyPath,
    });

    assert(result.isOk(), "Replacement publish failed");
    expect(ensureConversationSandboxReadyWithScope).toHaveBeenCalledOnce();
    expect(ensureConversationSandboxReadyWithScope).toHaveBeenCalledWith(
      auth,
      conversation
    );
    expect(ensureFrameSandboxReady).toHaveBeenCalledOnce();
    // Called after convertLegacyFrameToFrameV2 mutates the same FileResource in place.
    expect(ensureFrameSandboxReady).toHaveBeenCalledWith(
      auth,
      expect.objectContaining({
        sId: legacyFrame.sId,
        contentType: frameV2ContentType,
      })
    );
    expect(buildSandboxFunctionOnReadySandbox).toHaveBeenCalledWith(auth, {
      sandbox,
      srcSandboxPath: expect.stringMatching(
        new RegExp(`^${FRAME_SOURCE_STAGING_ROOT}/[^/]+/functions/run\\.ts$`)
      ),
    });
    expect(reconcileDatabaseOnReadySandbox).toHaveBeenCalledWith(auth, {
      sandbox,
      database: "items",
      schemaFileSandboxPath: expect.stringMatching(
        new RegExp(
          `^${FRAME_SOURCE_STAGING_ROOT}/[^/]+/databases/items\\.db\\.ts$`
        )
      ),
    });

    const frame = await FileResource.fetchById(auth, legacyFrame.sId);
    assert(frame, "Frame not found");
    expect(frame.isFrameV2).toBe(true);
    expect(frame.useCaseMetadata?.activePublicationId).toBe(
      result.value.kind === "v2" ? result.value.publicationId : undefined
    );
  });

  it("leaves a public legacy Frame untouched when its replacement has no public function", async () => {
    const replacementManifest = JSON.stringify({
      version: 1,
      description: "Sales with a private function.",
      functions: [
        {
          name: "run",
          description: "Run it.",
          entryPoint: "functions/run.ts",
        },
      ],
    });
    const { auth, conversation, legacyFrame, legacyPath, manifestPath } =
      await setupLegacyFrameReplacement({
        scope: "conversation",
        replacementManifest,
        extraSources: TEST_FRAME_APP_SOURCES,
      });
    await enablePublicFrameFunctions(auth);
    await legacyFrame.setShareScope(auth, "public");

    const sandbox = await SandboxResource.makeNew(auth, {
      providerId: "test-provider-id",
      status: "running",
      baseImage: "dust-base",
      version: "0.0.0-test",
    });
    const stagedRelativePaths = [
      FRAME_MANIFEST_FILE,
      "index.tsx",
      "theme.ts",
      "functions/run.ts",
    ];
    vi.spyOn(sandbox, "writeFile").mockResolvedValue(new Ok(undefined));
    vi.spyOn(sandbox, "execRoot").mockResolvedValue(
      new Ok({
        exitCode: 0,
        stdout: `${computeFrameSourcePathSetSha256(stagedRelativePaths)}  -\n`,
        stderr: "",
      })
    );
    vi.mocked(ensureConversationSandboxReadyWithScope).mockResolvedValue(
      new Ok({
        sandbox,
        freshlyCreated: false,
        scope: { spaceId: null },
      })
    );
    vi.mocked(buildSandboxFunctionOnReadySandbox).mockResolvedValue(
      new Ok({
        bundleCode: "export default true;",
        userIdentity: "workspace_user_required",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
      })
    );

    const result = await publishFrameFromSource(auth, {
      conversation,
      publishedByAgentConfigurationId: "test-agent",
      sourcePath: manifestPath,
      replacesPath: legacyPath,
    });

    assert(result.isErr(), "Expected the replacement to be refused");
    expect(result.error).toMatchObject({ code: "sharing_conflict" });
    expect(ensureFrameSandboxReady).not.toHaveBeenCalled();
    const frame = await FileResource.fetchById(auth, legacyFrame.sId);
    assert(frame, "Frame not found");
    expect(frame.isFrameV2).toBe(false);
    expect(frame.toScopedPath(auth)).toBe(legacyPath);
  });
});

describe("publishFrameV2FromSource", () => {
  it("publishes artifacts without copying source and activates one publication", async () => {
    const {
      auth,
      conversation,
      frame,
      gcsSourceDirectoryPath,
      manifestPath,
      workspace,
    } = await FrameAppFactory.conversationFrame();

    const result = await publishFrameV2FromSource(auth, {
      conversation,
      frame,
      manifestPath,
    });

    assert(result.isOk());
    const identity = {
      workspaceId: workspace.sId,
      frameId: frame.sId,
      publicationId: result.value.publicationId,
    };
    const storedPublication = fileStorageMock.getObject(
      getFramePublicationDescriptorPath(identity)
    );
    assert(storedPublication);
    const publication = FramePublicationDescriptorSchema.parse(
      JSON.parse(storedPublication)
    );
    expect(publication.manifest).toEqual(
      FrameManifestSchema.parse(JSON.parse(TEST_FRAME_MANIFEST))
    );
    expect(
      fileStorageMock.saveFileCalls.some(({ filePath }) =>
        filePath.startsWith(`${gcsSourceDirectoryPath}/`)
      )
    ).toBe(false);

    const reloaded = await FileResource.fetchById(auth, frame.sId);
    expect(reloaded?.useCaseMetadata?.activePublicationId).toBe(
      result.value.publicationId
    );
  });

  it.each<{
    declares: string;
    manifestContent: string;
    extraSources: Record<string, string>;
  }>([
    {
      declares: "functions",
      manifestContent: TEST_FRAME_APP_MANIFEST,
      extraSources: TEST_FRAME_APP_SOURCES,
    },
    {
      declares: "databases",
      manifestContent: JSON.stringify({
        version: 1,
        description: "Store items.",
        databases: [{ name: "items", schema: "databases/items.db.ts" }],
      }),
      extraSources: { "databases/items.db.ts": "export {};" },
    },
  ])(
    "rejects a manifest declaring $declares without Frame functions",
    async ({ manifestContent, extraSources }) => {
      const { auth, conversation, frame, manifestPath } =
        await FrameAppFactory.conversationFrame({
          manifestContent,
          extraSources,
        });

      const result = await publishFrameV2FromSource(auth, {
        conversation,
        frame,
        manifestPath,
      });

      assert(result.isErr());
      expect(result.error).toMatchObject({ code: "invalid_manifest" });
      expect(result.error.message).toContain(
        "Frame functions and databases are not enabled"
      );
      const reloaded = await FileResource.fetchById(auth, frame.sId);
      expect(reloaded?.useCaseMetadata?.activePublicationId).toBeUndefined();
    }
  );

  it("rejects a manifest declaring schedules without the schedules flag", async () => {
    const { auth, conversation, frame, manifestPath } =
      await FrameAppFactory.conversationFrame({
        manifestContent: JSON.stringify({
          version: 1,
          description: "Run a function on a schedule.",
          functions: [
            {
              name: "run",
              description: "Run it.",
              entryPoint: "functions/run.ts",
              schedules: [
                {
                  cron: "0 * * * *",
                  timezone: "UTC",
                  input: {},
                },
              ],
            },
          ],
        }),
        extraSources: TEST_FRAME_APP_SOURCES,
      });
    await FeatureFlagFactory.basic(auth, "frames_v2_functions");

    const result = await publishFrameV2FromSource(auth, {
      conversation,
      frame,
      manifestPath,
    });

    assert(result.isErr());
    expect(result.error).toMatchObject({ code: "invalid_manifest" });
    expect(result.error.message).toContain("Frame schedules are not enabled");
    expect(ensureFrameSandboxReady).not.toHaveBeenCalled();
    expect(ensureConversationSandboxReadyWithScope).not.toHaveBeenCalled();
    const reloaded = await FileResource.fetchById(auth, frame.sId);
    expect(reloaded?.useCaseMetadata?.activePublicationId).toBeUndefined();
  });

  it("lets a member without the grant publish a client-only Frame", async () => {
    const { auth, conversation, frame, manifestPath } =
      await FrameAppFactory.buildable("user", TEST_FRAME_MANIFEST);
    expect(auth.hasWorkspacePermission("create", "frame_app")).toBe(false);

    const result = await publishFrameV2FromSource(auth, {
      conversation,
      frame,
      manifestPath,
    });

    expect(result.isOk()).toBe(true);
  });

  it("refuses a member who may not create Frame Apps and keeps the previous publication live", async () => {
    const { auth, conversation, frame, manifestPath, sourceByPath } =
      await FrameAppFactory.buildable("user", TEST_FRAME_MANIFEST);
    const first = await publishFrameV2FromSource(auth, {
      conversation,
      frame,
      manifestPath,
    });
    assert(first.isOk());
    const manifestKey = [...sourceByPath.keys()].find((path) =>
      path.endsWith(`/${FRAME_MANIFEST_FILE}`)
    );
    assert(manifestKey);
    sourceByPath.set(manifestKey, TEST_FRAME_APP_MANIFEST);
    const reloaded = await FileResource.fetchById(auth, frame.sId);
    assert(reloaded);

    const result = await publishFrameV2FromSource(auth, {
      conversation,
      frame: reloaded,
      manifestPath,
    });

    assert(result.isErr());
    expect(result.error).toMatchObject({
      code: "frame_app_creation_not_allowed",
    });
    expect(result.error.message).toContain(
      "not allowed to create or update Frame Apps"
    );
    expect(buildSandboxFunctionOnReadySandbox).not.toHaveBeenCalled();
    const afterRefusal = await FileResource.fetchById(auth, frame.sId);
    expect(afterRefusal?.useCaseMetadata?.activePublicationId).toBe(
      first.value.publicationId
    );
  });

  it("lets an admin create a Frame App without any grant", async () => {
    const { auth, conversation, frame, manifestPath } =
      await FrameAppFactory.buildable("admin");

    const result = await publishFrameV2FromSource(auth, {
      conversation,
      frame,
      manifestPath,
    });

    expect(result.isOk()).toBe(true);
  });

  it("lets a member of a granted group create a Frame App", async () => {
    const { conversation, frame, manifestPath, user, workspace } =
      await FrameAppFactory.buildable("user");
    await grantWorkspacePermission(workspace, user, {
      grantType: "create",
      resourceType: "frame_app",
    });
    const memberAuth = await Authenticator.fromUserIdAndWorkspaceId(
      user.sId,
      workspace.sId
    );

    const result = await publishFrameV2FromSource(memberAuth, {
      conversation,
      frame,
      manifestPath,
    });

    expect(result.isOk()).toBe(true);
  });

  it.each<{ mode: string; isInDraftMode: boolean }>([
    { mode: "live", isInDraftMode: false },
    { mode: "draft", isInDraftMode: true },
  ])(
    "refuses a new $mode version of a Frame App to a member who lost the grant and keeps it live",
    async ({ isInDraftMode }) => {
      const { conversation, frame, manifestPath, user, workspace } =
        await FrameAppFactory.buildable("user");
      const internalAuth = await Authenticator.internalAdminForWorkspace(
        workspace.sId
      );
      await GroupPermissionResource.setForEverybody(internalAuth, {
        grantType: "create",
        resourceType: "frame_app",
      });
      const grantedAuth = await Authenticator.fromUserIdAndWorkspaceId(
        user.sId,
        workspace.sId
      );
      const first = await publishFrameV2FromSource(grantedAuth, {
        conversation,
        frame,
        manifestPath,
      });
      assert(first.isOk());
      await GroupPermissionResource.disable(internalAuth, {
        grantType: "create",
        resourceType: "frame_app",
      });
      const revokedAuth = await Authenticator.fromUserIdAndWorkspaceId(
        user.sId,
        workspace.sId
      );
      expect(revokedAuth.hasWorkspacePermission("create", "frame_app")).toBe(
        false
      );
      if (isInDraftMode) {
        assert((await enterFrameDraftMode(revokedAuth, { frame })).isOk());
      }
      const reloaded = await FileResource.fetchById(revokedAuth, frame.sId);
      assert(reloaded);
      expect(reloaded.isInFrameDraftMode).toBe(isInDraftMode);

      const second = await publishFrameV2FromSource(revokedAuth, {
        conversation,
        frame: reloaded,
        manifestPath,
      });

      assert(second.isErr());
      expect(second.error).toMatchObject({
        code: "frame_app_creation_not_allowed",
      });
      expect(second.error.message).toContain(
        "not allowed to create or update Frame Apps"
      );
      const afterRefusal = await FileResource.fetchById(revokedAuth, frame.sId);
      expect(afterRefusal?.useCaseMetadata?.activePublicationId).toBe(
        first.value.publicationId
      );
      expect(afterRefusal?.latestFramePublicationId).toBe(
        first.value.publicationId
      );
    }
  );

  it("refuses a manifest declaring only databases to a member without the grant", async () => {
    const { auth, conversation, frame, manifestPath } =
      await FrameAppFactory.conversationFrame({
        role: "user",
        manifestContent: JSON.stringify({
          version: 1,
          description: "Store items.",
          databases: [{ name: "items", schema: "databases/items.db.ts" }],
        }),
        extraSources: { "databases/items.db.ts": "export {};" },
      });
    await enableFrameApps(auth);

    const result = await publishFrameV2FromSource(auth, {
      conversation,
      frame,
      manifestPath,
    });

    assert(result.isErr());
    expect(result.error).toMatchObject({
      code: "frame_app_creation_not_allowed",
    });
    expect(result.error.message).toContain(
      "not allowed to create or update Frame Apps"
    );
    const reloaded = await FileResource.fetchById(auth, frame.sId);
    expect(reloaded?.useCaseMetadata?.activePublicationId).toBeUndefined();
  });

  it("resolves the grant from the member's full groups when an agent publishes from the sandbox", async () => {
    const { conversation, frame, manifestPath, user, workspace } =
      await FrameAppFactory.buildable("user");
    const internalAuth = await Authenticator.internalAdminForWorkspace(
      workspace.sId
    );
    const space = await SpaceFactory.regular(workspace);
    const [spaceGroup] = await space.fetchRegularAutoGroups(internalAuth);
    await GroupFactory.withMembers(internalAuth, spaceGroup, [user]);
    await ConversationFactory.setRequestedSpaceIdsForTest(
      conversation.id,
      workspace.id,
      [space.id]
    );
    await grantWorkspacePermission(workspace, user, {
      grantType: "create",
      resourceType: "frame_app",
    });
    const sandboxAuthRes = await Authenticator.fromSandboxToken(
      {
        wId: workspace.sId,
        cId: conversation.sId,
        uId: user.sId,
        aId: GLOBAL_AGENTS_SID.DUST,
        aV: 0,
        mId: "test-message-id",
        sbId: "test-sandbox-id",
        execId: "test-exec-id",
        actionId: "test-action-id",
      },
      workspace.sId
    );
    assert(sandboxAuthRes.isOk());
    const sandboxAuth = sandboxAuthRes.value;
    expect(sandboxAuth.hasWorkspacePermission("create", "frame_app")).toBe(
      false
    );

    const result = await publishFrameV2FromSource(sandboxAuth, {
      conversation,
      frame,
      manifestPath,
    });

    expect(result.isOk()).toBe(true);
  });

  it("infers TSX source content type from its extension", async () => {
    const { auth, conversation, frame, manifestPath } =
      await FrameAppFactory.conversationFrame({
        uiContentType: "application/x-tiled-tsx",
      });

    const result = await publishFrameV2FromSource(auth, {
      conversation,
      frame,
      manifestPath,
    });

    expect(result.isOk()).toBe(true);
  });

  it("rejects a path that does not match the Frame identity", async () => {
    const { auth, conversation, frame } =
      await FrameAppFactory.conversationFrame();

    const result = await publishFrameV2FromSource(auth, {
      conversation,
      frame,
      manifestPath: `conversation-${conversation.sId}/Other/manifest.json`,
    });

    expect(result.isErr() && result.error).toMatchObject({
      code: "invalid_source",
    });
    expect(fileStorageMock.saveFileCalls).toHaveLength(0);
  });

  it("revalidates the Frame source path after acquiring the source lock", async () => {
    const { auth, conversation, frame, manifestPath, workspace } =
      await FrameAppFactory.conversationFrame();
    const staleFrame = await FileResource.fetchById(auth, frame.sId);
    assert(staleFrame);
    const movedManifestPath = `${getConversationFilesBasePath({
      workspaceId: workspace.sId,
      conversationId: conversation.sId,
    })}Moved/${FRAME_MANIFEST_FILE}`;
    await frame.updateMount({
      destFileName: FRAME_MANIFEST_FILE,
      destMountFilePath: movedManifestPath,
      destUseCase: "conversation",
      destUseCaseMetadata: { conversationId: conversation.sId },
    });

    const result = await publishFrameV2FromSource(auth, {
      conversation,
      frame: staleFrame,
      manifestPath,
    });

    expect(result.isErr() && result.error).toMatchObject({
      code: "invalid_source",
    });
    expect(fileStorageMock.saveFileCalls).toHaveLength(0);
  });

  it("does not write when another source operation holds the lock", async () => {
    const { auth, conversation, frame, manifestPath } =
      await FrameAppFactory.conversationFrame();
    const lockKey = `lock:${getFrameSourceLockName(frame.sId)}`;
    const redisClient = await getRedisStreamClient({ origin: "lock" });
    await redisClient.set(lockKey, "held-by-test", {
      NX: true,
      PX: 60_000,
    });
    vi.useFakeTimers();

    try {
      const publicationPromise = publishFrameV2FromSource(auth, {
        conversation,
        frame,
        manifestPath,
      });
      await vi.runAllTimersAsync();
      const published = await publicationPromise;

      expect(published.isErr() && published.error).toMatchObject({
        code: "publish_conflict",
        message:
          "Another source operation is in progress for this Frame; retry shortly.",
      });
      expect(fileStorageMock.saveFileCalls).toHaveLength(0);
      expect(fileStorageMock.writeStreamCalls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
      await redisClient.del(lockKey);
    }
  });

  it("rejects publication from a read-only Pod", async () => {
    const {
      authenticator: auth,
      globalGroup,
      user,
      workspace,
    } = await createResourceTest({ role: "admin" });
    const space = await SpaceFactory.project(workspace);
    await SpaceFactory.attachGroup(space, globalGroup, "project_viewer");
    const viewerAuth = await Authenticator.fromUserIdAndWorkspaceId(
      user.sId,
      workspace.sId
    );
    assert(viewerAuth);
    expect(viewerAuth.can("read", space)).toBe(true);
    expect(viewerAuth.can("write", space)).toBe(false);

    const conversation = await ConversationFactory.create(auth, {
      agentConfigurationId: "test-agent",
      messagesCreatedAt: [],
    });
    const sourceDirectoryPath = `pod-${space.sId}/Status`;
    const manifestPath = `${sourceDirectoryPath}/${FRAME_MANIFEST_FILE}`;
    const gcsSourceDirectoryPath = `${getPodFilesBasePath({
      workspaceId: workspace.sId,
      podId: space.sId,
    })}Status`;
    const frame = await FileFactory.create(auth, null, {
      contentType: frameV2ContentType,
      fileName: FRAME_MANIFEST_FILE,
      fileSize: Buffer.byteLength(TEST_FRAME_MANIFEST),
      status: "created",
      useCase: "project_context",
      useCaseMetadata: { spaceId: space.sId },
      mountFilePath: `${gcsSourceDirectoryPath}/${FRAME_MANIFEST_FILE}`,
    });
    const accessibleFrame = await FileResource.fetchById(viewerAuth, frame.sId);
    assert(accessibleFrame);

    const result = await publishFrameV2FromSource(viewerAuth, {
      conversation,
      frame: accessibleFrame,
      manifestPath,
    });

    expect(result.isErr() && result.error).toMatchObject({
      code: "unauthorized",
    });
    expect(fileStorageMock.readStreamCalls).toHaveLength(0);
    expect(fileStorageMock.saveFileCalls).toHaveLength(0);
  });

  it("bounds source listing before reading the folder", async () => {
    const { auth, conversation, frame, gcsSourceDirectoryPath, manifestPath } =
      await FrameAppFactory.conversationFrame();
    fileStorageMock.setFilesByPrefix((prefix) =>
      prefix === `${gcsSourceDirectoryPath}/`
        ? Array.from({ length: 2_000 }, (_, index) => ({
            name: `${gcsSourceDirectoryPath}/file-${index}.txt`,
            metadata: { contentType: "text/plain", size: "1" },
          }))
        : null
    );

    const result = await publishFrameV2FromSource(auth, {
      conversation,
      frame,
      manifestPath,
    });

    expect(result.isErr() && result.error).toMatchObject({
      code: "invalid_source",
      message: "Frame source exceeds the publication file count limit.",
    });
    expect(fileStorageMock.readStreamCalls).toHaveLength(1);
    expect(fileStorageMock.saveFileCalls).toHaveLength(0);
  });
});
