import { computeFrameSourcePathSetSha256 } from "@app/lib/api/frames/source_staging";
import {
  ensureConversationSandboxReadyWithScope,
  ensureFrameSandboxReady,
} from "@app/lib/api/sandbox/lifecycle";
import { buildSandboxFunctionOnReadySandbox } from "@app/lib/api/sandbox_functions/build_on_sandbox";
import { Authenticator } from "@app/lib/auth";
import { ConversationFactory } from "@app/tests/utils/ConversationFactory";
import { FileFactory } from "@app/tests/utils/FileFactory";
import { enableFrameApps } from "@app/tests/utils/FrameFunctionFactory";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
import { fileStorageMock } from "@app/tests/utils/mocks/file_storage";
import { SandboxFactory } from "@app/tests/utils/SandboxFactory";
import { FRAME_MANIFEST_FILE } from "@app/types/api/frame_manifest";
import type { ConversationWithoutContentType } from "@app/types/assistant/conversation";
import { frameV2ContentType } from "@app/types/files";
import type { MembershipRoleType } from "@app/types/memberships";
import { getConversationFilesBasePath } from "@app/types/mount_path";
import { Err, Ok } from "@app/types/shared/result";
import type { LightWorkspaceType } from "@app/types/user";
import { vi } from "vitest";

export const TEST_FRAME_MANIFEST = JSON.stringify({
  version: 1,
  name: "Status",
  description: "Show the current status.",
});
export const TEST_FRAME_UI_SOURCE =
  "export default function Status() { return <p>Ready</p>; }";
export const TEST_FRAME_APP_MANIFEST = JSON.stringify({
  version: 1,
  description: "Run a function.",
  functions: [
    { name: "run", description: "Run it.", entryPoint: "functions/run.ts" },
  ],
});
export const TEST_FRAME_APP_SOURCES = {
  "functions/run.ts":
    "export default { fetch: async () => Response.json({}) };",
};

type ConversationFrameInput = {
  uiContentType?: string;
  manifestContent?: string;
  extraSources?: Record<string, string>;
  role?: MembershipRoleType;
};

type MockFunctionBuildInput = {
  conversation: ConversationWithoutContentType;
  sourceByPath: Map<string, string>;
  workspace: LightWorkspaceType;
};

export class FrameAppFactory {
  /**
   * A Frames v2 Frame without any publication, whose source sits in a conversation folder served
   * by the file storage mock. `sourceByPath` is live: changing it changes what the next publish
   * reads.
   */
  static async conversationFrame({
    uiContentType = "text/typescript",
    manifestContent = TEST_FRAME_MANIFEST,
    extraSources = {},
    role = "admin",
  }: ConversationFrameInput = {}) {
    const {
      authenticator: auth,
      user,
      workspace,
    } = await createResourceTest({
      role,
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
    const frame = await FileFactory.create(auth, null, {
      contentType: frameV2ContentType,
      fileName: FRAME_MANIFEST_FILE,
      fileSize: Buffer.byteLength(manifestContent),
      status: "created",
      useCase: "conversation",
      useCaseMetadata: { conversationId: conversation.sId },
      mountFilePath: `${gcsSourceDirectoryPath}/${FRAME_MANIFEST_FILE}`,
    });

    const sourceByPath = new Map([
      [`${gcsSourceDirectoryPath}/${FRAME_MANIFEST_FILE}`, manifestContent],
      [`${gcsSourceDirectoryPath}/index.tsx`, TEST_FRAME_UI_SOURCE],
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
              contentType: name.endsWith(".tsx")
                ? uiContentType
                : frameV2ContentType,
              size: String(Buffer.byteLength(content)),
            },
          }))
        : null
    );
    fileStorageMock.setFileContent(
      (filePath) => sourceByPath.get(filePath) ?? null
    );

    return {
      auth,
      conversation,
      frame,
      gcsSourceDirectoryPath,
      manifestPath,
      sourceByPath,
      user,
      workspace,
    };
  }

  /**
   * Makes a Frame function build succeed on a stubbed sandbox. The calling test file MUST mock
   * `@app/lib/api/sandbox/lifecycle` and `@app/lib/api/sandbox_functions/build_on_sandbox`.
   */
  static async mockFunctionBuild({
    conversation,
    sourceByPath,
    workspace,
  }: MockFunctionBuildInput) {
    const internalAuth = await Authenticator.internalAdminForWorkspace(
      workspace.sId
    );
    const sandbox = await SandboxFactory.create(internalAuth, conversation);
    const stagedRelativePaths = [
      FRAME_MANIFEST_FILE,
      "index.tsx",
      ...Object.keys(TEST_FRAME_APP_SOURCES),
    ];
    const pathSetSha256 = computeFrameSourcePathSetSha256(stagedRelativePaths);
    vi.spyOn(sandbox, "writeFile").mockResolvedValue(new Ok(undefined));
    vi.spyOn(sandbox, "execRoot").mockResolvedValue(
      new Ok({ exitCode: 0, stdout: `${pathSetSha256}  -\n`, stderr: "" })
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
    const ready = new Ok({
      sandbox,
      freshlyCreated: false,
      scope: { spaceId: null },
    });
    vi.mocked(ensureConversationSandboxReadyWithScope).mockResolvedValue(ready);
    vi.mocked(ensureFrameSandboxReady).mockResolvedValue(ready);
    vi.mocked(buildSandboxFunctionOnReadySandbox).mockResolvedValue(
      new Ok({
        bundleCode: "export default true;",
        userIdentity: "optional",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
      })
    );
  }

  /**
   * A conversation Frame with Frame functions enabled whose publish builds, see
   * `mockFunctionBuild` for the mocks it needs.
   */
  static async buildable(
    role: MembershipRoleType,
    manifestContent = TEST_FRAME_APP_MANIFEST
  ) {
    const context = await FrameAppFactory.conversationFrame({
      role,
      manifestContent,
      extraSources: TEST_FRAME_APP_SOURCES,
    });
    await enableFrameApps(context.auth);
    await FrameAppFactory.mockFunctionBuild(context);

    return context;
  }
}
