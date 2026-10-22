import path from "node:path";

import {
  buildAuditLogTarget,
  emitAuditLogEvent,
  getAuditLogContext,
} from "@app/lib/api/audit/workos_audit";
import { emitFrameDraftModeAuditLog } from "@app/lib/api/frames/draft_mode";
import {
  withFramePublishLock,
  withFrameSourceLock,
} from "@app/lib/api/frames/operation_lock";
import { canWriteFrameV2Source } from "@app/lib/api/frames/permissions";
import {
  loadFramePublicationDescriptor,
  sha256Hex,
} from "@app/lib/api/frames/publication_storage";
import {
  MAX_FRAME_SOURCE_FILE_COUNT,
  resolveWritableFrameV2Source,
} from "@app/lib/api/frames/publish_from_source";
import type { FrameSourceArchiveFile } from "@app/lib/api/frames/source_archive";
import { loadFrameSourceArchive } from "@app/lib/api/frames/source_archive";
import type { Authenticator } from "@app/lib/auth";
import { isLockAcquisitionTimeoutError } from "@app/lib/lock";
import type { FileResource } from "@app/lib/resources/file_resource";
import { concurrentExecutor } from "@app/lib/utils/async_utils";
import {
  FRAME_MANIFEST_FILE,
  getFrameV2NameFromManifestPath,
} from "@app/types/api/frame_manifest";
import type { FramePublicationDescriptor } from "@app/types/api/frame_publication";
import {
  contentTypeFromFileName,
  DEFAULT_FILE_CONTENT_TYPE,
} from "@app/types/files";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";
import assert from "assert";

const FRAME_SOURCE_RESTORE_CONCURRENCY = 4;

export class FrameDiscardDraftError extends Error {
  constructor(
    readonly code:
      | "unauthorized"
      | "frame_not_found"
      | "not_in_draft_mode"
      | "draft_conflict"
      | "source_not_stored"
      | "source_archive_invalid"
      | "restore_failed"
      | "unsupported_source_folder",
    message: string
  ) {
    super(message);
    this.name = "FrameDiscardDraftError";
  }
}

export function isFrameDiscardDraftError(
  error: unknown
): error is FrameDiscardDraftError {
  return error instanceof FrameDiscardDraftError;
}

type DiscardDraftResult = Result<
  { publicationId: string },
  FrameDiscardDraftError
>;

/** The archive holds exactly the descriptor's files: same paths, same content hashes. */
function archiveMatchesDescriptor(
  archivedFiles: FrameSourceArchiveFile[],
  descriptor: FramePublicationDescriptor
): boolean {
  if (archivedFiles.length !== descriptor.sourceFiles.length) {
    return false;
  }
  const sha256ByPath = new Map(
    descriptor.sourceFiles.map((file) => [file.path, file.contentSha256])
  );
  return archivedFiles.every(
    (file) => sha256ByPath.get(file.relativePath) === sha256Hex(file.content)
  );
}

function restoreFailedError(reason: string) {
  return new Err(
    new FrameDiscardDraftError(
      "restore_failed",
      `Could not restore the Frame's live source: ${reason} The source may be partially ` +
        "restored; discarding the draft again completes it."
    )
  );
}

function sharedSourceFolderError() {
  return new Err(
    new FrameDiscardDraftError(
      "unsupported_source_folder",
      "This Frame's folder also holds other files or Frames, so its draft cannot be " +
        "discarded automatically."
    )
  );
}

/**
 * Make the Frame's source folder hold exactly `archivedFiles`: write each archived file whose
 * current copy is missing or different, then delete every other file. Reads no manifest: the one
 * in the folder may be broken.
 */
