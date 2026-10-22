import type { CollabAccess } from "@app/lib/api/collab/access";
import type { CollabCtx } from "@front-api/collab/middlewares/ctx";
import type { Hocuspocus } from "@hocuspocus/server";
import { createMiddleware } from "hono/factory";

/** Gives the collab server's routes the instance it holds open documents in. */
export function withHocuspocus(hocuspocus: Hocuspocus<CollabAccess>) {
  return createMiddleware<CollabCtx>(async (ctx, next) => {
    ctx.set("hocuspocus", hocuspocus);
    await next();
  });
}
