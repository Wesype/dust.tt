import { checkCollabAccess } from "@app/lib/api/collab/access";
import { WRITE_CANONICAL_FILE_CONTENT_MAX_BYTES } from "@app/lib/api/files/file_system_ops";
import { Authenticator } from "@app/lib/auth";
import type { CollabSourceWriteResponse } from "@app/types/collab_internal";
import { collabSourceWriteRequestSchema } from "@app/types/collab_internal";
import { writeSessionSource } from "@front-api/collab/lib/session";
import { collabApp } from "@front-api/collab/middlewares/ctx";
import { collabAccessErrorToApiError } from "@front-api/lib/collab_access_errors";
import { apiError } from "@front-api/middlewares/utils";
import { validate } from "@front-api/middlewares/validator";

// Mounted at /internal/documents/write on the collab server.
/**
 * @cc [owner:PopDaph;tdraier,label:security] collab-internal-document-write
 * A write MUST carry a user and MUST be applied only for the file `checkCollabAccess` opens for
 * them, answering as the collab ticket route does when it refuses. A write whose source is larger
 * than `WRITE_CANONICAL_FILE_CONTENT_MAX_BYTES` MUST be refused before it reaches the session,
 * since no save could write it.
 */
const app = collabApp();

/** @ignoreswagger */
app.post("/", validate("json", collabSourceWriteRequestSchema), async (ctx) => {
  const { workspaceId, userId, canonicalPath, base, source, agent } =
    ctx.req.valid("json");

  const file = await checkCollabAccess(
    await Authenticator.fromUserIdAndWorkspaceId(userId, workspaceId),
    canonicalPath
  );
  if (file.isErr()) {
    return apiError(ctx, collabAccessErrorToApiError(file.error));
  }
  if (
    Buffer.byteLength(source, "utf8") > WRITE_CANONICAL_FILE_CONTENT_MAX_BYTES
  ) {
    return ctx.json<CollabSourceWriteResponse>({
      result: "refused",
      message: "This document would be too large to edit live.",
    });
  }

  const written = await writeSessionSource(ctx.get("hocuspocus"), {
    file: file.value,
    base,
    source,
    agent,
  });
  return ctx.json<CollabSourceWriteResponse>(
    written.isOk()
      ? { result: written.value }
      : { result: "refused", message: written.error }
  );
});

export default app;
