import type { CollabAccess } from "@app/lib/api/collab/access";
import { COLLAB_INTERNAL_ROUTES_PREFIX } from "@app/types/collab_internal";
import type { DocumentOwnership } from "@front-api/collab/lib/ownership";
import { collabApp } from "@front-api/collab/middlewares/ctx";
import { withCollabServer } from "@front-api/collab/middlewares/with_collab_server";
import type { Hocuspocus } from "@hocuspocus/server";

import internal from "./internal";

/**
 * The collab server's route tree, as `app.ts` is front-api's. It takes the server's Hocuspocus
 * instance so the tree cannot be mounted without it.
 */
export function createCollabRoutes(
  hocuspocus: Hocuspocus<CollabAccess>,
  { ownership }: { ownership: DocumentOwnership }
) {
  const app = collabApp();

  app.use("*", withCollabServer({ hocuspocus, ownership }));
  app.route(COLLAB_INTERNAL_ROUTES_PREFIX, internal);

  return app;
}
