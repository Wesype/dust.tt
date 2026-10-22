import { WRITE_CANONICAL_FILE_CONTENT_MAX_BYTES } from "@app/lib/api/files/file_system_ops";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
import {
  COLLAB_SOURCE_READ_PATH,
  COLLAB_SOURCE_WRITE_PATH,
} from "@app/types/collab_internal";
import {
  openNotes,
  post,
  SECRET,
  useInternalSecret,
} from "@front-api/collab/routes/routes.test_utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("POST /internal/documents/write", () => {
  beforeEach(useInternalSecret);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses a write for a user the live session would refuse", async () => {
    const { authenticator, workspace } = await createResourceTest({});
    const user = authenticator.getNonNullableUser();

    // `co_edition` is off for the workspace.
    const response = await post(
      COLLAB_SOURCE_WRITE_PATH,
      {
        workspaceId: workspace.sId,
        userId: user.sId,
        canonicalPath: `user-${user.sId}/notes.md`,
        base: "",
        source: "# Notes\n",
      },
      `Bearer ${SECRET}`
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { type: "feature_not_enabled" },
    });
  });

  it("answers a refused access with the error type naming why", async () => {
    const { hocuspocus, request } = await openNotes();

    const response = await post(
      COLLAB_SOURCE_WRITE_PATH,
      {
        ...request,
        canonicalPath: `${request.canonicalPath}/`,
        base: "",
        source: "# Notes\n",
      },
      `Bearer ${SECRET}`,
      hocuspocus
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { type: "invalid_request_error" },
    });
  });

  it("refuses a source too large for a save to write", async () => {
    const { hocuspocus, request } = await openNotes();

    const response = await post(
      COLLAB_SOURCE_WRITE_PATH,
      {
        ...request,
        base: "# Notes\n",
        source: "a".repeat(WRITE_CANONICAL_FILE_CONTENT_MAX_BYTES + 1),
      },
      `Bearer ${SECRET}`,
      hocuspocus
    );

    expect(await response.json()).toMatchObject({ result: "refused" });
    const after = await post(
      COLLAB_SOURCE_READ_PATH,
      request,
      `Bearer ${SECRET}`,
      hocuspocus
    );
    expect(await after.json()).toEqual({ open: true, source: "# Notes\n" });
  });
});
