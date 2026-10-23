import { assertNever } from "@app/types/shared/utils/assert_never";
import {
  NOT_OWNED_ERROR,
  peerWriterRequestSchema,
  recordPeerWriter,
} from "@front-api/collab/lib/peers";
import { collabApp } from "@front-api/collab/middlewares/ctx";
import { collabAccessErrorToApiError } from "@front-api/lib/collab_access_errors";
import { apiError } from "@front-api/middlewares/utils";
import { validate } from "@front-api/middlewares/validator";

// Mounted at /internal/peers/writer on the collab server.
/**
 * @cc [owner:tdraier,label:security;concurrency] collab-internal-peer-writer
 * The writer a replica reports MUST become the document's writer, saving it, only on a server that
 * owns the document and still owns it once the user is checked (`recordPeerWriter`), and only when
 * `recheckCollabAccess` let them keep the file with write access at most
 * `ACCESS_RECHECK_INTERVAL_MS` before the replica reported them (`peerAccess`), without reading it
 * from storage; the document is then saved through them as through a connection, on its debounced
 * store and the retries that follow, without checking them again. A writer who
 * changed the document on this server while the user was checked MUST stay its writer. Any other
 * server MUST answer 421 as `collab_session_not_owned`. A refused user MUST be answered as the
 * collab ticket route refuses them (`collabAccessErrorToApiError`), and one without write access as
 * `read_only`, the refusal kept as long as an access, so a replica retrying never checks them again
 * sooner.
 */
const app = collabApp();

/** @ignoreswagger */
app.post("/", validate("json", peerWriterRequestSchema), async (ctx) => {
  const { documentName, userId } = ctx.req.valid("json");
  const recorded = await recordPeerWriter(
    ctx.get("hocuspocus"),
    ctx.get("ownership"),
    { documentName, userId }
  );
  if (recorded.isErr()) {
    switch (recorded.error.kind) {
      case "not_owned":
        return apiError(ctx, NOT_OWNED_ERROR);
      case "access_refused":
        return apiError(ctx, collabAccessErrorToApiError(recorded.error.error));
      default:
        return assertNever(recorded.error);
    }
  }
  return ctx.json({});
});

export default app;
