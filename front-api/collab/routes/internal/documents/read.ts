import { checkCollabReadAccess } from "@app/lib/api/collab/access";
import { Authenticator } from "@app/lib/auth";
import { toSessionName } from "@app/types/collab";
import type { CollabSourceReadResponse } from "@app/types/collab_internal";
import { collabSourceReadRequestSchema } from "@app/types/collab_internal";
import {
  readSessionSource,
  showAgentActivity,
} from "@front-api/collab/lib/session";
import { collabApp } from "@front-api/collab/middlewares/ctx";
import { collabAccessErrorToApiError } from "@front-api/lib/collab_access_errors";
import { apiError } from "@front-api/middlewares/utils";
import { validate } from "@front-api/middlewares/validator";

// Mounted at /internal/documents/read on the collab server.
/**
 * @cc [owner:PopDaph;tdraier,label:security] collab-internal-document-read
 * A read MUST return a document's source only for the file `checkCollabReadAccess` opens for the
 * request's user, workspace and path, so a reader can read it, answering as the collab ticket route
 * does when it refuses. A read of an open document, readable or not, MUST answer 403 when the
 * request has no user.
 */
const app = collabApp();

/** @ignoreswagger */
app.post("/", validate("json", collabSourceReadRequestSchema), async (ctx) => {
  const hocuspocus = ctx.get("hocuspocus");
  const { workspaceId, userId, canonicalPath, agent } = ctx.req.valid("json");
  const documentName = toSessionName(workspaceId, canonicalPath);

  const read = await readSessionSource(hocuspocus, documentName);
  if (read.isOk() && !read.value.open) {
    return ctx.json<CollabSourceReadResponse>(read.value);
  }

  // Open, readable or not: only a user who can open the file learns more of it.
  if (!userId) {
    return apiError(ctx, {
      status_code: 403,
      api_error: {
        type: "workspace_auth_error",
        message:
          "This document is being edited live and can only be read on behalf of a user.",
      },
    });
  }
  const file = await checkCollabReadAccess(
    await Authenticator.fromUserIdAndWorkspaceId(userId, workspaceId),
    canonicalPath
  );
  if (file.isErr()) {
    return apiError(ctx, collabAccessErrorToApiError(file.error));
  }
  if (read.isErr()) {
    // TODO(co-edition): answer a distinct outcome telling the agent a person's edit cannot be
    // saved yet, rather than an error.
    return apiError(
      ctx,
      {
        status_code: 500,
        api_error: {
          type: "internal_server_error",
          message: "The live document could not be read.",
        },
      },
      new Error(read.error)
    );
  }
  // Only once the reader may open the file: its editors then see the agent at work.
  if (agent) {
    showAgentActivity(hocuspocus, documentName, agent, "reading");
  }
  return ctx.json<CollabSourceReadResponse>(read.value);
});

export default app;
