import type { GameEvent } from "@gl3/shared";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GAME_EVENTS_CHANNEL, publishEvent } from "../src/bus/publish.js";
import { players, playerStats, pushDevices } from "../src/db/schema/index.js";
import { PRESENCE_KEY } from "../src/presence/touch.js";
import { startPushSubscriber, type PushSubscriberHandle } from "../src/push/subscriber.js";
import type { ExpoPushMessage } from "../src/push/sender.js";
import { loadConfig } from "../src/config.js";
import { createRedis, createSubscriber } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";

const { db, sql: conn } = testDb();
const config = loadConfig({ ...process.env, NODE_ENV: "test" });
const redis = createRedis(config.redisUrl);

let handle: PushSubscriberHandle;
let subscriber: Redis;
let captured: ExpoPushMessage[] = [];

/**
 * `game:events` is a single global channel shared by every test file running
 * in parallel (rule 4). This file cannot use `awaitOwnEvent` — it is the push
 * subscriber, not a listener — so it applies the same discipline in the only
 * other place available: every player, token and envelope it creates is
 * unique to this run, and every assertion filters `captured` by a token this
 * file minted. Another file's traffic reaches `handleEvent`, finds no
 * registered device for its actors, and produces nothing.
 */
const tokenFor = (label: string): string => `ExponentPushToken[${label}-${uuidv7()}]`;

async function makePlayerWithDevice(token: string, disabled = false): Promise<string> {
  const playerId = uuidv7();
  await db.insert(players).values({ id: playerId, username: `push_${playerId.slice(-8)}` });
  await db.insert(playerStats).values({ playerId });
  await db.insert(pushDevices).values({
    id: uuidv7(), playerId, expoToken: token, platform: "android",
    ...(disabled ? { disabledAt: new Date() } : {}),
  });
  return playerId;
}

function notificationFor(playerId: string, body: string): GameEvent {
  return {
    id: uuidv7(),
    at: new Date().toISOString(),
    actorId: playerId,
    actorName: "Vito",
    audience: { kind: "player", playerId },
    type: "notification.created",
    notificationId: uuidv7(),
    body,
  };
}

/** Resolves once `predicate` holds, or rejects after `timeoutMs`. */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor: predicate never held");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

beforeEach(async () => {
  await resetDb(db);
  captured = [];
  if (handle === undefined) {
    subscriber = createSubscriber(config.redisUrl);
    handle = await startPushSubscriber({
      db,
      redis,
      subscriber,
      accessToken: null,
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        const batch = JSON.parse(String(init?.body)) as ExpoPushMessage[];
        captured.push(...batch);
        return new Response(JSON.stringify({ data: batch.map(() => ({ status: "ok", id: "t" })) }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });
  }
});

afterAll(async () => {
  await handle.close();
  await redis.quit();
  await conn.end();
});

describe("push dispatch", () => {
  it("pushes one message to a player's registered device", async () => {
    const token = tokenFor("plain");
    const playerId = await makePlayerWithDevice(token);

    await publishEvent(redis, notificationFor(playerId, "Your car was repaired."));

    await waitFor(() => captured.some((m) => m.to === token));
    const mine = captured.filter((m) => m.to === token);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.title).toBe("Gangster Land");
    expect(mine[0]!.body).toBe("Your car was repaired.");
    expect(mine[0]!.data.path).toBe("/notifications");
    expect(mine[0]!.channelId).toBe("default");
    expect(mine[0]!.priority).toBe("high");
  });

  it("suppresses a recipient whose presence score is inside the window", async () => {
    const online = tokenFor("online");
    const sentinel = tokenFor("sentinel-online");
    const onlineId = await makePlayerWithDevice(online);
    const sentinelId = await makePlayerWithDevice(sentinel);
    await redis.zadd(PRESENCE_KEY, Date.now(), onlineId);

    await publishEvent(redis, notificationFor(onlineId, "you are looking at this"));
    await publishEvent(redis, notificationFor(sentinelId, "sentinel"));

    // The subscriber handles events one at a time, in order, so the sentinel
    // arriving proves the suppressed event has already been processed.
    await waitFor(() => captured.some((m) => m.to === sentinel));
    expect(captured.filter((m) => m.to === online)).toHaveLength(0);

    await redis.zrem(PRESENCE_KEY, onlineId);
  });

  it("still pushes a recipient whose presence score is older than the window", async () => {
    const token = tokenFor("stale");
    const playerId = await makePlayerWithDevice(token);
    await redis.zadd(PRESENCE_KEY, Date.now() - 10 * 60 * 1000, playerId);

    await publishEvent(redis, notificationFor(playerId, "still here?"));

    await waitFor(() => captured.some((m) => m.to === token));
    expect(captured.filter((m) => m.to === token)).toHaveLength(1);

    await redis.zrem(PRESENCE_KEY, playerId);
  });

  it("pushes once when the same envelope is delivered twice", async () => {
    const token = tokenFor("dupe");
    const sentinel = tokenFor("sentinel-dupe");
    const playerId = await makePlayerWithDevice(token);
    const sentinelId = await makePlayerWithDevice(sentinel);

    const event = notificationFor(playerId, "exactly once");
    await publishEvent(redis, event);
    await publishEvent(redis, event); // byte-identical redelivery
    await publishEvent(redis, notificationFor(sentinelId, "sentinel"));

    await waitFor(() => captured.some((m) => m.to === sentinel));
    expect(captured.filter((m) => m.to === token)).toHaveLength(1);
  });

  it("pushes nothing to a player whose only device is disabled", async () => {
    const dead = tokenFor("disabled");
    const sentinel = tokenFor("sentinel-disabled");
    const deadId = await makePlayerWithDevice(dead, true);
    const sentinelId = await makePlayerWithDevice(sentinel);

    await publishEvent(redis, notificationFor(deadId, "nobody hears this"));
    await publishEvent(redis, notificationFor(sentinelId, "sentinel"));

    await waitFor(() => captured.some((m) => m.to === sentinel));
    expect(captured.filter((m) => m.to === dead)).toHaveLength(0);
  });

  it("never pushes a global-audience event", async () => {
    const token = tokenFor("global");
    const sentinel = tokenFor("sentinel-global");
    const playerId = await makePlayerWithDevice(token);
    const sentinelId = await makePlayerWithDevice(sentinel);

    await publishEvent(redis, {
      ...notificationFor(playerId, "broadcast"),
      audience: { kind: "global" },
    });
    await publishEvent(redis, notificationFor(sentinelId, "sentinel"));

    await waitFor(() => captured.some((m) => m.to === sentinel));
    expect(captured.filter((m) => m.to === token)).toHaveLength(0);
  });

  it("subscribes to the same channel the gateway does", () => {
    expect(GAME_EVENTS_CHANNEL).toBe("game:events");
  });
});
