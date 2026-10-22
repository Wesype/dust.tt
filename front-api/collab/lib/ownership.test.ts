import { randomUUID } from "node:crypto";
import {
  closeRedisClients,
  getRedisStreamClient,
  runOnRedis,
} from "@app/lib/api/redis";
import type { CollabOwner } from "@front-api/collab/lib/ownership";
import {
  DocumentOwnership,
  getDocumentOwner,
  OWNER_LEASE_MS,
} from "@front-api/collab/lib/ownership";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// The ownership scripts run on the test Redis, not on the shared Redis mock.
vi.unmock("@app/lib/api/redis");

const PEER_URL = "http://10.0.0.1:3000";
const OTHER: CollabOwner = {
  serverId: "other-server",
  url: "http://10.0.0.2:3000",
};

const SELF: CollabOwner = { serverId: "this-server", url: PEER_URL };
const OWN_RECORD = JSON.stringify(SELF);

const newDocumentName = () => `w1:user-u1/${randomUUID()}.md`;

async function recordOf(
  documentName: string,
  owner: CollabOwner,
  ttlMs = OWNER_LEASE_MS
) {
  await runOnRedis({ origin: "collab_owner" }, (redis) =>
    redis.set(`collab_owner:${documentName}`, JSON.stringify(owner), {
      PX: ttlMs,
    })
  );
}

// In seconds, as the test Redis reports it.
async function ttlOf(documentName: string): Promise<number> {
  return runOnRedis({ origin: "collab_owner" }, (redis) =>
    redis.ttl(`collab_owner:${documentName}`)
  );
}

