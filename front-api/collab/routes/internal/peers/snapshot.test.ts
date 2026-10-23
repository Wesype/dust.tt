import { BODY_FRAGMENT_NAME } from "@app/types/collab";
import type { PeerSnapshot } from "@front-api/collab/lib/peers";
import { PEER_SNAPSHOT_PATH } from "@front-api/collab/lib/peers";
import { getSession } from "@front-api/collab/lib/session";
import {
  openNotes,
  post,
  SECRET,
  useInternalSecret,
} from "@front-api/collab/routes/routes.test_utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

describe("POST /internal/peers/snapshot", () => {
  beforeEach(useInternalSecret);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("serves a document this server owns, with its epoch and save state", async () => {
    const { server, hocuspocus, name } = await openNotes();

    const response = await post(
      PEER_SNAPSHOT_PATH,
      { documentName: name },
      `Bearer ${SECRET}`,
      server
    );

    expect(response.status).toBe(200);
    const snapshot: PeerSnapshot = await response.json();
    const document = hocuspocus.documents.get(name);
    expect(snapshot).toMatchObject({
      epoch: document && getSession(document)?.epoch,
      failed: false,
      conflictCopy: null,
    });
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Buffer.from(snapshot.update, "base64"));
    const body = copy.getXmlFragment(BODY_FRAGMENT_NAME).toString();
    expect(body).toContain("Notes");
    expect(body).toBe(document?.getXmlFragment(BODY_FRAGMENT_NAME).toString());
  });

  it("answers 421 once this server no longer owns the document", async () => {
    const { server, ownership, name } = await openNotes();
    await ownership.release(name);

    const response = await post(
      PEER_SNAPSHOT_PATH,
      { documentName: name },
      `Bearer ${SECRET}`,
      server
    );

    expect(response.status).toBe(421);
    expect(await response.json()).toMatchObject({
      error: { type: "collab_session_not_owned" },
    });
  });
});
