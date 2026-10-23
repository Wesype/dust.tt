import config from "@app/lib/api/config";
import logger from "@app/logger/logger";
import {
  createCollabRelay,
  RELAY_REDIS_TIMEOUT_MS,
} from "@front-api/collab/lib/relay";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("createCollabRelay", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("times out its Redis commands and logs its clients' errors", async () => {
    const warn = vi.spyOn(logger, "warn");
    const relay = createCollabRelay({
      redisUri: config.getRedisUri(),
      serverId: "server-a",
    });
    try {
      for (const client of [relay.pub, relay.sub]) {
        expect(client.options).toMatchObject({
          commandTimeout: RELAY_REDIS_TIMEOUT_MS,
        });
      }

      relay.pub.emit("error", new Error("Redis unreachable."));

      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ serverId: "server-a" }),
        "Collab relay Redis client error"
      );
    } finally {
      await relay.onDestroy();
    }
  });
});
