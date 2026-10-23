// The live session server: one Hocuspocus instance holding open documents in memory, next to a
// Hono app for plain HTTP. Design: x/daph/co-edition/LIVE_SESSION.md.
import "@front-api/lib/startup-log";

import config from "@app/lib/api/config";
import logger from "@app/logger/logger";
import { parseSessionName } from "@app/types/collab";
import { normalizeError } from "@app/types/shared/utils/error_utils";
import { setupGlobalErrorHandler } from "@app/types/shared/utils/global_error_handler";
import type { WebSocketLike } from "@hocuspocus/server";
import { serve } from "@hono/node-server";
import type { Peer } from "crossws";
import crossws from "crossws/adapters/node";

import { createHono } from "@front-api/lib/hono";
import { unhandledErrorHandler } from "@front-api/middlewares/utils";
import { healthzApp } from "@front-api/routes/healthz";
import {
  ACCESS_RECHECK_INTERVAL_MS,
  recheckAllConnections,
} from "./lib/connection_access";
import { saveAllSessions, createCollabHocuspocus } from "./lib/hocuspocus";
import {
  createDocumentOwnership,
  OWNER_RENEW_INTERVAL_MS,
} from "./lib/ownership";
import { createCollabRelay } from "./lib/relay";
import { createCollabRoutes } from "./routes";

/**
 * @cc [owner:PopDaph;tdraier,label:product;concurrency] collab-server-internal-secret
 * The server MUST refuse to start without `COLLAB_INTERNAL_SECRET`: front reports every document
 * closed when it has no collab server configured, so a server front cannot ask MUST hold no
 * session.
 */
function assertInternalSecret() {
  if (!config.getCollabServerInternalSecret()) {
    throw new Error("The collab server needs COLLAB_INTERNAL_SECRET.");
  }
}

assertInternalSecret();
setupGlobalErrorHandler(logger);

const port = config.getCollabServerPort();
const hostname = config.getCollabServerHostname();

/**
 * @cc [owner:tdraier,label:concurrency;error-handling] collab-server-ownership
 * The server MUST refuse to start without `COLLAB_PEER_URL`, the address its documents' ownership
 * records give the other servers. It MUST renew the documents it owns every
 * `OWNER_RENEW_INTERVAL_MS`, unless the previous renewal is still running, including while it
 * stops, until `saveAllSessions` resolved, then release them, so another server can take them at
 * once. A renewal that throws MUST be logged and caught, an exception to
 * `no-catching-own-errors`: it runs from a timer, with no caller to handle it, and MUST NOT keep
 * the next renewals from running.
 */
const ownership = createDocumentOwnership();
const hocuspocus = createCollabHocuspocus({
  ownership,
  relay: createCollabRelay({
    redisUri: config.getRedisCollabUri(),
    serverId: ownership.self.serverId,
  }),
});

const app = createHono();
app.route("/api/healthz", healthzApp);
app.route("/", createCollabRoutes(hocuspocus, { ownership }));
app.onError(unhandledErrorHandler);

// crossws types the upgraded socket as a partial WebSocket; on Node it is a full `ws` socket.
function isWebSocketLike(socket: unknown): socket is WebSocketLike {
  return (
    typeof socket === "object" &&
    socket !== null &&
    "send" in socket &&
    typeof socket.send === "function" &&
    "close" in socket &&
    typeof socket.close === "function" &&
    "readyState" in socket &&
    typeof socket.readyState === "number"
  );
}

// crossws turns HTTP upgrades into WebSockets and hands them to Hocuspocus, as Hocuspocus's own
// server does, so Hono and Hocuspocus share one HTTP server and one port.
type ClientConnection = ReturnType<typeof hocuspocus.handleConnection>;
const connections = new WeakMap<Peer, ClientConnection>();

const ws = crossws({
  hooks: {
    open(peer) {
      const socket = peer.websocket;
      if (!isWebSocketLike(socket)) {
        logger.error(
          { peerId: peer.id },
          "Collab peer has no usable WebSocket"
        );
        peer.close(1011, "Unsupported connection");
        return;
      }
      connections.set(peer, hocuspocus.handleConnection(socket, peer.request));
    },
    message(peer, message) {
      connections.get(peer)?.handleMessage(message.uint8Array());
    },
    close(peer, event) {
      // 1005: the peer closed without a status code.
      connections.get(peer)?.handleClose({
        code: event.code ?? 1005,
        reason: event.reason ?? "",
      });
      connections.delete(peer);
    },
    error(peer, error) {
      logger.error({ err: error, peerId: peer.id }, "Collab WebSocket error");
    },
  },
});

const server = serve({ fetch: app.fetch, port, hostname }, () => {
  logger.info({ port, hostname }, "Collab server listening");
});
// The ingress and dust-hive's proxy send `/api/collab` here; upgrades on any path are accepted.
// `/internal` is only reached from inside the cluster.
server.on("upgrade", (request, socket, head) => {
  ws.handleUpgrade(request, socket, head);
});
server.on("error", (err) => {
  logger.error({ err }, "Collab server error");
  process.exit(1);
});

// Access is checked again on open connections, so a user who loses it does not keep editing until
// a reconnect. A sweep still running skips the next one.
let rechecking = false;
const recheckTimer = setInterval(() => {
  if (rechecking) {
    // Repeated, this means a sweep is stuck and revoked users stay connected.
    logger.warn("Collab access re-check still running, skipping this one");
    return;
  }
  rechecking = true;
  void recheckAllConnections(hocuspocus).finally(() => {
    rechecking = false;
  });
}, ACCESS_RECHECK_INTERVAL_MS);

let renewing = false;
async function renewOwnerships() {
  if (renewing) {
    logger.warn("Collab ownership renewal still running, skipping this one");
    return;
  }
  renewing = true;
  try {
    const { lost, error } = await ownership.renew();
    if (error) {
      logger.error({ err: error }, "Collab ownership renewal failed");
    }
    // TODO(co-edition): stop saving a document another server owns now.
    for (const documentName of lost) {
      logger.warn(
        {
          documentName,
          workspaceId: parseSessionName(documentName)?.workspaceId,
        },
        "Collab document ownership lost"
      );
    }
  } catch (err) {
    logger.error(
      { err: normalizeError(err) },
      "Collab ownership renewal threw"
    );
  } finally {
    renewing = false;
  }
}
const renewTimer = setInterval(
  () => void renewOwnerships(),
  OWNER_RENEW_INTERVAL_MS
);

// Save every document before exiting: edits waiting for a debounced store reach the file.
async function shutdown(signal: NodeJS.Signals) {
  logger.info(
    { signal, documents: hocuspocus.getDocumentsCount() },
    "Collab server shutting down"
  );
  clearInterval(recheckTimer);
  server.close();
  // Terminated, not closed: no edit still on the wire may arrive during the saves.
  ws.closeAll(undefined, undefined, true);
  await saveAllSessions(hocuspocus);
  // Renewed until here: a lease running out during the saves would let another server take over.
  clearInterval(renewTimer);
  const released = await ownership.releaseAll();
  if (released.isErr()) {
    logger.warn(
      { err: released.error },
      "Collab document ownerships not released before stopping"
    );
  }
  logger.info("Collab server stopped");
  process.exit(0);
}

// A second signal joins the shutdown instead of ending the process.
let stopping: Promise<void> | undefined;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    stopping ??= shutdown(signal);
  });
}
