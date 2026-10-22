import config from "@app/lib/api/config";
import { COLLAB_SOURCE_READ_PATH } from "@app/types/collab_internal";
import {
  post,
  useInternalSecret,
} from "@front-api/collab/routes/routes.test_utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("internal routes", () => {
  const read = { workspaceId: "w1", canonicalPath: "user-u1/notes.md" };

  beforeEach(useInternalSecret);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses a request without the secret, or when none is configured", async () => {
    expect((await post(COLLAB_SOURCE_READ_PATH, read)).status).toBe(401);
    expect(
      (await post(COLLAB_SOURCE_READ_PATH, read, "Bearer wrong")).status
    ).toBe(401);

    vi.mocked(config.getCollabServerInternalSecret).mockReturnValue(undefined);
    expect((await post(COLLAB_SOURCE_READ_PATH, read, "Bearer ")).status).toBe(
      401
    );
  });
});
