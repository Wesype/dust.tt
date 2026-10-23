import { ENVELOPE_MAP_NAME } from "@app/lib/api/collab/ydoc";
import { DustFileSystem, DustFileSystemError } from "@app/lib/api/file_system";
import {
  COLLAB_SOURCE_EDIT_PATH,
  COLLAB_SOURCE_READ_PATH,
} from "@app/types/collab_internal";
import { Err } from "@app/types/shared/result";
import {
  openNotes,
  post,
  SECRET,
  useInternalSecret,
} from "@front-api/collab/routes/routes.test_utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const EDIT = {
  oldString: "Notes",
  newString: "Edited",
  expectedReplacements: 1,
};

describe("POST /internal/documents/edit", () => {
  beforeEach(useInternalSecret);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("applies an edit to the open document's current source", async () => {
    const { server, request } = await openNotes();

    const response = await post(
      COLLAB_SOURCE_EDIT_PATH,
      { ...request, edit: EDIT },
      `Bearer ${SECRET}`,
      server
    );

    expect(await response.json()).toEqual({
      result: "written",
      replacements: 1,
    });
    const after = await post(
      COLLAB_SOURCE_READ_PATH,
      request,
      `Bearer ${SECRET}`,
      server
    );
    expect(await after.json()).toEqual({ open: true, source: "# Edited\n" });
  });

  it("refuses an edit for a user who can only read the document, changing nothing", async () => {
    const { server, request } = await openNotes();
    vi.spyOn(DustFileSystem.prototype, "checkWriteAccess").mockReturnValue(
      new Err(new DustFileSystemError("internal", "Read-only mount."))
    );

    const response = await post(
      COLLAB_SOURCE_EDIT_PATH,
      { ...request, edit: EDIT },
      `Bearer ${SECRET}`,
      server
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { type: "file_read_only" },
    });
    const after = await post(
      COLLAB_SOURCE_READ_PATH,
      request,
      `Bearer ${SECRET}`,
      server
    );
    expect(await after.json()).toEqual({ open: true, source: "# Notes\n" });
  });

  it("answers 500 to an edit when the session cannot read its own document", async () => {
    const { server, hocuspocus, name, request } = await openNotes();
    hocuspocus.documents.get(name)?.getMap(ENVELOPE_MAP_NAME).clear();

    const response = await post(
      COLLAB_SOURCE_EDIT_PATH,
      { ...request, edit: EDIT },
      `Bearer ${SECRET}`,
      server
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: { type: "internal_server_error" },
    });
  });
});
