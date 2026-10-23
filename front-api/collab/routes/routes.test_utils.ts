import { checkCollabAccess } from "@app/lib/api/collab/access";
import config from "@app/lib/api/config";
import { writeConversationFile } from "@app/tests/utils/conversation_files";
import { FeatureFlagFactory } from "@app/tests/utils/FeatureFlagFactory";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
import { toSessionName } from "@app/types/collab";
import { COLLAB_INTERNAL_ROUTES_PREFIX } from "@app/types/collab_internal";
import { createCollabHocuspocus } from "@front-api/collab/lib/hocuspocus";
import type { DocumentOwnership } from "@front-api/collab/lib/ownership";
import { createDocumentOwnership } from "@front-api/collab/lib/ownership";
import { createCollabRoutes } from "@front-api/collab/routes";
import { createHono } from "@front-api/lib/hono";
import { unhandledErrorHandler } from "@front-api/middlewares/utils";
import { vi } from "vitest";

export const SECRET = "collab-internal-secret";

export function useInternalSecret() {
  vi.spyOn(config, "getCollabServerInternalSecret").mockReturnValue(SECRET);
}

/** A Hocuspocus instance with the ownership its documents are claimed in, as the server has. */
export interface TestCollabServer {
  hocuspocus: ReturnType<typeof createCollabHocuspocus>;
  ownership: DocumentOwnership;
}

export function createTestCollabServer(): TestCollabServer {
  const ownership = createDocumentOwnership();
  return { hocuspocus: createCollabHocuspocus({ ownership }), ownership };
}

export function postRaw(
  path: string,
  body: string,
  authorization?: string,
  { hocuspocus, ownership }: TestCollabServer = createTestCollabServer()
) {
  // Mounted as the collab server mounts it.
  const app = createHono()
    .route("/", createCollabRoutes(hocuspocus, { ownership }))
    .onError(unhandledErrorHandler);
  return app.request(`${COLLAB_INTERNAL_ROUTES_PREFIX}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authorization && { Authorization: authorization }),
    },
    body,
  });
}

export function post(
  path: string,
  body: unknown,
  authorization?: string,
  server?: TestCollabServer
) {
  return postRaw(path, JSON.stringify(body), authorization, server);
}

/** A user who can open `notes.md` live, and that file's document opened in a session. */
export async function openNotes() {
  const { authenticator: auth, workspace } = await createResourceTest({});
  await FeatureFlagFactory.basic(auth, "co_edition");
  const canonicalPath = await writeConversationFile(
    auth,
    "notes.md",
    "# Notes\n"
  );
  const file = await checkCollabAccess(auth, canonicalPath);
  if (file.isErr()) {
    throw new Error(file.error.message);
  }
  const server = createTestCollabServer();
  const { hocuspocus, ownership } = server;
  const name = toSessionName(workspace.sId, canonicalPath);
  await hocuspocus.openDirectConnection(name, file.value);
  return {
    server,
    hocuspocus,
    ownership,
    name,
    request: {
      workspaceId: workspace.sId,
      userId: auth.getNonNullableUser().sId,
      canonicalPath,
    },
  };
}
