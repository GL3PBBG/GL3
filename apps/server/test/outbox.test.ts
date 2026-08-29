import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  deliverAndClear, insertOutboxEvents, readOutboxStats, settleOutboxOnce, startOutboxLoop,
  type OutboxClaimedRow,
} from "../src/bus/outbox.js";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import type { GameEvent } from "@gl3/shared";
import { outbox } from "../src/db/schema/index.js";
import { createRedis, createSubscriber } from "../src/redis.js";
import { testDb } from "./helpers/db.js";

// Real Postgres, real Redis, real BullMQ — the no-mocks rule covers the bus
// path this file exists to prove. The one deliberate fault is a client
// pointed at a refused port, the sentence-sweeper-loop precedent.
const { db, sql: conn } = testDb();
const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
const redis = createRedis(redisUrl);
const subscriber = createSubscriber(redisUrl);

beforeAll(async () => { await subscriber.subscribe(GAME_EVENTS_CHANNEL); });
afterAll(async () => {
  await conn.end();
  redis.disconnect();
  subscriber.disconnect();
});

/** Same construction plugin-ctx-transaction.test.ts uses: rejects immediately, never buffers. */
const deadRedis = (): Redis => new Redis("redis://127.0.0.1:1", {
  enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: 100,
  retryStrategy: () => null, lazyConnect: true,
});

/** Rule 4: filter the global channel by THIS test's own freshly-minted actor. */
function watchOwnEvents(actorId: string): { seen: unknown[]; settled: Promise<void> } {
  const seen: unknown[] = [];
  let resolveFirst: () => void = () => {};
  const first = new Promise<void>((resolve) => { resolveFirst = resolve; });
  const onMessage = (channel: string, raw: string): void => {
    if (channel !== GAME_EVENTS_CHANNEL) return;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return;
    if (!("actorId" in parsed) || parsed.actorId !== actorId) return;
    seen.push(parsed);
    resolveFirst();
  };
  subscriber.on("message", onMessage);
  const settled = Promise.race([first, new Promise<void>((r) => setTimeout(r, 2000))])
    .then(() => { subscriber.off("message", onMessage); });
  return { seen, settled };
}

function envelope(actorId: string): GameEvent {
  return {
    id: uuidv7(),
    type: "plugin.event",
    at: new Date().toISOString(),
    actorId,
    actorName: "outbox-test",
    audience: { kind: "global" },
    pluginId: "outbox-test",
    name: "pinged",
    payload: {},
  };
}

async function countOutbox(): Promise<number> {
  return (await db.select({ id: outbox.id }).from(outbox)).length;
}

/** Reads the table back in the delivery shape — the jsonb round-trip included. */
async function claimedRows(): Promise<OutboxClaimedRow[]> {
  return await db.select({ id: outbox.id, kind: outbox.kind, payload: outbox.payload }).from(outbox);
}

/** Inserts envelopes through the SAME helper the core routes use, inside a transaction. */
async function stage(events: readonly GameEvent[]): Promise<OutboxClaimedRow[]> {
  return await db.transaction(async (tx) => insertOutboxEvents(tx, events));
}

