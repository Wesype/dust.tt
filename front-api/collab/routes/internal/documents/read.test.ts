import { ENVELOPE_MAP_NAME } from "@app/lib/api/collab/ydoc";
import { DustFileSystem, DustFileSystemError } from "@app/lib/api/file_system";
import { CollabAgentFactory } from "@app/tests/utils/CollabAgentFactory";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
import {
  COLLAB_SOURCE_READ_PATH,
  COLLAB_SOURCE_WRITE_PATH,
} from "@app/types/collab_internal";
import { Err } from "@app/types/shared/result";
import {
  openNotes,
  post,
  postRaw,
  SECRET,
  useInternalSecret,
} from "@front-api/collab/routes/routes.test_utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("POST /internal/documents/read", () => {
  const read = { workspaceId: "w1", canonicalPath: "user-u1/notes.md" };

  beforeEach(useInternalSecret);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("answers a malformed body with the standard error envelope", async () => {
    const response = await postRaw(
      COLLAB_SOURCE_READ_PATH,
      "{",
      `Bearer ${SECRET}`
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { type: "invalid_request_error" },
    });
  });

  it("reports a document nobody has open as closed", async () => {
    const response = await post(
      COLLAB_SOURCE_READ_PATH,
      read,
      `Bearer ${SECRET}`
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ open: false });
  });

  it("serves an open document's source only to a user who can open it", async () => {
    const { server, request } = await openNotes();
    const { authenticator: outsider } = await createResourceTest({});
    const readAs = (userId?: string) =>
      post(
        COLLAB_SOURCE_READ_PATH,
        { ...request, userId },
        `Bearer ${SECRET}`,
        server
      );

    const allowed = await readAs(request.userId);
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ open: true, source: "# Notes\n" });
    expect((await readAs(undefined)).status).toBe(403);
    expect((await readAs(outsider.getNonNullableUser().sId)).status).toBe(403);
  });

  it("shows an agent reading only once its user may open the document", async () => {
    const { server, hocuspocus, name, request } = await openNotes();
    const { authenticator: outsider } = await createResourceTest({});
    const document = hocuspocus.documents.get(name);
    if (!document) {
      throw new Error("The document is not open.");
    }
    const broadcast = vi.spyOn(document, "broadcastStateless");
    const agent = CollabAgentFactory.build();
    const readAs = (userId: string) =>
      post(
        COLLAB_SOURCE_READ_PATH,
        { ...request, userId, agent },
        `Bearer ${SECRET}`,
        server
      );

    expect((await readAs(outsider.getNonNullableUser().sId)).status).toBe(403);
    expect(broadcast).not.toHaveBeenCalled();

    expect((await readAs(request.userId)).status).toBe(200);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(broadcast.mock.calls[0][0]))).toEqual({
      type: "agent_activity",
      agent,
      activity: "reading",
    });
  });

  it("serves an open document's source to a user who can only read it, never their write", async () => {
    const { server, request } = await openNotes();
    vi.spyOn(DustFileSystem.prototype, "checkWriteAccess").mockReturnValue(
      new Err(new DustFileSystemError("internal", "Read-only mount."))
    );

    const read = await post(
      COLLAB_SOURCE_READ_PATH,
      request,
      `Bearer ${SECRET}`,
      server
    );
    const written = await post(
      COLLAB_SOURCE_WRITE_PATH,
      { ...request, base: "# Notes\n", source: "# Edited\n" },
      `Bearer ${SECRET}`,
      server
    );

    expect(await read.json()).toEqual({ open: true, source: "# Notes\n" });
    expect(written.status).toBe(403);
    expect(await written.json()).toMatchObject({
      error: { type: "file_read_only" },
    });
  });

  it("refuses a read of an open document it cannot read before telling why", async () => {
    const { server, hocuspocus, name, request } = await openNotes();
    hocuspocus.documents.get(name)?.getMap(ENVELOPE_MAP_NAME).clear();
    const readAs = (userId?: string) =>
      post(
        COLLAB_SOURCE_READ_PATH,
        { ...request, userId },
        `Bearer ${SECRET}`,
        server
      );

    expect((await readAs(undefined)).status).toBe(403);
    expect((await readAs(request.userId)).status).toBe(500);
  });
});
