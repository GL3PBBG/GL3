import { GameEventSchema, type GameEvent } from "@gl3/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { locations, playerStats, settings as settingsTable, transactions } from "../src/db/schema/index.js";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { deliverAndClear } from "../src/bus/outbox.js";
import { createSubscriber } from "../src/redis.js";
import { breakoutPercent } from "../src/game/jail/breakout.js";
import { bustSucceeds } from "../src/game/jail/bust.js";
import { escapeAttempt } from "../src/game/jail/attempts.js";
import { resetDb, testDb } from "./helpers/db.js";
import { awaitOwnEvent } from "./helpers/events.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
const redisUrl = loadConfig(process.env).redisUrl;
const subscriber = createSubscriber(redisUrl);
let app: FastifyInstance;
let closeServer: () => Promise<void>;
let appRedis: import("ioredis").Redis;
let townA: string;

interface Player { token: string; playerId: string; username: string }

async function registerOn(target: { app: FastifyInstance; redis: import("ioredis").Redis }, name: string): Promise<Player> {
  return registerVerifiedPlayer(target, {
    username: `${name}${Date.now()}${Math.floor(Math.random() * 1000)}`,
  });
}

/** First seed from a fixed enumeration with the wanted outcome — deterministic across runs. */
function seedWhere(percent: number, wanted: boolean): string {
  for (let i = 0; i < 10_000; i++) {
    const s = `jail-escape-seed-${i}`;
    if (bustSucceeds(s, percent) === wanted) return s;
  }
  throw new Error(`no seed found for ${percent}% → ${wanted}`);
}

async function place(p: Player, locationId: string | null, patch: Record<string, unknown> = {}): Promise<void> {
  await db.update(playerStats).set({ locationId, ...patch }).where(eq(playerStats.playerId, p.playerId));
}

async function bootWith(rows: Record<string, string>): Promise<Awaited<ReturnType<typeof bootTestServer>>> {
  await db.insert(settingsTable)
    .values(Object.entries(rows).map(([key, value]) => ({ key, value })));
  return bootTestServer();
}

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer, redis: appRedis } = await bootTestServer());
  townA = uuidv7();
  await db.insert(locations).values([{ id: townA, name: `Town A ${townA.slice(0, 8)}` }]);
});
afterAll(async () => {
  await closeServer();
  await conn.end();
  subscriber.disconnect();
});

const auth = (p: Player) => ({ authorization: `Bearer ${p.token}` });

describe("POST /api/jail/escape", () => {
  it("refuses a caller who is not jailed", async () => {
    const free = await registerOn({ app, redis: appRedis }, "Free");
    await place(free, townA);

    const res = await app.inject({ method: "POST", url: "/api/jail/escape", headers: auth(free) });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "not_jailed" });
  });

  // breakoutPercent is level-derived, not a boot-time setting, so the win
  // and lose branches can no longer be forced through the HTTP route (which
  // generates its own random seed via newSeed()). Each case here drives
  // escapeAttempt directly with a chosen seed for a deterministic outcome,
  // then delivers its outboxRows through the SAME deliverAndClear the route
  // itself calls, proving the event a subscriber would see. The exhaustive
  // branch/super-max matrix lives in jail-supermax.test.ts.
  it("frees the caller and publishes player.released when the roll wins", async () => {
    const escaper = await registerOn({ app, redis: appRedis }, "Escaper");
    await place(escaper, townA, { jailedUntil: new Date(Date.now() + 300_000), level: 1 });

    await subscriber.subscribe(GAME_EVENTS_CHANNEL);
    const waiting = awaitOwnEvent(subscriber, escaper.playerId);

    const percent = breakoutPercent(1, true, false);
    const result = await escapeAttempt(db, {}, escaper.playerId, seedWhere(percent, true));
    expect(result.kind).toBe("escaped");
    if (result.kind !== "escaped") throw new Error("expected escaped");
    await deliverAndClear(db, { redis: appRedis }, result.outboxRows);

    const event: GameEvent = GameEventSchema.parse(await waiting);
    expect(event).toMatchObject({ type: "player.released", actorId: escaper.playerId });

    const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, escaper.playerId));
    expect(row?.jailedUntil).toBeNull();

    // Escape is free on both branches — no money moves.
    const ledger = await db.select().from(transactions).where(eq(transactions.playerId, escaper.playerId));
    expect(ledger).toHaveLength(0);
  });

  it("extends the existing sentence by exactly the setting when the roll always loses", async () => {
    const own = await bootWith({ "jail.escape_fail_extra_seconds": "120" });
    try {
      const escaper = await registerOn(own, "Escaper");
      const before = new Date(Date.now() + 300_000);
      await db.update(playerStats).set({ locationId: townA, jailedUntil: before, level: 1 })
        .where(eq(playerStats.playerId, escaper.playerId));

      await subscriber.subscribe(GAME_EVENTS_CHANNEL);
      const waiting = awaitOwnEvent(subscriber, escaper.playerId);

      const percent = breakoutPercent(1, true, false);
      const result = await escapeAttempt(
        db, { "jail.escape_fail_extra_seconds": "120" }, escaper.playerId, seedWhere(percent, false),
      );
      expect(result.kind).toBe("failed");
      if (result.kind !== "failed") throw new Error("expected failed");
      await deliverAndClear(db, { redis: own.redis }, result.outboxRows);

      // V2 semantics: +extra on top of what was left, NOT a fresh sentence
      // from now — exact ms equality proves it extended rather than restarted.
      const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, escaper.playerId));
      expect(row?.jailedUntil?.getTime()).toBe(before.getTime() + 120_000);
      expect(result.until.getTime()).toBe(before.getTime() + 120_000);

      const event: GameEvent = GameEventSchema.parse(await waiting);
      expect(event).toMatchObject({
        type: "player.jailed", actorId: escaper.playerId, reason: "escape.failed",
      });

      const ledger = await db.select().from(transactions).where(eq(transactions.playerId, escaper.playerId));
      expect(ledger).toHaveLength(0);
    } finally {
      await own.close();
    }
  });
});