async function restoreFrameSource(
  auth: Authenticator,
  {
    frame,
    archivedFiles,
  }: { frame: FileResource; archivedFiles: FrameSourceArchiveFile[] }
): Promise<Result<void, FrameDiscardDraftError>> {
  const resolved = await resolveWritableFrameV2Source(auth, frame);
  if (resolved.isErr()) {
    return resolved.error.code === "unauthorized"
      ? new Err(
          new FrameDiscardDraftError("unauthorized", resolved.error.message)
        )
      : restoreFailedError(resolved.error.message);
  }
  const { dustFs } = resolved.value;

  // Restoring deletes every file the archive lacks: only safe in a folder holding this Frame
  // alone, not a whole conversation or Pod (a manifest at a mount root has no source folder), nor
  // a folder that also holds another Frame.
  const sourceDirectoryPath = frame.getFrameV2SourceDirectoryPath(auth);
  if (!sourceDirectoryPath) {
    return sharedSourceFolderError();
  }

  // The listing leaves out hidden ("."-prefixed) folders and `.processed.` files, exactly as when
  // publish captures the source: those are not part of the Frame, so discard leaves them alone.
  // It is not capped (`maxFiles`), since a cap counts the hidden objects too and could cut off
  // files to delete.
  const listResult = await dustFs.list(sourceDirectoryPath);
  if (listResult.isErr()) {
    return restoreFailedError(listResult.error.message);
  }

  // A folder over the publish limit cannot hold a publishable Frame alone.
  if (listResult.value.length > MAX_FRAME_SOURCE_FILE_COUNT) {
    return new Err(
      new FrameDiscardDraftError(
        "unsupported_source_folder",
        "This Frame's folder holds too many files, so its draft cannot be discarded " +
          "automatically."
      )
    );
  }

  const holdsNestedFrame = listResult.value.some((entry) => {
    const relativePath = path.posix.relative(sourceDirectoryPath, entry.path);
    return (
      !entry.isDirectory &&
      relativePath !== FRAME_MANIFEST_FILE &&
      path.posix.basename(relativePath) === FRAME_MANIFEST_FILE
    );
  });
  if (holdsNestedFrame) {
    return sharedSourceFolderError();
  }

  const writeResults = await concurrentExecutor(
    archivedFiles,
    async ({ relativePath, content }) => {
      const filePath = path.posix.join(sourceDirectoryPath, relativePath);
      const current = await dustFs.readBuffer(filePath);
      if (current.isErr()) {
        return current;
      }
      if (current.value?.equals(content)) {
        return new Ok(undefined);
      }
      // Publish types a file by its extension, else by its stored GCS type, which for a name with
      // no known extension is the GCS default: restoring by name reproduces both.
      return dustFs.write(
        filePath,
        content,
        contentTypeFromFileName(relativePath) ?? DEFAULT_FILE_CONTENT_TYPE
      );
    },
    { concurrency: FRAME_SOURCE_RESTORE_CONCURRENCY }
  );
  const writeFailure = writeResults.find((result) => result.isErr());
  if (writeFailure?.isErr()) {
    return restoreFailedError(writeFailure.error.message);
  }

  const archivedPaths = new Set(
    archivedFiles.map((file) =>
      path.posix.join(sourceDirectoryPath, file.relativePath)
    )
  );
  const deleteResults = await concurrentExecutor(
    listResult.value.filter(
      (entry) => !entry.isDirectory && !archivedPaths.has(entry.path)
    ),
    (entry) => dustFs.delete(entry.path, { ignoreNotFound: true }),
    { concurrency: FRAME_SOURCE_RESTORE_CONCURRENCY }
  );
  const deleteFailure = deleteResults.find((result) => result.isErr());
  if (deleteFailure?.isErr()) {
    return restoreFailedError(deleteFailure.error.message);
  }

  return new Ok(undefined);
}

/**
 * @cc [owner:davidebbo,label:product] discard-restores-live-source
 * A successful discard MUST leave the Frame's source folder equal to the live publication's
 * archive, no pending draft, and draft mode off; it MUST NOT change `activePublicationId`; on any
 * failure it MUST leave both pointers and draft mode unchanged. It MUST fail with
 * `unsupported_source_folder`, before writing or deleting any file, when the source folder is a
 * mount root (conversation or Pod), holds another `manifest.json` below its top level, or holds
 * more entries than `MAX_FRAME_SOURCE_FILE_COUNT`. "The source folder" means the files publish
 * captures as the Frame's source: files under hidden ("."-prefixed) folders and `.processed.`
 * files are not part of it, and discard MUST neither write, delete nor count them.
 */
/**
 * @cc [owner:davidebbo,label:product] discard-requires-stored-source
 * Discard MUST fail with `source_not_stored`, changing nothing, when the live publication has no
 * archive.
 */
