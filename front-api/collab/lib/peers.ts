// What collab servers ask each other, over their internal routes, and how a document's owner
// answers: a replica loads its owner's copy and its save state, and tells it who edited.
import type {
  CollabAccess,
  CollabAccessError,
} from "@app/lib/api/collab/access";
import { READ_ONLY, recheckCollabAccess } from "@app/lib/api/collab/access";
import { Authenticator } from "@app/lib/auth";
import type { SaveState } from "@app/types/collab";
import { parseSessionName, saveStateSchema } from "@app/types/collab";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";
import { ACCESS_RECHECK_INTERVAL_MS } from "@front-api/collab/lib/connection_access";
import type { DocumentOwnership } from "@front-api/collab/lib/ownership";
import type { CollabSession } from "@front-api/collab/lib/session";
import { getLoadedSession, toSaveState } from "@front-api/collab/lib/session";
import type { Document, Hocuspocus } from "@hocuspocus/server";
import * as Y from "yjs";
import { z } from "zod";

export const PEER_SNAPSHOT_PATH = "/peers/snapshot";
export const PEER_WRITER_PATH = "/peers/writer";
export const PEER_SAVE_STATE_PATH = "/peers/save_state";

export const peerDocumentRequestSchema = z.object({
  documentName: z.string().min(1),
});

export const peerSnapshotSchema = saveStateSchema.extend({
  epoch: z.string().min(1),
  update: z.string(),
});

export type PeerSnapshot = z.infer<typeof peerSnapshotSchema>;

export const peerWriterRequestSchema = z.object({
  documentName: z.string().min(1),
  userId: z.string().min(1),
});

// 421, not 404: a server running code without these routes answers 404 too.
export const NOT_OWNED_ERROR = {
  status_code: 421 as const,
  api_error: {
    type: "collab_session_not_owned" as const,
    message: "This collab server does not own the document.",
  },
};

/**
 * A replica's user, re-checked as their connection is (`recheckCollabAccess`): it already opened
 * the file on the replica, and the owner holds that file loaded.
 */
export async function peerAccess(
  documentName: string,
  userId: string
): Promise<Result<CollabAccess, CollabAccessError>> {
  const parsed = parseSessionName(documentName);
  if (!parsed) {
    return new Err({
      code: "invalid_path",
      message: "The document name names no file.",
    });
  }
  return recheckCollabAccess(
    await Authenticator.fromUserIdAndWorkspaceId(userId, parsed.workspaceId),
    parsed.canonicalPath
  );
}

/** The document and its session while this server holds it loaded as its owner and owns it. */
export async function getOwnedSession(
  hocuspocus: Hocuspocus<CollabAccess>,
  ownership: DocumentOwnership,
  documentName: string
): Promise<{ document: Document; session: CollabSession } | null> {
  const open = await getLoadedSession(hocuspocus, documentName);
  if (!open || !ownership.owns(documentName)) {
    return null;
  }
  return open;
}

/** The owner's copy of a document, for a replica to load; null unless this server owns it. */
export async function getPeerSnapshot(
  hocuspocus: Hocuspocus<CollabAccess>,
  ownership: DocumentOwnership,
  documentName: string
): Promise<PeerSnapshot | null> {
  const open = await getOwnedSession(hocuspocus, ownership, documentName);
  if (!open) {
    return null;
  }
  return {
    epoch: open.session.epoch,
    update: Buffer.from(Y.encodeStateAsUpdate(open.document)).toString(
      "base64"
    ),
    ...toSaveState(open.session),
  };
}

/** The owner's save state of a document, for a replica's connection; null unless it owns it. */
export async function getPeerSaveState(
  hocuspocus: Hocuspocus<CollabAccess>,
  ownership: DocumentOwnership,
  documentName: string
): Promise<SaveState | null> {
  const open = await getOwnedSession(hocuspocus, ownership, documentName);
  return open ? toSaveState(open.session) : null;
}

export type PeerWriterRefusal =
  | { kind: "not_owned" }
  | { kind: "access_refused"; error: CollabAccessError };

/**
 * A replica's connection changed the document: its edits reach the owner through the relay, and
 * the owner saves them through that connection's user, whose access, granted or refused, is
 * checked again once it is `ACCESS_RECHECK_INTERVAL_MS` old.
 */
export async function recordPeerWriter(
  hocuspocus: Hocuspocus<CollabAccess>,
  ownership: DocumentOwnership,
  { documentName, userId }: { documentName: string; userId: string }
): Promise<Result<void, PeerWriterRefusal>> {
  const open = await getOwnedSession(hocuspocus, ownership, documentName);
  if (!open) {
    return new Err({ kind: "not_owned" });
  }
  const { document, session } = open;
  const writerBefore = session.lastChangedBy;
  let known = session.peerAccesses.get(userId);
  if (!known || Date.now() - known.checkedAtMs >= ACCESS_RECHECK_INTERVAL_MS) {
    known = {
      access: await peerAccess(documentName, userId),
      checkedAtMs: Date.now(),
    };
    session.peerAccesses.set(userId, known);
  }
  // Lost or unloaded while the user's access was checked: the server owning it now saves it.
  if (document.isDestroyed || !ownership.owns(documentName)) {
    return new Err({ kind: "not_owned" });
  }
  if (known.access.isErr()) {
    return new Err({ kind: "access_refused", error: known.access.error });
  }
  const writer = known.access.value;
  // As the writer, they would fail every save until someone who can write edits again.
  if (!writer.canWrite) {
    return new Err({ kind: "access_refused", error: READ_ONLY });
  }
  // Changed here while the user was checked: that newer writer's save holds the replica's edits.
  if (session.lastChangedBy !== writerBefore) {
    return new Ok(undefined);
  }
  session.lastChangedBy = writer;
  session.loadedEditsNeedWriter = false;
  // Not awaited: Hocuspocus debounces the store and catches its failures, which `onStoreDocument`
  // logs.
  void hocuspocus.storeDocumentHooks(document, {
    clientsCount: document.getConnectionsCount(),
    document,
    documentName,
    instance: hocuspocus,
    lastContext: writer,
    lastTransactionOrigin: undefined,
  });
  return new Ok(undefined);
}
