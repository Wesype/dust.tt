import { PEER_SAVE_STATE_PATH } from "@front-api/collab/lib/peers";
import { getSession } from "@front-api/collab/lib/session";
import {
  openNotes,
  post,
  SECRET,
  useInternalSecret,
} from "@front-api/collab/routes/routes.test_utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("POST /internal/peers/save_state", () => {
  beforeEach(useInternalSecret);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("serves the save state of a document this server owns", async () => {
    const { server, hocuspocus, name } = await openNotes();
    const document = hocuspocus.documents.get(name);
    const session = document && getSession(document);
    if (!session) {
      throw new Error("The document did not load.");
    }
    session.saveFailed = true;
    session.conflictCopy = "notes (copy).md";

    const response = await post(
      PEER_SAVE_STATE_PATH,
      { documentName: name },
      `Bearer ${SECRET}`,
      server
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      failed: true,
      conflictCopy: "notes (copy).md",
    });
  });

  it("answers 421 once this server no longer owns the document", async () => {
    const { server, ownership, name } = await openNotes();
    await ownership.release(name);

    const response = await post(
      PEER_SAVE_STATE_PATH,
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
