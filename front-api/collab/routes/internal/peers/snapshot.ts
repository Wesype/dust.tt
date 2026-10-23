import type { PeerSnapshot } from "@front-api/collab/lib/peers";
import {
  getPeerSnapshot,
  NOT_OWNED_ERROR,
  peerDocumentRequestSchema,
} from "@front-api/collab/lib/peers";
import { collabApp } from "@front-api/collab/middlewares/ctx";
import { apiError } from "@front-api/middlewares/utils";
import { validate } from "@front-api/middlewares/validator";

// Mounted at /internal/peers/snapshot on the collab server.
/**
 * @cc [owner:tdraier,label:security;concurrency] collab-internal-peer-snapshot
 * A replica MUST load only from a server that owns the document, holds it loaded as its owner and
 * still counts it as owned (`getPeerSnapshot`): any other server, one whose renewal reported it
 * lost included, MUST answer 421.
 */
const app = collabApp();

/** @ignoreswagger */
app.post("/", validate("json", peerDocumentRequestSchema), async (ctx) => {
  const { documentName } = ctx.req.valid("json");
  const snapshot = await getPeerSnapshot(
    ctx.get("hocuspocus"),
    ctx.get("ownership"),
    documentName
  );
  if (!snapshot) {
    return apiError(ctx, NOT_OWNED_ERROR);
  }
  return ctx.json<PeerSnapshot>(snapshot);
});

export default app;
