import type { SaveState } from "@app/types/collab";
import {
  getPeerSaveState,
  NOT_OWNED_ERROR,
  peerDocumentRequestSchema,
} from "@front-api/collab/lib/peers";
import { collabApp } from "@front-api/collab/middlewares/ctx";
import { apiError } from "@front-api/middlewares/utils";
import { validate } from "@front-api/middlewares/validator";

// Mounted at /internal/peers/save_state on the collab server.
/**
 * @cc [owner:tdraier,label:security;concurrency] collab-internal-peer-save-state
 * A replica MUST learn the document's save state only from a server that owns the document, holds
 * it loaded as its owner and still counts it as owned (`getPeerSaveState`): any other server MUST
 * answer 421.
 */
const app = collabApp();

/** @ignoreswagger */
app.post("/", validate("json", peerDocumentRequestSchema), async (ctx) => {
  const { documentName } = ctx.req.valid("json");
  const state = await getPeerSaveState(
    ctx.get("hocuspocus"),
    ctx.get("ownership"),
    documentName
  );
  if (!state) {
    return apiError(ctx, NOT_OWNED_ERROR);
  }
  return ctx.json<SaveState>(state);
});

export default app;