export async function discardFrameDraft(
  auth: Authenticator,
  {
    frame,
    draftPublicationId,
  }: {
    frame: FileResource;
    /**
     * The draft the caller saw, or the live publication when it saw none; omitted by callers
     * that only know the Frame.
     */
    draftPublicationId?: string;
  }
): Promise<DiscardDraftResult> {
  // Source lock first, then publish lock: the order publish and make-live take them in.
  const result = await withFrameSourceLock(frame.sId, () =>
    withFramePublishLock(frame.sId, async (): Promise<DiscardDraftResult> => {
      // Re-read under the locks: a move, publish or Save may have changed the Frame since the
      // caller fetched it, and write access follows its current mount.
      const fresh = await frame.fetchFreshFrameV2(auth);
      if (!fresh) {
        return new Err(
          new FrameDiscardDraftError("frame_not_found", "Frame not found.")
        );
      }
      if (!(await canWriteFrameV2Source(auth, fresh))) {
        return new Err(
          new FrameDiscardDraftError(
            "unauthorized",
            "You cannot edit this Frame."
          )
        );
      }
      if (!fresh.isInFrameDraftMode) {
        return new Err(
          new FrameDiscardDraftError(
            "not_in_draft_mode",
            "This Frame is not in draft mode."
          )
        );
      }
      const livePublicationId = fresh.useCaseMetadata?.activePublicationId;
      assert(
        livePublicationId,
        "A Frame in draft mode has a live publication."
      );
      const discardedPublicationId = fresh.pendingDraftPublicationId;
      // As in make-live, the live id means "I saw no pending draft": one pending since is unseen.
      const expectedDraftPublicationId =
        draftPublicationId === livePublicationId
          ? undefined
          : draftPublicationId;
      if (
        draftPublicationId !== undefined &&
        expectedDraftPublicationId !== discardedPublicationId
      ) {
        return new Err(
          new FrameDiscardDraftError(
            "draft_conflict",
            "This Frame's draft changed since you loaded it. Refresh and try again."
          )
        );
      }

      const archive = await loadFrameSourceArchive(auth, {
        frame: fresh,
        publicationId: livePublicationId,
      });
      if (archive.isErr()) {
        return new Err(
          new FrameDiscardDraftError("source_archive_invalid", archive.error)
        );
      }
      if (archive.value === null) {
        return new Err(
          new FrameDiscardDraftError(
            "source_not_stored",
            "This Frame's live version was published before its source was stored, so its " +
              "draft cannot be discarded."
          )
        );
      }
      const descriptor = await loadFramePublicationDescriptor(auth, {
        frame: fresh,
        publicationId: livePublicationId,
      });
      if (descriptor.isErr()) {
        return new Err(
          new FrameDiscardDraftError(
            "source_archive_invalid",
            descriptor.error.message
          )
        );
      }
      if (!archiveMatchesDescriptor(archive.value, descriptor.value)) {
        return new Err(
          new FrameDiscardDraftError(
            "source_archive_invalid",
            "The live publication's stored source does not match its descriptor."
          )
        );
      }

      const restored = await restoreFrameSource(auth, {
        frame: fresh,
        archivedFiles: archive.value,
      });
      if (restored.isErr()) {
        return restored;
      }

      await fresh.discardFrameDraftPointers();
      emitFrameDraftModeAuditLog(auth, fresh, "off");
      void emitAuditLogEvent({
        auth,
        action: "frame.draft_discarded",
        targets: [
          buildAuditLogTarget("workspace", auth.getNonNullableWorkspace()),
          buildAuditLogTarget("frame", {
            sId: fresh.sId,
            name:
              (fresh.mountFilePath
                ? getFrameV2NameFromManifestPath(fresh.mountFilePath)
                : null) ?? fresh.sId,
          }),
        ],
        context: getAuditLogContext(auth),
        metadata: {
          frame_id: fresh.sId,
          discarded_publication_id: discardedPublicationId ?? "",
        },
      });
      return new Ok({ publicationId: livePublicationId });
    })
  );
  if (result.isErr()) {
    return new Err(
      isLockAcquisitionTimeoutError(result.error)
        ? new FrameDiscardDraftError(
            "draft_conflict",
            "This Frame is being published; retry shortly."
          )
        : result.error
    );
  }
  return new Ok(result.value);
}
