// @vitest-environment node
import { listAllGrants } from "@app/lib/api/dfs/grants";
import { DfsClient } from "@app/lib/dfs/client";
import type { DfsWireMessage } from "@app/lib/dfs/proto";
import { Ok } from "@app/types/shared/result";
import { describe, expect, it } from "vitest";

const ROOT_ID = "0190c3a0b1c27d4e8f0a1b2c3d4e5f60";
const TENANT_KEY = "t".repeat(64);

describe("listAllGrants", () => {
  it("lists every grant across pages", async () => {
    const pages = [
      { grants: [{ allow: { subject: "g:eng", mode: 0o6 } }], nextAfter: "c1" },
      { grants: [{ deny: { mode: 0o6 } }] },
    ];
    const requests: DfsWireMessage[] = [];
    const client = new DfsClient(
      {
        call: async (_method, request) => {
          requests.push(request);
          return new Ok(pages[requests.length - 1]);
        },
      },
      TENANT_KEY
    );

    const res = await listAllGrants(client, { objectId: ROOT_ID });

    expect(res.isOk() && res.value).toEqual([
      { type: "allow", subject: "g:eng", mode: 0o6 },
      { type: "deny", mode: 0o6 },
    ]);
    expect(requests.map((request) => request.after)).toEqual([undefined, "c1"]);
  });
});