describe("collab document ownership", () => {
  let ownership: DocumentOwnership;

  beforeEach(() => {
    ownership = new DocumentOwnership(SELF);
  });

  afterEach(async () => {
    await ownership.releaseAll();
  });

  afterAll(async () => {
    await closeRedisClients();
  });

  it("claims a free document under this server, then releases it", async () => {
    const documentName = newDocumentName();

    const claim = await ownership.claim(documentName);
    expect(claim.isOk() && claim.value).toEqual({ kind: "owner" });
    expect(ownership.owns(documentName)).toBe(true);
    const owner = await getDocumentOwner(documentName);
    expect(owner.isOk() && owner.value).toEqual(SELF);
    expect(await ttlOf(documentName)).toBeGreaterThan(
      OWNER_LEASE_MS / 1000 - 2
    );

    expect((await ownership.release(documentName)).isOk()).toBe(true);
    expect(ownership.owns(documentName)).toBe(false);
    const released = await getDocumentOwner(documentName);
    expect(released.isOk() && released.value).toBeNull();
  });

  it("claims a document it already owns again, renewing its lease", async () => {
    const documentName = newDocumentName();
    await ownership.claim(documentName);
    await runOnRedis({ origin: "collab_owner" }, (redis) =>
      redis.set(`collab_owner:${documentName}`, OWN_RECORD, { PX: 1000 })
    );

    const claim = await ownership.claim(documentName);
    expect(claim.isOk() && claim.value).toEqual({ kind: "owner" });
    expect(await ttlOf(documentName)).toBeGreaterThan(
      OWNER_LEASE_MS / 1000 - 2
    );
  });

  it("keeps counting a document as owned when claiming it again fails", async () => {
    const documentName = newDocumentName();
    await ownership.claim(documentName);
    // A hash fails the claim's script with WRONGTYPE.
    await runOnRedis({ origin: "collab_owner" }, async (redis) => {
      await redis.del(`collab_owner:${documentName}`);
      await redis.hSet(`collab_owner:${documentName}`, "field", "value");
    });

    expect((await ownership.claim(documentName)).isErr()).toBe(true);
    expect(ownership.owns(documentName)).toBe(true);

    await runOnRedis({ origin: "collab_owner" }, (redis) =>
      redis.del(`collab_owner:${documentName}`)
    );
  });

  it("releases its own record left by a claim that timed out", async () => {
    const documentName = newDocumentName();
    // What a claim Redis applies after its timeout leaves: the record, not counted as owned.
    await recordOf(documentName, SELF);
    expect(ownership.owns(documentName)).toBe(false);

    expect((await ownership.release(documentName)).isOk()).toBe(true);
    const owner = await getDocumentOwner(documentName);
    expect(owner.isOk() && owner.value).toBeNull();
  });

  it("returns the server owning a document, and never releases its record", async () => {
    const documentName = newDocumentName();
    await recordOf(documentName, OTHER);

    const claim = await ownership.claim(documentName);
    expect(claim.isOk() && claim.value).toEqual({
      kind: "replica",
      owner: OTHER,
    });
    expect(ownership.owns(documentName)).toBe(false);

    await ownership.release(documentName);
    const owner = await getDocumentOwner(documentName);
    expect(owner.isOk() && owner.value).toEqual(OTHER);
  });

  it("claims a document whose owner's lease ran out", async () => {
    const documentName = newDocumentName();
    await recordOf(documentName, OTHER, 50);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const claim = await ownership.claim(documentName);
    expect(claim.isOk() && claim.value).toEqual({ kind: "owner" });
  });

  it("renews the documents it owns and reports those another server took", async () => {
    const kept = newDocumentName();
    const taken = newDocumentName();
    const expired = newDocumentName();
    for (const documentName of [kept, taken, expired]) {
      await ownership.claim(documentName);
    }
    await runOnRedis({ origin: "collab_owner" }, (redis) =>
      redis.set(`collab_owner:${kept}`, OWN_RECORD, { PX: 1000 })
    );
    await recordOf(taken, OTHER, 5000);
    await runOnRedis({ origin: "collab_owner" }, (redis) =>
      redis.del(`collab_owner:${expired}`)
    );

    expect(await ownership.renew()).toEqual({
      lost: [taken],
      error: undefined,
    });
    expect(ownership.owns(kept)).toBe(true);
    expect(ownership.owns(taken)).toBe(false);
    expect(ownership.owns(expired)).toBe(true);
    expect(await ttlOf(kept)).toBeGreaterThan(OWNER_LEASE_MS / 1000 - 2);
    const recreated = await getDocumentOwner(expired);
    expect(recreated.isOk() && recreated.value).toEqual(SELF);
    expect(await ttlOf(expired)).toBeGreaterThan(OWNER_LEASE_MS / 1000 - 2);
    const owner = await getDocumentOwner(taken);
    expect(owner.isOk() && owner.value).toEqual(OTHER);
    expect(await ttlOf(taken)).toBeLessThanOrEqual(5);
  });

  it("renews the other batches when one fails, still reporting their lost documents", async () => {
    const firstBatch = Array.from({ length: 500 }, newDocumentName);
    const taken = newDocumentName();
    for (const documentName of [...firstBatch, taken]) {
      await ownership.claim(documentName);
    }
    // A hash fails the first batch's script with WRONGTYPE.
    await runOnRedis({ origin: "collab_owner" }, async (redis) => {
      await redis.del(`collab_owner:${firstBatch[0]}`);
      await redis.hSet(`collab_owner:${firstBatch[0]}`, "field", "value");
    });
    await recordOf(taken, OTHER);

    const { lost, error } = await ownership.renew();
    expect(error).toBeInstanceOf(Error);
    expect(lost).toEqual([taken]);
    expect(
      firstBatch.every((documentName) => ownership.owns(documentName))
    ).toBe(true);

    await runOnRedis({ origin: "collab_owner" }, (redis) =>
      redis.del(`collab_owner:${firstBatch[0]}`)
    );
  });

  it("keeps counting a batch as owned when its renewal answer is unreadable", async () => {
    const documentName = newDocumentName();
    await ownership.claim(documentName);
    const redis = await getRedisStreamClient({ origin: "collab_owner" });
    const evalSpy = vi.spyOn(redis, "eval").mockResolvedValueOnce("OK");

    const { lost, error } = await ownership.renew();
    expect(error).toBeInstanceOf(Error);
    expect(lost).toEqual([]);
    expect(ownership.owns(documentName)).toBe(true);

    evalSpy.mockRestore();
  });

  it("releases every document it owns, never another server's record", async () => {
    const released = [newDocumentName(), newDocumentName()];
    const taken = newDocumentName();
    for (const documentName of [...released, taken]) {
      await ownership.claim(documentName);
    }
    await recordOf(taken, OTHER);

    expect((await ownership.releaseAll()).isOk()).toBe(true);
    for (const documentName of released) {
      expect(ownership.owns(documentName)).toBe(false);
      const owner = await getDocumentOwner(documentName);
      expect(owner.isOk() && owner.value).toBeNull();
    }
    const owner = await getDocumentOwner(taken);
    expect(owner.isOk() && owner.value).toEqual(OTHER);
  });
});
