import { GameEventSchema } from "@gl3/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { loadConfig } from "../src/config.js";
import { crimes, playerStats, transactions } from "../src/db/schema/index.js";
import { seedCrimes } from "../src/db/seed.js";
import { createSubscriber } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
const subscriber = createSubscriber(loadConfig(process.env).redisUrl);

let app: FastifyInstance;
let closeServer: () => Promise<void>;
let token: string;
let playerId: string;
let crimeId: string;
// Reassigned each beforeEach — a plain top-level const here would capture
// `token` as undefined at module-load time, before any test runs.
let auth: { authorization: string };

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer } = await bootTestServer());
  await seedCrimes(db);

  const reg = await app.inject({
    method: "POST", url: "/api/auth/register",
    // A distinct remoteAddress keeps this suite's register-rate-limit bucket
    // from colliding with every other agent's tests hitting the shared
    // Redis instance under the default 127.0.0.1 key (see task-9 report).
    remoteAddress: "10.9.0.9",
    payload: { username: "Vito", password: "hunter2hunter2" },
  });
  ({ token, playerId } = reg.json());
  auth = { authorization: `Bearer ${token}` };

  const [first] = await db.select().from(crimes).where(eq(crimes.name, "Pickpocket"));
  crimeId = first!.id;
});

afterAll(async () => { await closeServer(); await conn.end(); subscriber.disconnect(); });

// `game:events` is a global channel shared by every test file running in
// parallel (e.g. ws.test.ts also commits crimes on it) — a bare
// `once("message")` here would resolve on whichever file's event lands
// first and could grab someone else's crime.resolved. Keep listening until
// one actually names this test's own actor.
const waitForEvent = (expectedActorId: string): Promise<unknown> =>
  new Promise((resolve) => {
    const onMessage = (channel: string, raw: string): void => {
      if (channel !== GAME_EVENTS_CHANNEL) return;
      const parsed = GameEventSchema.safeParse(JSON.parse(raw));
      if (!parsed.success || parsed.data.actorId !== expectedActorId) return;
      subscriber.off("message", onMessage);
      resolve(parsed.data);
    };
    subscriber.on("message", onMessage);
  });

describe("GET /api/crimes", () => {
  it("lists crimes with this player's chance and cooldown", async () => {
    const res = await app.inject({ method: "GET", url: "/api/crimes", headers: auth });
    expect(res.statusCode).toBe(200);
    const { crimes: list } = res.json();
    expect(list).toHaveLength(3);
    expect(list[0].cooldownRemaining).toBe(0);
    expect(list[0].chance).toMatch(/^\d+\.\d{2}$/);
  });

  it("401s without a token", async () => {
    expect((await app.inject({ method: "GET", url: "/api/crimes" })).statusCode).toBe(401);
  });
});

describe("POST /api/crimes/:crimeId/commit", () => {
  it("accepts exactly one of two concurrent commits", async () => {
    const [a, b] = await Promise.all([
      app.inject({ method: "POST", url: `/api/crimes/${crimeId}/commit`, headers: { authorization: `Bearer ${token}` } }),
      app.inject({ method: "POST", url: `/api/crimes/${crimeId}/commit`, headers: { authorization: `Bearer ${token}` } }),
    ]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([202, 429]);
  });

  it("400s for a malformed crime id instead of reaching postgres", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/crimes/not-a-uuid/commit", headers: auth,
    });
    expect(res.statusCode).toBe(400);
    // The malformed id must not have burned the cooldown either.
    const ok = await app.inject({ method: "POST", url: `/api/crimes/${crimeId}/commit`, headers: auth });
    expect(ok.statusCode).toBe(202);
  });

  it("404s for an unknown crime and does not burn the cooldown", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/crimes/018f8e2a-0000-7000-8000-0000000000ff/commit", headers: auth,
    });
    expect(res.statusCode).toBe(404);
    const ok = await app.inject({ method: "POST", url: `/api/crimes/${crimeId}/commit`, headers: auth });
    expect(ok.statusCode).toBe(202);
  });

  it("resolves in a worker, ledgers the payout, and publishes crime.resolved", async () => {
    await subscriber.subscribe(GAME_EVENTS_CHANNEL);
    const received = waitForEvent(playerId);

    const res = await app.inject({ method: "POST", url: `/api/crimes/${crimeId}/commit`, headers: auth });
    expect(res.statusCode).toBe(202);

    const event = GameEventSchema.parse(await received);
    expect(event.type).toBe("crime.resolved");
    if (event.type !== "crime.resolved") throw new Error("unreachable");
    expect(event.actorId).toBe(playerId);
    expect(event.actorName).toBe("Vito");
    expect(event.crimeName).toBe("Pickpocket");

    const [stats] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
    if (event.success) {
      expect(stats?.cash).toBe(BigInt(event.payout));
      const ledger = await db.select().from(transactions);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]?.reason).toBe("crime.payout");
    } else {
      expect(stats?.cash).toBe(0n);
      expect(await db.select().from(transactions)).toHaveLength(0);
    }
  });
});
