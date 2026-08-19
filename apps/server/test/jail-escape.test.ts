import { GameEventSchema, type GameEvent } from "@gl3/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { locations, playerStats, settings as settingsTable, transactions } from "../src/db/schema/index.js";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { createSubscriber } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { awaitOwnEvent } from "./helpers/events.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
const redisUrl = loadConfig(process.env).redisUrl;
const subscriber = createSubscriber(redisUrl);
let app: FastifyInstance;
let closeServer: () => Promise<void>;
let townA: string;

interface Player { token: string; playerId: string; username: string }

/**
 * Same shape as jail-bail-bust.test.ts: `jail.bust_success_percent` is read
 * once at boot, so each branch boots its own app and registers players on it.
 */
async function registerOn(target: FastifyInstance, name: string): Promise<Player> {
  const res = await target.inject({
    method: "POST", url: "/api/auth/register",
    payload: { username: `${name}${Date.now()}${Math.floor(Math.random() * 1000)}`, password: "hunter2hunter2" },
  });
  const body = res.json();
  return { token: body.token, playerId: body.playerId, username: body.username };
}

async function place(p: Player, locationId: string | null, patch: Record<string, unknown> = {}): Promise<void> {
  await db.update(playerStats).set({ locationId, ...patch }).where(eq(playerStats.playerId, p.playerId));
}

async function bootWith(rows: Record<string, string>): Promise<{ app: FastifyInstance; close: () => Promise<void> }> {
  await db.insert(settingsTable)
    .values(Object.entries(rows).map(([key, value]) => ({ key, value })));
  return bootTestServer();
}

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer } = await bootTestServer());
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
    const free = await registerOn(app, "Free");
    await place(free, townA);

    const res = await app.inject({ method: "POST", url: "/api/jail/escape", headers: auth(free) });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "not_jailed" });
  });

  it("frees the caller and publishes player.released when the roll always wins", async () => {
    const own = await bootWith({ "jail.bust_success_percent": "100" });
    try {
      const escaper = await registerOn(own.app, "Escaper");
      await place(escaper, townA, { jailedUntil: new Date(Date.now() + 300_000) });

      await subscriber.subscribe(GAME_EVENTS_CHANNEL);
      const waiting = awaitOwnEvent(subscriber, escaper.playerId);

      const res = await own.app.inject({ method: "POST", url: "/api/jail/escape", headers: auth(escaper) });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ success: true, jailedUntil: null });

      const event: GameEvent = GameEventSchema.parse(await waiting);
      expect(event).toMatchObject({ type: "player.released", actorId: escaper.playerId });

      const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, escaper.playerId));
      expect(row?.jailedUntil).toBeNull();

      // Escape is free on both branches — no money moves.
      const ledger = await db.select().from(transactions).where(eq(transactions.playerId, escaper.playerId));
      expect(ledger).toHaveLength(0);
    } finally {
      await own.close();
    }
  });

  it("extends the existing sentence by exactly the setting when the roll always loses", async () => {
    const own = await bootWith({
      "jail.bust_success_percent": "0",
      "jail.escape_fail_extra_seconds": "120",
    });
    try {
      const escaper = await registerOn(own.app, "Escaper");
      const before = new Date(Date.now() + 300_000);
      await place(escaper, townA, { jailedUntil: before });

      await subscriber.subscribe(GAME_EVENTS_CHANNEL);
      const waiting = awaitOwnEvent(subscriber, escaper.playerId);

      const res = await own.app.inject({ method: "POST", url: "/api/jail/escape", headers: auth(escaper) });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(false);

      // V2 semantics: +extra on top of what was left, NOT a fresh sentence
      // from now — exact ms equality proves it extended rather than restarted.
      const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, escaper.playerId));
      expect(row?.jailedUntil?.getTime()).toBe(before.getTime() + 120_000);
      expect(body.jailedUntil).toBe(new Date(before.getTime() + 120_000).toISOString());

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
