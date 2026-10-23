import logger from "@app/logger/logger";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";
import { normalizeError } from "@app/types/shared/utils/error_utils";
import { Redis } from "@hocuspocus/extension-redis";
import type { Extension } from "@hocuspocus/server";
import { Redis as IORedis } from "ioredis";

const RELAY_PREFIX = "collab_relay";
// A replica first loads its owner's copy: this only waits for the edits made meanwhile.
const AWAIT_INITIAL_SYNC_MS = 2 * 1000;
// As the ownership's commands: a Redis down or stuck fails them rather than leaving them waiting.
export const RELAY_REDIS_TIMEOUT_MS = 5 * 1000;

/** What the server asks of its relay besides its Hocuspocus hooks. */
export interface DocumentRelay extends Extension {
  /** Whether a server other than this one holds the document. */
  hasOtherHolders(documentName: string): Promise<Result<boolean, Error>>;
}

/**
 * Relays Yjs updates, awareness and broadcast messages between the collab servers holding a
 * document, over one Redis pub/sub channel per document. Its save lock is left out: only the
 * document's owner saves.
 */
export class CollabRelay extends Redis implements DocumentRelay {
  override async onStoreDocument() {}

  override async afterStoreDocument() {}

  async hasOtherHolders(documentName: string): Promise<Result<boolean, Error>> {
    try {
      const result = await this.pub.pubsub(
        "NUMSUB",
        `${RELAY_PREFIX}:${documentName}`
      );
      return new Ok(Array.isArray(result) && Number(result[1] ?? 0) > 1);
    } catch (err) {
      return new Err(normalizeError(err));
    }
  }
}

export function createCollabRelay({
  redisUri,
  serverId,
}: {
  redisUri: string;
  serverId: string;
}): CollabRelay {
  return new CollabRelay({
    createClient: () => {
      const client = new IORedis(redisUri, {
        commandTimeout: RELAY_REDIS_TIMEOUT_MS,
      });
      client.on("error", (err) =>
        logger.warn(
          { err: normalizeError(err), serverId },
          "Collab relay Redis client error"
        )
      );
      return client;
    },
    prefix: RELAY_PREFIX,
    identifier: serverId,
    awaitInitialSyncTimeout: AWAIT_INITIAL_SYNC_MS,
  });
}
