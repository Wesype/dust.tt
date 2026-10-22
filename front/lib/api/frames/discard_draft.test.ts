import { emitAuditLogEvent } from "@app/lib/api/audit/workos_audit";
import { DustFileSystem, DustFileSystemError } from "@app/lib/api/file_system";
import { discardFrameDraft } from "@app/lib/api/frames/discard_draft";
import { enterFrameDraftMode } from "@app/lib/api/frames/draft_mode";
import { canWriteFrameV2Source } from "@app/lib/api/frames/permissions";
import { MAX_FRAME_SOURCE_FILE_COUNT } from "@app/lib/api/frames/publish_from_source";
import { seedFramePublicationFunctionsArchive } from "@app/lib/api/frames/seed_functions_archive";
import { buildFrameSourceTarArchive } from "@app/lib/api/frames/source_staging";
import type { Authenticator } from "@app/lib/auth";
import { getPrivateUploadBucket } from "@app/lib/file_storage";
import { FileResource } from "@app/lib/resources/file_resource";
import { ConversationFactory } from "@app/tests/utils/ConversationFactory";
import { FeatureFlagFactory } from "@app/tests/utils/FeatureFlagFactory";
import type { TestFrameSourceTree } from "@app/tests/utils/FramePublicationFactory";
import {
  createTestLiveFrameWithSource,
  publishTestFrameSourceTree,
} from "@app/tests/utils/FramePublicationFactory";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
import { fileStorageMock } from "@app/tests/utils/mocks/file_storage";
import { FRAME_MANIFEST_FILE } from "@app/types/api/frame_manifest";
import { getFramePublicationSourceArchivePath } from "@app/types/api/frame_storage";
import { GLOBAL_AGENTS_SID } from "@app/types/assistant/assistant";
import type { Result } from "@app/types/shared/result";
import { Err } from "@app/types/shared/result";
import assert from "assert";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@app/lib/api/frames/seed_functions_archive", () => ({
  seedFramePublicationFunctionsArchive: vi.fn().mockResolvedValue(undefined),
}));

// Records which Frame operation locks are held, so tests can check what runs under them.
const { heldFrameLocks } = vi.hoisted(() => ({
  heldFrameLocks: new Set<"source" | "publish">(),
}));

vi.mock("@app/lib/api/frames/operation_lock", async (importActual) => {
  const actual =
    await importActual<typeof import("@app/lib/api/frames/operation_lock")>();
  return {
    ...actual,
    withFrameSourceLock: <T, E>(
      frameId: string,
      callback: () => Promise<Result<T, E>>
    ) =>
      actual.withFrameSourceLock(frameId, async () => {
        heldFrameLocks.add("source");
        try {
          return await callback();
        } finally {
          heldFrameLocks.delete("source");
        }
      }),
    withFramePublishLock: <T, E>(
      frameId: string,
      callback: () => Promise<Result<T, E>>
    ) =>
      actual.withFramePublishLock(frameId, async () => {
        heldFrameLocks.add("publish");
        try {
          return await callback();
        } finally {
          heldFrameLocks.delete("publish");
        }
      }),
  };
});

vi.mock("@app/lib/api/audit/workos_audit", async (importActual) => {
  const actual =
    await importActual<typeof import("@app/lib/api/audit/workos_audit")>();
  return { ...actual, emitAuditLogEvent: vi.fn() };
});

vi.mock("@app/lib/api/frames/permissions", async (importActual) => {
  const actual =
    await importActual<typeof import("@app/lib/api/frames/permissions")>();
  return {
    ...actual,
    canWriteFrameV2Source: vi.fn(actual.canWriteFrameV2Source),
  };
});

const MANIFEST_SOURCE = JSON.stringify({
  version: 1,
  description: "Track tasks.",
  uiEntryPoint: "ui/App.tsx",
});
const LIVE_SOURCE: TestFrameSourceTree = {
  [FRAME_MANIFEST_FILE]: MANIFEST_SOURCE,
  "ui/App.tsx": "live",
  "ui/Same.tsx": "same",
  NOTES: "notes",
};

/** With `atMountRoot`, the Frame's manifest sits at the conversation's files root. */
async function setupLiveFrame({ atMountRoot = false } = {}) {
  const { authenticator: auth } = await createResourceTest({});
  await FeatureFlagFactory.basic(auth, "frames_v2_drafts");
  const conversation = await ConversationFactory.create(auth, {
    agentConfigurationId: GLOBAL_AGENTS_SID.DUST,
    messagesCreatedAt: [new Date()],
  });
  const { frame, liveId, sourceDirectory, setSource, getSource } =
    await createTestLiveFrameWithSource(auth, {
      conversationId: conversation.sId,
      tree: LIVE_SOURCE,
      atMountRoot,
    });

  return {
    auth,
    frame,
    liveId,
    setSource,
    getSource,
    sourceMountDirectory: sourceDirectory,
  };
}

