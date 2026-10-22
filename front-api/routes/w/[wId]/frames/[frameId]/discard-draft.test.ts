import { enterFrameDraftMode } from "@app/lib/api/frames/draft_mode";
import { seedFramePublicationFunctionsArchive } from "@app/lib/api/frames/seed_functions_archive";
import { getPrivateUploadBucket } from "@app/lib/file_storage";
import { ConversationFactory } from "@app/tests/utils/ConversationFactory";
import { FeatureFlagFactory } from "@app/tests/utils/FeatureFlagFactory";
import { FileFactory } from "@app/tests/utils/FileFactory";
import { makeTestFrameFunction } from "@app/tests/utils/FrameFunctionFactory";
import type { TestFrameSourceTree } from "@app/tests/utils/FramePublicationFactory";
import {
  createTestLiveFrameWithSource,
  publishTestFrameSourceTree,
} from "@app/tests/utils/FramePublicationFactory";
import { createPrivateApiMockRequest } from "@app/tests/utils/generic_private_api_tests";
import { fileStorageMock } from "@app/tests/utils/mocks/file_storage";
import { FRAME_MANIFEST_FILE } from "@app/types/api/frame_manifest";
import { getFramePublicationSourceArchivePath } from "@app/types/api/frame_storage";
import { frameContentType } from "@app/types/files";
import { honoApp } from "@front-api/app";
import assert from "assert";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@app/lib/api/frames/seed_functions_archive", () => ({
  seedFramePublicationFunctionsArchive: vi.fn().mockResolvedValue(undefined),
}));

const LIVE_SOURCE: TestFrameSourceTree = {
  [FRAME_MANIFEST_FILE]: JSON.stringify({
    version: 1,
    description: "Track tasks.",
  }),
  "index.tsx": "export default function A() {}",
  "data.json": "{}",
};

/** A Frame published live, then in draft mode with a pending draft. */
async function setupFrameInDraftMode() {
  const { auth, workspace } = await createPrivateApiMockRequest({
    role: "admin",
  });
  await FeatureFlagFactory.basic(auth, "frames_v2_drafts");
  const conversation = await ConversationFactory.create(auth, {
    agentConfigurationId: "test-agent",
    messagesCreatedAt: [],
  });
  const { frame, liveId } = await createTestLiveFrameWithSource(auth, {
    conversationId: conversation.sId,
    tree: LIVE_SOURCE,
  });
  assert((await enterFrameDraftMode(auth, { frame })).isOk());
  await publishTestFrameSourceTree(auth, {
    frame,
    tree: { ...LIVE_SOURCE, "index.tsx": "export default function B() {}" },
    mode: "draft",
  });
  return { auth, workspace, frame, liveId };
}

function postDiscardDraft(
  workspaceId: string,
  frameId: string,
  body: unknown = {}
) {
  return honoApp.request(
    `/api/w/${workspaceId}/frames/${frameId}/discard-draft`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.mocked(seedFramePublicationFunctionsArchive).mockResolvedValue(undefined);
  fileStorageMock.reset();
});

describe("POST /api/w/:wId/frames/:frameId/discard-draft", () => {
  it("discards the draft", async () => {
    const { workspace, frame, liveId } = await setupFrameInDraftMode();

    const response = await postDiscardDraft(workspace.sId, frame.sId);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ publicationId: liveId });
    const permissions = await honoApp.request(
      `/api/w/${workspace.sId}/frames/${frame.sId}/permissions`
    );
    await expect(permissions.json()).resolves.toMatchObject({
      draftMode: false,
      draftPublicationId: null,
    });
  });

  it("answers 409 frame_draft_conflict when draft mode is already off", async () => {
    const { workspace, frame } = await setupFrameInDraftMode();
    const first = await postDiscardDraft(workspace.sId, frame.sId);
    expect(first.status).toBe(200);

    const second = await postDiscardDraft(workspace.sId, frame.sId);

    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toMatchObject({
      error: { type: "frame_draft_conflict" },
    });
  });

  it("answers 409 frame_draft_conflict when the draft id is stale", async () => {
    const { workspace, frame } = await setupFrameInDraftMode();

    const response = await postDiscardDraft(workspace.sId, frame.sId, {
      draftPublicationId: "stale-draft",
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { type: "frame_draft_conflict" },
    });
  });

  it("answers 409 frame_discard_unavailable without a stored source", async () => {
    const { workspace, frame, liveId } = await setupFrameInDraftMode();
    const archivePath = getFramePublicationSourceArchivePath({
      workspaceId: workspace.sId,
      frameId: frame.sId,
      publicationId: liveId,
    });
    expect(fileStorageMock.getObject(archivePath)).toBeDefined();
    await getPrivateUploadBucket().delete(archivePath);
    fileStorageMock.setFetchFileContentNotFound(
      (filePath) => filePath === archivePath
    );

    const response = await postDiscardDraft(workspace.sId, frame.sId);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { type: "frame_discard_unavailable" },
    });
  });

  it("answers 403 file_read_only for a user who cannot edit the Frame", async () => {
    const { frame, workspace } = await makeTestFrameFunction();

    const response = await postDiscardDraft(workspace.sId, frame.sId);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { type: "file_read_only" },
    });
  });

  it("answers 404 for a file that is not a Frames v2 file", async () => {
    const { auth, workspace } = await createPrivateApiMockRequest({
      role: "admin",
    });
    const legacyFrame = await FileFactory.create(auth, null, {
      contentType: frameContentType,
      fileName: "legacy-frame.tsx",
      fileSize: 10,
      status: "ready",
      useCase: "conversation",
    });

    const response = await postDiscardDraft(workspace.sId, legacyFrame.sId);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { type: "file_not_found" },
    });
  });

  it("answers 404 for a file that does not exist", async () => {
    const { workspace } = await createPrivateApiMockRequest({ role: "admin" });

    const response = await postDiscardDraft(workspace.sId, "fil_missing");

    expect(response.status).toBe(404);
  });
});
