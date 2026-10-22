import { checkCollabAccess } from "@app/lib/api/collab/access";
import { EDIT_TOO_LARGE_MESSAGE } from "@app/lib/api/documents/agent_edit_source";
import { WRITE_CANONICAL_FILE_CONTENT_MAX_BYTES } from "@app/lib/api/files/file_system_ops";
import { Authenticator } from "@app/lib/auth";
import type { CollabSourceEditResponse } from "@app/types/collab_internal";
import { collabSourceEditRequestSchema } from "@app/types/collab_internal";
import { assertNever } from "@app/types/shared/utils/assert_never";
import { editSessionSource } from "@front-api/collab/lib/session";
import { collabApp } from "@front-api/collab/middlewares/ctx";
import { collabAccessErrorToApiError } from "@front-api/lib/collab_access_errors";
import { apiError } from "@front-api/middlewares/utils";
import { validate } from "@front-api/middlewares/validator";

// Mounted at /internal/documents/edit on the collab server.
/**
 * @cc [owner:PopDaph;tdraier,label:security] collab-internal-document-edit
 * An edit MUST be checked as a write is (`collab-internal-document-write`), its replacement text in
 * place of the source, answering `edit_refused` with `too_large` as the session does for an edited
 * source over that size (`collab-session-source-edit`). An edit the session cannot apply because
 * it cannot read its own document MUST answer 500, so the caller reports a failure of the server
 * rather than a refusal of the edit.
 */
const app = collabApp();

/** @ignoreswagger */
app.post("/", validate("json", collabSourceEditRequestSchema), async (ctx) => {
  const { workspaceId, userId, canonicalPath, edit, agent } =
    ctx.req.valid("json");

  const file = await checkCollabAccess(
    await Authenticator.fromUserIdAndWorkspaceId(userId, workspaceId),
    canonicalPath
  );
  if (file.isErr()) {
    return apiError(ctx, collabAccessErrorToApiError(file.error));
  }
  if (
    Buffer.byteLength(edit.newString, "utf8") >
    WRITE_CANONICAL_FILE_CONTENT_MAX_BYTES
  ) {
    return ctx.json<CollabSourceEditResponse>({
      result: "edit_refused",
      code: "too_large",
      message: EDIT_TOO_LARGE_MESSAGE,
    });
  }

  const edited = await editSessionSource(ctx.get("hocuspocus"), {
    file: file.value,
    edit,
    agent,
  });
  if (edited.isOk()) {
    return ctx.json<CollabSourceEditResponse>(edited.value);
  }
  switch (edited.error.kind) {
    case "refused":
      return ctx.json<CollabSourceEditResponse>({
        result: "refused",
        message: edited.error.message,
      });
    case "unavailable":
      return apiError(
        ctx,
        {
          status_code: 500,
          api_error: {
            type: "internal_server_error",
            message: "The live document could not be read.",
          },
        },
        new Error(edited.error.message)
      );
    default:
      return assertNever(edited.error.kind);
  }
});

export default app;
