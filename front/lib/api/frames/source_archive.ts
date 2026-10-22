import { Readable } from "node:stream";

import { FRAME_FUNCTIONS_ARCHIVE_CONTENT_TYPE } from "@app/lib/api/frames/functions_archive";
import type { Authenticator } from "@app/lib/auth";
import { getPrivateUploadBucket } from "@app/lib/file_storage";
import { isGCSNotFoundError } from "@app/lib/file_storage/types";
import type { FileResource } from "@app/lib/resources/file_resource";
import { isSafeFrameRelativePath } from "@app/types/api/frame_manifest";
import { getFramePublicationSourceArchivePath } from "@app/types/api/frame_storage";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";
import { normalizeError } from "@app/types/shared/utils/error_utils";
import { Parser } from "tar";

export const FRAME_SOURCE_ARCHIVE_CONTENT_TYPE =
  FRAME_FUNCTIONS_ARCHIVE_CONTENT_TYPE;

export type FrameSourceArchiveFile = { relativePath: string; content: Buffer };

/**
 * Read a publication's `source.tar` (built by `buildFrameSourceTarArchive`: every source file at
 * its relative path). Only the paths are checked here; callers verify the files against the
 * publication's `sourceFiles` hashes.
 */
export async function parseFrameSourceArchive(
  archive: Buffer
): Promise<Result<FrameSourceArchiveFile[], string>> {
  const files: FrameSourceArchiveFile[] = [];
  let unsafePath: string | null = null;

  const parsed = await new Promise<Result<void, string>>((resolve) => {
    // Strict: bytes that are not a tar are an error, not an empty listing.
    const parser = new Parser({ strict: true });
    parser.on("entry", (entry) => {
      const relativePath = entry.path.replace(/^\.\//, "");
      if (entry.type !== "File") {
        entry.resume();
        return;
      }
      if (!isSafeFrameRelativePath(relativePath)) {
        unsafePath ??= relativePath;
        entry.resume();
        return;
      }

      const chunks: Buffer[] = [];
      entry.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      entry.on("end", () => {
        files.push({ relativePath, content: Buffer.concat(chunks) });
      });
    });
    parser.on("end", () => resolve(new Ok(undefined)));
    // The tar library reports a malformed archive through this event.
    parser.on("error", (error) =>
      resolve(
        new Err(
          `Source archive is not a valid tar: ${normalizeError(error).message}`
        )
      )
    );
    Readable.from(archive).pipe(parser);
  });

  if (parsed.isErr()) {
    return parsed;
  }
  if (unsafePath !== null) {
    return new Err(`Unsafe path in source archive: ${unsafePath}`);
  }
  return new Ok(files);
}

/**
 * Load and parse a publication's `source.tar`. `Ok(null)` when the publication predates source
 * archives (no object); `Err` when the object exists but is not a valid archive.
 */
export async function loadFrameSourceArchive(
  auth: Authenticator,
  { frame, publicationId }: { frame: FileResource; publicationId: string }
): Promise<Result<FrameSourceArchiveFile[] | null, string>> {
  const path = getFramePublicationSourceArchivePath({
    workspaceId: auth.getNonNullableWorkspace().sId,
    frameId: frame.sId,
    publicationId,
  });

  let archive: Buffer;
  try {
    // GCS SDK call: a missing object surfaces as a thrown not-found error.
    [archive] = await getPrivateUploadBucket().file(path).download();
  } catch (error) {
    if (isGCSNotFoundError(error)) {
      return new Ok(null);
    }
    throw error;
  }

  return parseFrameSourceArchive(archive);
}

export async function hasFrameSourceArchive(
  auth: Authenticator,
  { frame, publicationId }: { frame: FileResource; publicationId: string }
): Promise<boolean> {
  const [exists] = await getPrivateUploadBucket()
    .file(
      getFramePublicationSourceArchivePath({
        workspaceId: auth.getNonNullableWorkspace().sId,
        frameId: frame.sId,
        publicationId,
      })
    )
    .exists();
  return exists;
}
