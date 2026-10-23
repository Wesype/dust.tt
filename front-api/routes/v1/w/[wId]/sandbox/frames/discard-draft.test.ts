import { enterFrameDraftMode } from "@app/lib/api/frames/draft_mode";
import { getPrivateUploadBucket } from "@app/lib/file_storage";
import { FileResource } from "@app/lib/resources/file_resource";
import { FeatureFlagFactory } from "@app/tests/utils/FeatureFlagFactory";
import { createTestLiveConversationFrame } from "@app/tests/utils/FrameFunctionFactory";
import type { TestFrameSourceTree } from "@app/tests/utils/FramePublicationFactory";
import { createTestFrameInDraftMode } from "@app/tests/utils/FramePublicationFactory";
import { fileStorageMock } from "@app/tests/utils/mocks/file_storage";
import { createSandboxTokenTestContext } from "@app/tests/utils/SandboxTokenFactory";
import { FRAME_MANIFEST_FILE } from "@app/types/api/frame_manifest";
import { getFramePublicationSourceArchivePath } from "@app/types/api/frame_storage";
import { honoApp } from "@front-api/app";
import assert from "assert";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@app/lib/lock", async (importActual) => {
  const actual = await importActual<typeof import("@app/lib/lock")>();
  return {
    ...actual,
    executeWithLock: async <T>(_name: string, cb: () => Promise<T>) => cb(),
  };
});

const FOLDER_NAME = "Frame";
const LIVE_SOURCE: TestFrameSourceTree = {
  [FRAME_MANIFEST_FILE]: JSON.stringify({
    version: 1,
    description: "Track tasks.",
  }),
  "index.tsx": "export default () => 'A';",
};

function requestDiscardDraft(
  context: Awaited<ReturnType<typeof createSandboxTokenTestContext>>,
  manifestPath: string
) {
  return honoApp.request(
    `/api/v1/w/${context.workspace.sId}/sandbox/frames/discard-draft`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${context.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ manifestPath }),
    }
  );
}

/** A Frame published live, then in draft mode with a pending draft, in the token's conversation. */
async function setupFrameInDraftMode(
  context: Awaited<ReturnType<typeof createSandboxTokenTestContext>>
) {
  await FeatureFlagFactory.basic(context.auth, "frames_v2_drafts");
  return createTestFrameInDraftMode(context.auth, {
    conversationId: context.conversation.sId,
    folderName: FOLDER_NAME,
    tree: LIVE_SOURCE,
    draftTree: { ...LIVE_SOURCE, "index.tsx": "export default () => 'B';" },
  });
}

beforeEach(() => {
  fileStorageMock.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/v1/w/[wId]/sandbox/frames/discard-draft", () => {
  it("discards the draft of a Frame in the token's conversation", async () => {
    const context = await createSandboxTokenTestContext();
    const { frame, liveId } = await setupFrameInDraftMode(context);

    const response = await requestDiscardDraft(
      context,
      `conversation-${context.conversation.sId}/${FOLDER_NAME}/${FRAME_MANIFEST_FILE}`
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      frameId: frame.sId,
      publicationId: liveId,
    });
    const reloaded = await FileResource.fetchById(context.auth, frame.sId);
    expect(reloaded?.useCaseMetadata?.activePublicationId).toBe(liveId);
    expect(reloaded?.latestFramePublicationId).toBe(liveId);
    expect(reloaded?.pendingDraftPublicationId).toBeUndefined();
    expect(reloaded?.isInFrameDraftMode).toBe(false);
  });

  it("answers 409 frame_discard_unavailable without a stored source", async () => {
    const context = await createSandboxTokenTestContext();
    const { frame, liveId } = await setupFrameInDraftMode(context);
    const archivePath = getFramePublicationSourceArchivePath({
      workspaceId: context.workspace.sId,
      frameId: frame.sId,
      publicationId: liveId,
    });
    expect(fileStorageMock.getObject(archivePath)).toBeDefined();
    await getPrivateUploadBucket().delete(archivePath);
    fileStorageMock.setFetchFileContentNotFound(
      (filePath) => filePath === archivePath
    );

    const response = await requestDiscardDraft(
      context,
      `conversation-${context.conversation.sId}/${FOLDER_NAME}/${FRAME_MANIFEST_FILE}`
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { type: "frame_discard_unavailable" },
    });
    const reloaded = await FileResource.fetchById(context.auth, frame.sId);
    expect(reloaded?.isInFrameDraftMode).toBe(true);
  });

  it("returns 403 frame_not_in_conversation for a Frame in another conversation", async () => {
    const context = await createSandboxTokenTestContext();
    const { conversation: other, frame } =
      await createTestLiveConversationFrame(context.auth);
    assert((await enterFrameDraftMode(context.auth, { frame })).isOk());

    const response = await requestDiscardDraft(
      context,
      `conversation-${other.sId}/Frame/${FRAME_MANIFEST_FILE}`
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { type: "frame_not_in_conversation" },
    });
    const reloaded = await FileResource.fetchById(context.auth, frame.sId);
    expect(reloaded?.isInFrameDraftMode).toBe(true);
  });
});