function publish(
  auth: Authenticator,
  frame: FileResource,
  tree: TestFrameSourceTree,
  mode: "live" | "draft"
): Promise<string> {
  return publishTestFrameSourceTree(auth, { frame, tree, mode });
}

function sourceArchivePath(
  auth: Authenticator,
  frame: FileResource,
  publicationId: string
) {
  return getFramePublicationSourceArchivePath({
    workspaceId: auth.getNonNullableWorkspace().sId,
    frameId: frame.sId,
    publicationId,
  });
}

async function reload(auth: Authenticator, frame: FileResource) {
  const reloaded = await FileResource.fetchById(auth, frame.sId);
  assert(reloaded, "Frame still exists");
  return reloaded;
}

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.mocked(seedFramePublicationFunctionsArchive).mockResolvedValue(undefined);
  vi.mocked(emitAuditLogEvent).mockClear();
  fileStorageMock.reset();
});

describe("discardFrameDraft", () => {
  it("restores the live source, drops the pending draft and exits draft mode", async () => {
    const { auth, frame, liveId, setSource, getSource, sourceMountDirectory } =
      await setupLiveFrame();
    assert((await enterFrameDraftMode(auth, { frame })).isOk());
    setSource("ui/App.tsx", "draft");
    setSource("ui/components/New.tsx", "new");
    const draftId = await publish(
      auth,
      frame,
      {
        ...LIVE_SOURCE,
        "ui/App.tsx": "draft",
        "ui/components/New.tsx": "new",
      },
      "draft"
    );
    const savesBeforeDiscard = fileStorageMock.saveFileCalls.length;

    const result = await discardFrameDraft(auth, {
      frame,
      draftPublicationId: draftId,
    });

    expect(result.isOk() && result.value).toEqual({ publicationId: liveId });
    expect(getSource("ui/App.tsx")).toBe("live");
    expect(getSource("ui/components/New.tsx")).toBeUndefined();
    expect(getSource("ui/Same.tsx")).toBe("same");
    expect(getSource(FRAME_MANIFEST_FILE)).toBe(MANIFEST_SOURCE);
    const discardWrites = fileStorageMock.saveFileCalls
      .slice(savesBeforeDiscard)
      .map((call) => call.filePath);
    expect(discardWrites).toEqual([`${sourceMountDirectory}/ui/App.tsx`]);

    const reloaded = await reload(auth, frame);
    expect(reloaded.useCaseMetadata?.activePublicationId).toBe(liveId);
    expect(reloaded.latestFramePublicationId).toBe(liveId);
    expect(reloaded.pendingDraftPublicationId).toBeUndefined();
    expect(reloaded.isInFrameDraftMode).toBe(false);
    expect(emitAuditLogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "frame.draft_mode_updated",
        metadata: { frame_id: frame.sId, draft_mode: "off" },
      })
    );
    expect(emitAuditLogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "frame.draft_discarded",
        metadata: { frame_id: frame.sId, discarded_publication_id: draftId },
      })
    );
  });

  it("recreates deleted files with the content type publish would give them", async () => {
    const { auth, frame, getSource, sourceMountDirectory } =
      await setupLiveFrame();
    assert((await enterFrameDraftMode(auth, { frame })).isOk());
    await getPrivateUploadBucket().delete(`${sourceMountDirectory}/ui/App.tsx`);
    await getPrivateUploadBucket().delete(`${sourceMountDirectory}/NOTES`);
    const savesBeforeDiscard = fileStorageMock.saveFileCalls.length;

    const result = await discardFrameDraft(auth, { frame });

    assert(result.isOk(), "discard succeeds");
    expect(getSource("ui/App.tsx")).toBe("live");
    expect(getSource("NOTES")).toBe("notes");
    const writtenTypes = new Map(
      fileStorageMock.saveFileCalls
        .slice(savesBeforeDiscard)
        .map((call) => [call.filePath, call.contentType])
    );
    expect(writtenTypes.get(`${sourceMountDirectory}/ui/App.tsx`)).toBe(
      "text/typescript"
    );
    expect(writtenTypes.get(`${sourceMountDirectory}/NOTES`)).toBe(
      "application/octet-stream"
    );
  });

  it("resets the source with no pending draft", async () => {
    const { auth, frame, liveId, setSource, getSource } =
      await setupLiveFrame();
    assert((await enterFrameDraftMode(auth, { frame })).isOk());
    setSource("ui/App.tsx", "edited");
    setSource("ui/Extra.tsx", "extra");

    const result = await discardFrameDraft(auth, { frame });

    expect(result.isOk() && result.value).toEqual({ publicationId: liveId });
    expect(getSource("ui/App.tsx")).toBe("live");
    expect(getSource("ui/Extra.tsx")).toBeUndefined();
    const reloaded = await reload(auth, frame);
    expect(reloaded.useCaseMetadata?.activePublicationId).toBe(liveId);
    expect(reloaded.latestFramePublicationId).toBe(liveId);
    expect(reloaded.isInFrameDraftMode).toBe(false);
    expect(emitAuditLogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "frame.draft_discarded",
        metadata: { frame_id: frame.sId, discarded_publication_id: "" },
      })
    );
  });

  it("restores even when the draft broke the manifest", async () => {
    const { auth, frame, liveId, setSource, getSource } =
      await setupLiveFrame();
    assert((await enterFrameDraftMode(auth, { frame })).isOk());
    setSource(FRAME_MANIFEST_FILE, "{");

    const result = await discardFrameDraft(auth, { frame });

    expect(result.isOk() && result.value).toEqual({ publicationId: liveId });
    expect(getSource(FRAME_MANIFEST_FILE)).toBe(MANIFEST_SOURCE);
  });

  it("fails with source_not_stored and changes nothing", async () => {
    const { auth, frame, liveId, setSource, getSource } =
      await setupLiveFrame();
    assert((await enterFrameDraftMode(auth, { frame })).isOk());
    setSource("ui/App.tsx", "draft");
    const draftId = await publish(
      auth,
      frame,
      { ...LIVE_SOURCE, "ui/App.tsx": "draft" },
      "draft"
    );
    const archivePath = sourceArchivePath(auth, frame, liveId);
    await getPrivateUploadBucket().delete(archivePath);
    fileStorageMock.setFetchFileContentNotFound(
      (filePath) => filePath === archivePath
    );

    const result = await discardFrameDraft(auth, {
      frame,
      draftPublicationId: draftId,
    });

    assert(result.isErr(), "discard is refused");
    expect(result.error).toMatchObject({ code: "source_not_stored" });
    expect(getSource("ui/App.tsx")).toBe("draft");
    const reloaded = await reload(auth, frame);
    expect(reloaded.useCaseMetadata?.activePublicationId).toBe(liveId);
    expect(reloaded.latestFramePublicationId).toBe(draftId);
    expect(reloaded.isInFrameDraftMode).toBe(true);
  });

  it("refuses a Frame whose manifest sits at the mount root", async () => {
    const { auth, frame, liveId, setSource, getSource } = await setupLiveFrame({
      atMountRoot: true,
    });
    assert((await enterFrameDraftMode(auth, { frame })).isOk());
    setSource("ui/App.tsx", "draft");
    setSource("notes/todo.md", "conversation file");

    const result = await discardFrameDraft(auth, { frame });

    assert(result.isErr(), "discard is refused");
    expect(result.error).toMatchObject({ code: "unsupported_source_folder" });
    expect(getSource("ui/App.tsx")).toBe("draft");
    expect(getSource("notes/todo.md")).toBe("conversation file");
    const reloaded = await reload(auth, frame);
    expect(reloaded.useCaseMetadata?.activePublicationId).toBe(liveId);
    expect(reloaded.latestFramePublicationId).toBe(liveId);
    expect(reloaded.isInFrameDraftMode).toBe(true);
  });

  it("leaves hidden folders alone, as publish does", async () => {
    const { auth, frame, setSource, getSource } = await setupLiveFrame();
    assert((await enterFrameDraftMode(auth, { frame })).isOk());
    setSource("ui/App.tsx", "draft");
    setSource(`.backup/${FRAME_MANIFEST_FILE}`, MANIFEST_SOURCE);
    setSource(".vite/cache.json", "{}");

    const result = await discardFrameDraft(auth, { frame });

    assert(result.isOk(), "discard succeeds");
    expect(getSource("ui/App.tsx")).toBe("live");
    expect(getSource(`.backup/${FRAME_MANIFEST_FILE}`)).toBe(MANIFEST_SOURCE);
    expect(getSource(".vite/cache.json")).toBe("{}");
  });

  it("refuses a Frame folder that contains another Frame", async () => {
    const { auth, frame, liveId, setSource, getSource } =
      await setupLiveFrame();
    assert((await enterFrameDraftMode(auth, { frame })).isOk());
    setSource("ui/App.tsx", "draft");
    setSource(`sub/${FRAME_MANIFEST_FILE}`, MANIFEST_SOURCE);
    setSource("sub/ui/App.tsx", "nested");
    const draftId = await publish(
      auth,
      frame,
      { ...LIVE_SOURCE, "ui/App.tsx": "draft" },
      "draft"
    );

    const result = await discardFrameDraft(auth, {
      frame,
      draftPublicationId: draftId,
    });

    assert(result.isErr(), "discard is refused");
    expect(result.error).toMatchObject({ code: "unsupported_source_folder" });
    expect(getSource("ui/App.tsx")).toBe("draft");
    expect(getSource(`sub/${FRAME_MANIFEST_FILE}`)).toBe(MANIFEST_SOURCE);
    expect(getSource("sub/ui/App.tsx")).toBe("nested");
    const reloaded = await reload(auth, frame);
    expect(reloaded.useCaseMetadata?.activePublicationId).toBe(liveId);
    expect(reloaded.latestFramePublicationId).toBe(draftId);
    expect(reloaded.isInFrameDraftMode).toBe(true);
  });

  it("refuses a Frame folder whose listing is truncated, before any write", async () => {
    const { auth, frame, liveId, setSource, getSource } =
      await setupLiveFrame();
    assert((await enterFrameDraftMode(auth, { frame })).isOk());
    setSource("ui/App.tsx", "draft");
    const extraFiles = Array.from(
      { length: MAX_FRAME_SOURCE_FILE_COUNT + 1 },
      (_, index) => `extra/file-${index}.txt`
    );
    for (const relativePath of extraFiles) {
      setSource(relativePath, "extra");
    }
    const savesBeforeDiscard = fileStorageMock.saveFileCalls.length;

    const result = await discardFrameDraft(auth, { frame });

    assert(result.isErr(), "discard is refused");
    expect(result.error).toMatchObject({ code: "unsupported_source_folder" });
    expect(fileStorageMock.saveFileCalls.length).toBe(savesBeforeDiscard);
    expect(getSource("ui/App.tsx")).toBe("draft");
    expect(
      extraFiles.filter((relativePath) => getSource(relativePath) === undefined)
    ).toEqual([]);
    const reloaded = await reload(auth, frame);
    expect(reloaded.useCaseMetadata?.activePublicationId).toBe(liveId);
    expect(reloaded.latestFramePublicationId).toBe(liveId);
    expect(reloaded.isInFrameDraftMode).toBe(true);
  });

  it("fails with source_archive_invalid when the archive does not match the live publication", async () => {
    const { auth, frame, liveId, setSource, getSource } =
      await setupLiveFrame();
    assert((await enterFrameDraftMode(auth, { frame })).isOk());
    setSource("ui/App.tsx", "draft");
    const otherArchive = await buildFrameSourceTarArchive(
      Object.entries({ ...LIVE_SOURCE, "ui/App.tsx": "other" }).map(
        ([relativePath, content]) => ({
          relativePath,
          content: Buffer.from(content),
        })
      )
    );
    fileStorageMock.setObject(
      sourceArchivePath(auth, frame, liveId),
      otherArchive.toString()
    );

    const result = await discardFrameDraft(auth, { frame });

    assert(result.isErr(), "discard is refused");
    expect(result.error).toMatchObject({ code: "source_archive_invalid" });
    expect(getSource("ui/App.tsx")).toBe("draft");
    expect((await reload(auth, frame)).isInFrameDraftMode).toBe(true);
  });

  it("fails with draft_conflict when the named draft is no longer pending", async () => {
    const { auth, frame, liveId, getSource } = await setupLiveFrame();
    assert((await enterFrameDraftMode(auth, { frame })).isOk());
    const staleDraftId = await publish(
      auth,
      frame,
      { ...LIVE_SOURCE, "ui/App.tsx": "draft-1" },
      "draft"
    );
    const pendingDraftId = await publish(
      auth,
      frame,
      { ...LIVE_SOURCE, "ui/App.tsx": "draft-2" },
      "draft"
    );

    const result = await discardFrameDraft(auth, {
      frame,
      draftPublicationId: staleDraftId,
    });

    assert(result.isErr(), "discard is refused");
    expect(result.error).toMatchObject({ code: "draft_conflict" });
    expect(getSource("ui/App.tsx")).toBe("live");
    const reloaded = await reload(auth, frame);
    expect(reloaded.useCaseMetadata?.activePublicationId).toBe(liveId);
    expect(reloaded.latestFramePublicationId).toBe(pendingDraftId);
    expect(reloaded.isInFrameDraftMode).toBe(true);
  });

  it("fails with draft_conflict when the caller saw no draft but one is now pending", async () => {
    const { auth, frame, liveId, setSource, getSource } =
      await setupLiveFrame();
    assert((await enterFrameDraftMode(auth, { frame })).isOk());
    setSource("ui/App.tsx", "draft");
    const pendingDraftId = await publish(
      auth,
      frame,
      { ...LIVE_SOURCE, "ui/App.tsx": "draft" },
      "draft"
    );

    const result = await discardFrameDraft(auth, {
      frame,
      draftPublicationId: liveId,
    });

    assert(result.isErr(), "discard is refused");
    expect(result.error).toMatchObject({ code: "draft_conflict" });
    expect(getSource("ui/App.tsx")).toBe("draft");
    const reloaded = await reload(auth, frame);
    expect(reloaded.useCaseMetadata?.activePublicationId).toBe(liveId);
    expect(reloaded.latestFramePublicationId).toBe(pendingDraftId);
    expect(reloaded.isInFrameDraftMode).toBe(true);
  });

  it("resets the source when the caller saw no draft and none is pending", async () => {
    const { auth, frame, liveId, setSource, getSource } =
      await setupLiveFrame();
    assert((await enterFrameDraftMode(auth, { frame })).isOk());
    setSource("ui/App.tsx", "edited");

    const result = await discardFrameDraft(auth, {
      frame,
      draftPublicationId: liveId,
    });

    expect(result.isOk() && result.value).toEqual({ publicationId: liveId });
    expect(getSource("ui/App.tsx")).toBe("live");
    expect((await reload(auth, frame)).isInFrameDraftMode).toBe(false);
  });

  it("fails with not_in_draft_mode outside draft mode", async () => {
    const { auth, frame, setSource, getSource } = await setupLiveFrame();
    setSource("ui/App.tsx", "edited");

    const result = await discardFrameDraft(auth, { frame });

    assert(result.isErr(), "discard is refused");
    expect(result.error).toMatchObject({ code: "not_in_draft_mode" });
    expect(getSource("ui/App.tsx")).toBe("edited");
  });

  it("fails with unauthorized without write access", async () => {
    const { auth, frame, setSource, getSource } = await setupLiveFrame();
    assert((await enterFrameDraftMode(auth, { frame })).isOk());
    setSource("ui/App.tsx", "draft");
    let locksHeldDuringCheck: string[] = [];
    vi.mocked(canWriteFrameV2Source).mockImplementationOnce(async () => {
      locksHeldDuringCheck = [...heldFrameLocks].sort();
      return false;
    });

    const result = await discardFrameDraft(auth, { frame });

    assert(result.isErr(), "discard is refused");
    expect(result.error).toMatchObject({ code: "unauthorized" });
    expect(locksHeldDuringCheck).toEqual(["publish", "source"]);
    expect(getSource("ui/App.tsx")).toBe("draft");
    expect((await reload(auth, frame)).isInFrameDraftMode).toBe(true);
  });

  it("changes no pointer when a write fails, and a retry converges", async () => {
    const { auth, frame, liveId, setSource, getSource } =
      await setupLiveFrame();
    assert((await enterFrameDraftMode(auth, { frame })).isOk());
    setSource("ui/App.tsx", "draft");
    setSource("ui/components/New.tsx", "new");
    const draftId = await publish(
      auth,
      frame,
      {
        ...LIVE_SOURCE,
        "ui/App.tsx": "draft",
        "ui/components/New.tsx": "new",
      },
      "draft"
    );
    vi.spyOn(DustFileSystem.prototype, "write").mockResolvedValueOnce(
      new Err(new DustFileSystemError("internal", "Simulated write failure."))
    );

    const failed = await discardFrameDraft(auth, {
      frame,
      draftPublicationId: draftId,
    });

    assert(failed.isErr(), "discard fails");
    expect(failed.error).toMatchObject({ code: "restore_failed" });
    const afterFailure = await reload(auth, frame);
    expect(afterFailure.useCaseMetadata?.activePublicationId).toBe(liveId);
    expect(afterFailure.latestFramePublicationId).toBe(draftId);
    expect(afterFailure.isInFrameDraftMode).toBe(true);

    const retried = await discardFrameDraft(auth, {
      frame,
      draftPublicationId: draftId,
    });

    expect(retried.isOk() && retried.value).toEqual({ publicationId: liveId });
    expect(getSource("ui/App.tsx")).toBe("live");
    expect(getSource("ui/components/New.tsx")).toBeUndefined();
    const afterRetry = await reload(auth, frame);
    expect(afterRetry.latestFramePublicationId).toBe(liveId);
    expect(afterRetry.isInFrameDraftMode).toBe(false);
  });
});
