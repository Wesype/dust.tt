// Each open document has one owner among the collab servers, the one that saves it. Its record in
// Redis names it and how the other servers reach it.
import { randomUUID } from "node:crypto";
import config from "@app/lib/api/config";
import type { RedisClientType } from "@app/lib/api/redis";
import { runOnRedis } from "@app/lib/api/redis";
import { raceWithTimeout } from "@app/lib/utils/async_utils";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";
import { normalizeError } from "@app/types/shared/utils/error_utils";
import { safeParseJSON } from "@app/types/shared/utils/json_utils";
import { z } from "zod";

// An owner that stops renewing, crashed or paused, loses its documents within the lease.
export const OWNER_LEASE_MS = 30 * 1000;
export const OWNER_RENEW_INTERVAL_MS = OWNER_LEASE_MS / 3;
export const OWNER_REDIS_TIMEOUT_MS = 5 * 1000;
const RECORDS_BATCH_SIZE = 500;

const collabOwnerSchema = z.object({
  serverId: z.string().min(1),
  url: z.string().min(1),
});

/** A collab server as ownership records name it: a restart on the same address is another one. */
export type CollabOwner = z.infer<typeof collabOwnerSchema>;

export type OwnershipRenewal = { lost: string[]; error: Error | undefined };

export type DocumentClaim =
  | { kind: "owner" }
  | { kind: "replica"; owner: CollabOwner };

const renewalFlagsSchema = (length: number) =>
  z.array(z.union([z.literal(0), z.literal(1)])).length(length);

const ownerKey = (documentName: string) => `collab_owner:${documentName}`;

// On the main Redis, which never evicts: the collab Redis evicts its least recently used keys, and
// a lost record lets a second server claim a document its owner still holds. Only the Redis call's
// own failure, or its silence, is an `Err`: a disconnected client queues commands instead of
// failing them.
async function runOnOwnerRedis<T>(
  run: (redis: RedisClientType) => Promise<T>
): Promise<Result<T, Error>> {
  const ran = await raceWithTimeout(
    runOnRedis({ origin: "collab_owner" }, async (redis) => {
      try {
        return new Ok(await run(redis));
      } catch (err) {
        return new Err(normalizeError(err));
      }
    }),
    OWNER_REDIS_TIMEOUT_MS
  );
  return ran === "timeout"
    ? new Err(new Error("Redis did not answer in time."))
    : ran;
}

function parseOwner(value: string | null): CollabOwner | null {
  if (value === null) {
    return null;
  }
  const json = safeParseJSON(value);
  if (json.isErr()) {
    return null;
  }
  const parsed = collabOwnerSchema.safeParse(json.value);
  return parsed.success ? parsed.data : null;
}

export async function getDocumentOwner(
  documentName: string
): Promise<Result<CollabOwner | null, Error>> {
  const value = await runOnOwnerRedis((redis) =>
    redis.get(ownerKey(documentName))
  );
  return value.isErr() ? value : new Ok(parseOwner(value.value));
}

// Takes the key, or renews it, unless another record holds it. Returns the record holding it.
const CLAIM_RECORD_SCRIPT = `
local current = redis.call("get", KEYS[1])
if not current or current == ARGV[1] then
  redis.call("set", KEYS[1], ARGV[1], "PX", ARGV[2])
  return ARGV[1]
end
return current`;

// Each key is renewed, or re-created once expired, unless another record holds it. Returns 1 per
// key renewed, 0 per key lost, in order.
const RENEW_OWN_RECORDS_SCRIPT = `
local renewed = {}
for i, key in ipairs(KEYS) do
  local current = redis.call("get", key)
  if not current or current == ARGV[1] then
    redis.call("set", key, ARGV[1], "PX", ARGV[2])
    renewed[i] = 1
  else
    renewed[i] = 0
  end
end
return renewed`;

const DELETE_OWN_RECORDS_SCRIPT = `
local deleted = 0
for _, key in ipairs(KEYS) do
  if redis.call("get", key) == ARGV[1] then
    deleted = deleted + redis.call("del", key)
  end
end
return deleted`;

