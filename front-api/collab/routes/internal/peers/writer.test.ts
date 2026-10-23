import type { CollabAccess } from "@app/lib/api/collab/access";
import { recheckCollabAccess } from "@app/lib/api/collab/access";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
import { Ok } from "@app/types/shared/result";
import { ACCESS_RECHECK_INTERVAL_MS } from "@front-api/collab/lib/connection_access";
import { PEER_WRITER_PATH } from "@front-api/collab/lib/peers";
import { getSession } from "@front-api/collab/lib/session";
import {
  openNotes,
  post,
  SECRET,
  useInternalSecret,
} from "@front-api/collab/routes/routes.test_utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@app/lib/api/collab/access", async (importActual) => {
  const actual =
    await importActual<typeof import("@app/lib/api/collab/access")>();
  return {
    ...actual,
    recheckCollabAccess: vi.fn(actual.recheckCollabAccess),
  };
});

describe("POST /internal/peers/writer", () => {
  beforeEach(useInternalSecret);

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.mocked(recheckCollabAccess).mockClear();
  });

  async function openAndChange() {
    const opened = await openNotes();
    const { server, name, request } = opened;
    const change = (userId = request.userId) =>
      post(
        PEER_WRITER_PATH,
        { documentName: name, userId },
        `Bearer ${SECRET}`,
        server
      );
    return { ...opened, change };
  }

  it("makes the replica's user the writer of a document this server owns", async () => {
    const { hocuspocus, name, request, change } = await openAndChange();

    const response = await change();

    expect(response.status).toBe(200);
    const document = hocuspocus.documents.get(name);
    const writer = document && getSession(document)?.lastChangedBy;
    expect(writer?.auth.getNonNullableUser().sId).toBe(request.userId);
  });

  it("answers 421 once this server no longer owns the document", async () => {
    const { ownership, name, change } = await openAndChange();
    await ownership.release(name);

    const response = await change();

    expect(response.status).toBe(421);
    expect(await response.json()).toMatchObject({
      error: { type: "collab_session_not_owned" },
    });
  });

  it("answers 421 when this server loses the document while checking the user", async () => {
    const { hocuspocus, ownership, name, change } = await openAndChange();
    const actual = await vi.importActual<
      typeof import("@app/lib/api/collab/access")
    >("@app/lib/api/collab/access");
    vi.mocked(recheckCollabAccess).mockImplementationOnce(async (...args) => {
      await ownership.release(name);
      return actual.recheckCollabAccess(...args);
    });

    const response = await change();

    expect(response.status).toBe(421);
    expect(await response.json()).toMatchObject({
      error: { type: "collab_session_not_owned" },
    });
    const document = hocuspocus.documents.get(name);
    expect(document && getSession(document)?.lastChangedBy).toBeUndefined();
  });

  it("refuses a user who can no longer write, keeping the document's writer", async () => {
    const { hocuspocus, name, change } = await openAndChange();
    const actual = await vi.importActual<
      typeof import("@app/lib/api/collab/access")
    >("@app/lib/api/collab/access");
    vi.mocked(recheckCollabAccess).mockImplementationOnce(async (...args) => {
      const access = await actual.recheckCollabAccess(...args);
      return access.isOk()
        ? new Ok({ ...access.value, canWrite: false })
        : access;
    });

    const response = await change();

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { type: "file_read_only" },
    });
    const document = hocuspocus.documents.get(name);
    expect(document && getSession(document)?.lastChangedBy).toBeUndefined();
  });

  it("keeps a writer who changed the document here while the user was checked", async () => {
    const { hocuspocus, name, change } = await openAndChange();
    const document = hocuspocus.documents.get(name);
    const session = document && getSession(document);
    if (!session) {
      throw new Error("The document did not load.");
    }
    const actual = await vi.importActual<
      typeof import("@app/lib/api/collab/access")
    >("@app/lib/api/collab/access");
    let localWriter: CollabAccess | undefined;
    vi.mocked(recheckCollabAccess).mockImplementationOnce(async (...args) => {
      const access = await actual.recheckCollabAccess(...args);
      if (access.isOk()) {
        localWriter = { ...access.value };
        session.lastChangedBy = localWriter;
      }
      return access;
    });

    const response = await change();

    expect(response.status).toBe(200);
    expect(localWriter).toBeDefined();
    expect(session.lastChangedBy).toBe(localWriter);
  });

  it("refuses a user who cannot open the file as the ticket route does", async () => {
    const { change } = await openAndChange();
    const { authenticator: outsider } = await createResourceTest({});

    const response = await change(outsider.getNonNullableUser().sId);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { type: "workspace_auth_error" },
    });
  });

  it("keeps a refusal as long as an access, so a retrying replica is not checked again", async () => {
    const { change } = await openAndChange();
    const { authenticator: outsider } = await createResourceTest({});
    const outsiderId = outsider.getNonNullableUser().sId;
    vi.useFakeTimers({ toFake: ["Date"] });
    const refusedAt = Date.now();

    expect((await change(outsiderId)).status).toBe(403);
    vi.setSystemTime(refusedAt + ACCESS_RECHECK_INTERVAL_MS - 1);
    expect((await change(outsiderId)).status).toBe(403);
    expect(recheckCollabAccess).toHaveBeenCalledTimes(1);

    vi.setSystemTime(refusedAt + ACCESS_RECHECK_INTERVAL_MS);
    expect((await change(outsiderId)).status).toBe(403);
    expect(recheckCollabAccess).toHaveBeenCalledTimes(2);
  });

  it("checks the user's access again only once it is ACCESS_RECHECK_INTERVAL_MS old", async () => {
    const { change } = await openAndChange();
    vi.useFakeTimers({ toFake: ["Date"] });
    const checkedAt = Date.now();

    await change();
    vi.setSystemTime(checkedAt + ACCESS_RECHECK_INTERVAL_MS - 1);
    await change();
    expect(recheckCollabAccess).toHaveBeenCalledTimes(1);

    vi.setSystemTime(checkedAt + ACCESS_RECHECK_INTERVAL_MS);
    await change();
    expect(recheckCollabAccess).toHaveBeenCalledTimes(2);
  });
});