describe("deliverAndClear", () => {
  it("publishes staged rows and deletes them", async () => {
    const actorId = uuidv7();
    const event = envelope(actorId);
    const staged = await stage([event]);
    const watch = watchOwnEvents(actorId);

    const result = await deliverAndClear(db, { redis }, staged);

    expect(result).toEqual({ delivered: 1, retained: 0 });
    await watch.settled;
    expect(watch.seen).toMatchObject([{ id: event.id, type: "plugin.event", name: "pinged" }]);
    expect(await countOutbox()).toBe(0);
  });

  it("retains rows whose publish failed and never throws — the dispatcher owns them", async () => {
    const failing = deadRedis();
    const actorId = uuidv7();
    await stage([envelope(actorId)]);

    // The refused socket must not escape as a rejection: committed facts are
    // durable and delivery is retryable, so this call answers, not throws.
    const result = await deliverAndClear(db, { redis: failing }, await claimedRows());
    failing.disconnect();

    expect(result).toEqual({ delivered: 0, retained: 1 });
    expect(await countOutbox()).toBe(1);

    // And the retained row delivers the moment Redis is reachable again.
    const settled = await settleOutboxOnce(db, { redis });
    expect(settled.delivered).toBe(1);
    expect(await countOutbox()).toBe(0);
  });

  // The delivery-boundary validation, proven per kind: a corrupt payload
  // can never deliver, so it must DROP loudly — not throw inside BigInt or
  // BullMQ and retry forever, which was the gap the follow-up audit named.
  it("drops a corrupt score row instead of retrying it forever, and counts the drop", async () => {
    const before = readOutboxStats().dropped;
    await db.insert(outbox).values({
      id: uuidv7(), kind: "score",
      // playerId is not a uuid and score is not a decimal string.
      payload: { leaderboard: "cash", playerId: "not-a-uuid", score: "12.5", prefix: "leaderboard" },
    });
    const logged: unknown[] = [];
    const result = await deliverAndClear(
      db, { redis, onError: (e) => logged.push(e) }, await claimedRows(),
    );

    expect(result.delivered).toBe(0);
    expect(logged).toHaveLength(1);
    expect(await countOutbox()).toBe(0);
    expect(readOutboxStats().dropped).toBe(before + 1);
  });

  it("drops a corrupt job payload (missing seed) the same way", async () => {
    await db.insert(outbox).values({
      id: uuidv7(), kind: "job",
      payload: { pluginId: "outbox-test", jobName: "resolve", data: {} },
    });
    const logged: unknown[] = [];
    const result = await deliverAndClear(
      db, { redis, onError: (e) => logged.push(e) }, await claimedRows(),
    );

    expect(result.delivered).toBe(0);
    expect(logged).toHaveLength(1);
    expect(await countOutbox()).toBe(0);
  });

  it("counts delivered rows and stamps lastDeliveredAt on the process stats", async () => {
    const actorId = uuidv7();
    const staged = await stage([envelope(actorId)]);
    const before = readOutboxStats();

    await deliverAndClear(db, { redis }, staged);

    const after = readOutboxStats();
    expect(after.delivered).toBe(before.delivered + 1);
    expect(after.lastDeliveredAt).not.toBeNull();
    expect(after.lastDeliveredAt! >= (before.lastDeliveredAt ?? "")).toBe(true);
  });

  it("drops a job row whose queue does not exist, loudly, instead of retrying forever", async () => {
    await db.insert(outbox).values({
      id: uuidv7(), kind: "job",
      payload: { pluginId: "nope", jobName: "nope", data: {}, seed: "s" },
    });
    const logged: unknown[] = [];
    const result = await deliverAndClear(
      db, { redis, onError: (e) => logged.push(e) }, await claimedRows(),
    );

    expect(result.delivered).toBe(0);
    expect(logged).toHaveLength(1);
    expect(await countOutbox()).toBe(0);
  });

  it("delivers a job row to its queue with the row id as the BullMQ jobId", async () => {
    // BullMQ wants maxRetriesPerRequest: null and its own client; handing it
    // the shared one would fight our command patterns on shutdown.
    const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
    const queue = new Queue("outbox-test-job", { connection });
    try {
      const jobId = uuidv7();
      await db.insert(outbox).values({
        id: jobId, kind: "job",
        payload: { pluginId: "outbox-test", jobName: "resolve", data: { x: "1" }, seed: "seed-1" },
      });
      const result = await deliverAndClear(db, {
        redis,
        queueResolver: (pluginId, jobName) =>
          pluginId === "outbox-test" && jobName === "resolve" ? queue : undefined,
      }, await claimedRows());

      expect(result.delivered).toBe(1);
      const job = await queue.getJob(jobId);
      expect(job).not.toBeNull();
      // The seed travels in the job data — a re-delivery replays the same
      // outcome, and the worker rebuilds its rng from exactly this.
      expect(job?.data).toEqual({ x: "1", seed: "seed-1" });
      expect(await countOutbox()).toBe(0);
      await queue.remove(jobId);
    } finally {
      await queue.close();
      connection.disconnect();
    }
  });
});

describe("settleOutboxOnce", () => {
  it("claims a failed row only after its backoff expires", async () => {
    const failing = deadRedis();
    const actorId = uuidv7();
    await stage([envelope(actorId)]);

    // First pass fails delivery and stamps the backoff (1s on the first
    // attempt: power(2, attempts-before-this-claim) with attempts 0)…
    const first = await settleOutboxOnce(db, { redis: failing });
    failing.disconnect();
    expect(first).toEqual({ claimed: 1, delivered: 0, retained: 1 });

    // …so an immediate second pass, healthy Redis and all, claims nothing.
    const immediate = await settleOutboxOnce(db, { redis });
    expect(immediate.claimed).toBe(0);
    expect(await countOutbox()).toBe(1);

    // Expire the backoff the way time would, and the row delivers.
    await db.update(outbox).set({ notBefore: new Date() });
    const watch = watchOwnEvents(actorId);
    const settled = await settleOutboxOnce(db, { redis });
    expect(settled).toEqual({ claimed: 1, delivered: 1, retained: 0 });
    await watch.settled;
    expect(watch.seen).toHaveLength(1);
  });

  it("increments attempts on each claim", async () => {
    const actorId = uuidv7();
    await stage([envelope(actorId)]);

    for (const fail of [deadRedis(), deadRedis()]) {
      await settleOutboxOnce(db, { redis: fail });
      fail.disconnect();
      await db.update(outbox).set({ notBefore: new Date() });
    }

    const [row] = await db.select().from(outbox);
    expect(row?.attempts).toBe(2);
    // Clean up: drain it with the healthy client so the file ends empty.
    await settleOutboxOnce(db, { redis });
    expect(await countOutbox()).toBe(0);
  });
});

describe("startOutboxLoop", () => {
  it("drains retained rows in the background and stops cleanly", async () => {
    const actorId = uuidv7();
    const event = envelope(actorId);
    await stage([event]);
    const watch = watchOwnEvents(actorId);

    const loop = startOutboxLoop({ db, redis, intervalMs: 50 });
    try {
      await watch.settled;
      // The row deletion lags the publish by one statement — poll for it
      // rather than sleeping a fixed guess (the sentence-sweeper-loop shape).
      const deadline = Date.now() + 2000;
      while ((await countOutbox()) > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(await countOutbox()).toBe(0);
      expect(watch.seen).toMatchObject([{ id: event.id }]);
    } finally {
      loop.stop();
    }
  });
});