/**
 * @cc [owner:tdraier,label:concurrency;product] collab-document-ownership
 * A document MUST be owned by at most one collab server at a time, recorded under
 * `collab_owner:{documentName}` in the main Redis, which never evicts (`main-redis-noeviction`), as
 * the server's `self`, and expiring `OWNER_LEASE_MS` after its last claim or renewal. `claim` MUST
 * atomically make the server the owner when no other server's record is there, renewing its own
 * one, and otherwise return that owner. A claim that fails or finds another owner MUST NOT add the
 * document to those owned, and MUST leave a document an earlier claim owns counted as owned: its
 * caller MUST then `release` it, deleting the record at once rather than letting it expire.
 * `release` MUST delete the server's own record even when it does not count the document as owned,
 * so that a claim that timed out but that Redis still applies leaves no record behind; claims,
 * renewals and releases MUST therefore go through `runOnRedis`, whose commands keep their order
 * (`one-client-per-uri`). Renewing and releasing MUST extend or delete only the server's own
 * record, never another's; a renewal MUST re-create a record that expired, and one that finds
 * another server's record MUST report the document lost and stop counting it as owned. A Redis
 * command's failure, or a Redis that does not answer within `OWNER_REDIS_TIMEOUT_MS`, MUST be an
 * `Err`, or for a renewal its `error`, any other failure MUST throw; a renewal batch that fails, or
 * whose answer is unreadable, MUST keep counting its documents as owned, their records may still
 * hold, and MUST NOT stop the other batches nor hide the documents they lost.
 */
export class DocumentOwnership {
  private readonly owned = new Set<string>();
  private readonly record: string;

  constructor(readonly self: CollabOwner) {
    this.record = JSON.stringify(self);
  }

  owns(documentName: string): boolean {
    return this.owned.has(documentName);
  }

  async claim(documentName: string): Promise<Result<DocumentClaim, Error>> {
    const holder = await runOnOwnerRedis((redis) =>
      redis.eval(CLAIM_RECORD_SCRIPT, {
        keys: [ownerKey(documentName)],
        arguments: [this.record, String(OWNER_LEASE_MS)],
      })
    );
    if (holder.isErr()) {
      return holder;
    }
    if (holder.value === this.record) {
      this.owned.add(documentName);
      return new Ok({ kind: "owner" });
    }
    const owner = parseOwner(
      typeof holder.value === "string" ? holder.value : null
    );
    if (!owner) {
      return new Err(new Error("The document's owner record is unreadable."));
    }
    return new Ok({ kind: "replica", owner });
  }

  /**
   * Renews every document the server owns; returns the ones another server's record now holds,
   * and the first failure of a batch, the others still renewed.
   */
  async renew(): Promise<OwnershipRenewal> {
    const documentNames = [...this.owned];
    const lost: string[] = [];
    let error: Error | undefined;
    for (let i = 0; i < documentNames.length; i += RECORDS_BATCH_SIZE) {
      // Released since: renewing would re-create its record.
      const batch = documentNames
        .slice(i, i + RECORDS_BATCH_SIZE)
        .filter((documentName) => this.owned.has(documentName));
      if (batch.length === 0) {
        continue;
      }
      const renewed = await runOnOwnerRedis((redis) =>
        redis.eval(RENEW_OWN_RECORDS_SCRIPT, {
          keys: batch.map(ownerKey),
          arguments: [this.record, String(OWNER_LEASE_MS)],
        })
      );
      if (renewed.isErr()) {
        error ??= renewed.error;
        continue;
      }
      const flags = renewalFlagsSchema(batch.length).safeParse(renewed.value);
      if (!flags.success) {
        error ??= new Error("The renewal's answer is unreadable.");
        continue;
      }
      batch.forEach((documentName, index) => {
        if (flags.data[index] === 0) {
          this.owned.delete(documentName);
          lost.push(documentName);
        }
      });
    }
    return { lost, error };
  }

  async release(documentName: string): Promise<Result<void, Error>> {
    // Even when not counted as owned: a claim that timed out may still reach Redis, and this
    // delete, sent after it on the same client, removes the record it leaves.
    this.owned.delete(documentName);
    return this.deleteRecords([documentName]);
  }

  async releaseAll(): Promise<Result<void, Error>> {
    const documentNames = [...this.owned];
    this.owned.clear();
    return this.deleteRecords(documentNames);
  }

  private async deleteRecords(
    documentNames: string[]
  ): Promise<Result<void, Error>> {
    let failure: Error | undefined;
    for (let i = 0; i < documentNames.length; i += RECORDS_BATCH_SIZE) {
      const deleted = await runOnOwnerRedis((redis) =>
        redis.eval(DELETE_OWN_RECORDS_SCRIPT, {
          keys: documentNames.slice(i, i + RECORDS_BATCH_SIZE).map(ownerKey),
          arguments: [this.record],
        })
      );
      if (deleted.isErr()) {
        failure = deleted.error;
      }
    }
    return failure ? new Err(failure) : new Ok(undefined);
  }
}

/** This process's ownership, under a new id at each start and its `COLLAB_PEER_URL`. */
export function createDocumentOwnership(): DocumentOwnership {
  return new DocumentOwnership({
    serverId: randomUUID(),
    url: config.getCollabServerPeerUrl(),
  });
}
