import type { CollabAccess } from "@app/lib/api/collab/access";
import type { DocumentOwnership } from "@front-api/collab/lib/ownership";
import type { CollabCtx } from "@front-api/collab/middlewares/ctx";
import type { Hocuspocus } from "@hocuspocus/server";
import { createMiddleware } from "hono/factory";

/** Gives the collab server's routes the instance it holds open documents in, and its ownership of them. */
export function withCollabServer({
  hocuspocus,
  ownership,
}: {
  hocuspocus: Hocuspocus<CollabAccess>;
  ownership: DocumentOwnership;
}) {
  return createMiddleware<CollabCtx>(async (ctx, next) => {
    ctx.set("hocuspocus", hocuspocus);
    ctx.set("ownership", ownership);
    await next();
  });
}
