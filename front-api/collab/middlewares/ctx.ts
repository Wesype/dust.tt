import type { CollabAccess } from "@app/lib/api/collab/access";
import { createHono } from "@front-api/lib/hono";
import type { Hocuspocus } from "@hocuspocus/server";

// The collab server's routes. `withHocuspocus` sets the instance the server holds documents in.
export type CollabCtx = {
  Variables: {
    hocuspocus: Hocuspocus<CollabAccess>;
  };
};

export const collabApp = () => createHono<CollabCtx>();
