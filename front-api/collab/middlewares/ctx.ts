import type { CollabAccess } from "@app/lib/api/collab/access";
import type { DocumentOwnership } from "@front-api/collab/lib/ownership";
import { createHono } from "@front-api/lib/hono";
import type { Hocuspocus } from "@hocuspocus/server";

// The collab server's routes. `withCollabServer` sets the instance the server holds documents in,
// and its ownership of them.
export type CollabCtx = {
  Variables: {
    hocuspocus: Hocuspocus<CollabAccess>;
    ownership: DocumentOwnership;
  };
};

export const collabApp = () => createHono<CollabCtx>();
