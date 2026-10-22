import { checkCollabReadAccess } from "@app/lib/api/collab/access";
import { Authenticator } from "@app/lib/auth";
import { toSessionName } from "@app/types/collab";
import { collabAgentActivityRequestSchema } from "@app/types/collab_internal";
import { showAgentActivity } from "@front-api/collab/lib/session";
import { collabApp } from "@front-api/collab/middlewares/ctx";
import { collabAccessErrorToApiError } from "@front-api/lib/collab_access_errors";
import { apiError } from "@front-api/middlewares/utils";
import { validate } from "@front-api/middlewares/validator";

// Mounted at /internal/documents/agent_activity on the collab server.
/**
 * @cc [owner:PopDaph;tdraier,label:security] collab-internal-document-agent-activity
 * An agent's activity MUST be shown only once `checkCollabReadAccess` opens the file for the
 * request's user, workspace and path, answering as the collab ticket route does otherwise.
 */
const app = collabApp();

/** @ignoreswagger */
app.post(
  "/",
  validate("json", collabAgentActivityRequestSchema),
  async (ctx) => {
    const hocuspocus = ctx.get("hocuspocus");
    const { workspaceId, userId, canonicalPath, agent, activity } =
      ctx.req.valid("json");
    const documentName = toSessionName(workspaceId, canonicalPath);
    if (!hocuspocus.documents.has(documentName)) {
      return ctx.json({});
    }

    const file = await checkCollabReadAccess(
      await Authenticator.fromUserIdAndWorkspaceId(userId, workspaceId),
      canonicalPath
    );
    if (file.isErr()) {
      return apiError(ctx, collabAccessErrorToApiError(file.error));
    }
    showAgentActivity(hocuspocus, documentName, agent, activity);
    return ctx.json({});
  }
);

export default app;
