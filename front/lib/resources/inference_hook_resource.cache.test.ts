import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@app/lib/utils/cache", async () =>
  vi.importActual("@app/lib/utils/cache")
);

import { getRedisCacheClient } from "@app/lib/api/redis";
import { InferenceHookResource } from "@app/lib/resources/inference_hook_resource";
import { frontSequelize } from "@app/lib/resources/storage";
import { withTransaction } from "@app/lib/utils/sql_utils";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
import { InferenceHookFactory } from "@app/tests/utils/InferenceHookFactory";

async function listIds(
  auth: Parameters<typeof InferenceHookResource.listByWorkspace>[0]
) {
  return (await InferenceHookResource.listByWorkspace(auth)).map((h) => h.sId);
}

// Applies cache invalidations only after a delay, so an invalidation that is not awaited leaves
// the previous snapshot readable.
async function delayCacheInvalidations() {
  const redis = await getRedisCacheClient({ origin: "cache_with_redis" });
  const evalMock = vi.mocked(redis.eval);
  const original = evalMock.getMockImplementation();
  if (!original) {
    throw new Error("Expected the Redis mock to implement eval");
  }
  evalMock.mockImplementation(async (...args) => {
    const [script] = args;
    if (typeof script === "string" && script.includes('key .. ":generation"')) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return original(...args);
  });
  return () => evalMock.mockImplementation(original);
}

describe("InferenceHookResource cache", () => {
  let restoreRedis: (() => void) | null = null;

  afterEach(() => {
    restoreRedis?.();
    restoreRedis = null;
  });

  it("returns a created hook once makeNew resolves", async () => {
    const { authenticator } = await createResourceTest({ role: "admin" });
    expect(await listIds(authenticator)).toEqual([]);
    restoreRedis = await delayCacheInvalidations();

    const hook = await InferenceHookFactory.basic(authenticator);

    expect(await listIds(authenticator)).toEqual([hook.sId]);
  });

  it("drops a deleted hook once delete resolves", async () => {
    const { authenticator } = await createResourceTest({ role: "admin" });
    const hook = await InferenceHookFactory.basic(authenticator);
    expect(await listIds(authenticator)).toEqual([hook.sId]);
    restoreRedis = await delayCacheInvalidations();

    await hook.delete(authenticator, {});

    expect(await listIds(authenticator)).toEqual([]);
  });

  it("drops every hook once deleteAllForWorkspace resolves", async () => {
    const { authenticator } = await createResourceTest({ role: "admin" });
    await InferenceHookFactory.basic(authenticator);
    expect(await listIds(authenticator)).toHaveLength(1);
    restoreRedis = await delayCacheInvalidations();

    await InferenceHookResource.deleteAllForWorkspace(authenticator);

    expect(await listIds(authenticator)).toEqual([]);
  });

  it("invalidates when the caller's transaction commits, not before", async () => {
    const { authenticator } = await createResourceTest({ role: "admin" });
    expect(await listIds(authenticator)).toEqual([]);

    await withTransaction(async (parent) => {
      const transaction = await frontSequelize.transaction({
        transaction: parent,
      });
      const hook = await InferenceHookResource.makeNew(
        authenticator,
        {
          name: "Test hook",
          provider: "dust",
          events: ["before_model_call"],
          enforcement: null,
          onError: "allow",
          timeoutMs: 5_000,
        },
        { transaction }
      );
      expect(await listIds(authenticator)).toEqual([]);

      await transaction.commit();

      expect(await listIds(authenticator)).toEqual([hook.sId]);
    });
  });

  it("keeps the cached list when the caller's transaction rolls back", async () => {
    const { authenticator } = await createResourceTest({ role: "admin" });
    const kept = await InferenceHookFactory.basic(authenticator);
    expect(await listIds(authenticator)).toEqual([kept.sId]);

    await withTransaction(async (parent) => {
      const transaction = await frontSequelize.transaction({
        transaction: parent,
      });
      await kept.delete(authenticator, { transaction });

      await transaction.rollback();

      expect(await listIds(authenticator)).toEqual([kept.sId]);
    });
  });

  it("falls back to the database when the cache is unavailable", async () => {
    const { authenticator } = await createResourceTest({ role: "admin" });
    const hook = await InferenceHookFactory.basic(authenticator);
    vi.mocked(getRedisCacheClient).mockRejectedValueOnce(
      new Error("Redis unavailable")
    );

    expect(await listIds(authenticator)).toEqual([hook.sId]);
  });
});
