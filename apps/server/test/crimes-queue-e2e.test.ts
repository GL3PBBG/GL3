import { GameEventSchema } from "@gl3/shared";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, isNotNull } from "drizzle-orm";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { loadConfig } from "../src/config.js";
import { crimes, outbox, playerStats } from "../src/db/schema/index.js";
import { seedCrimes } from "../src/db/seed.js";
import { createRedis, createSubscriber } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * The REAL end-to-end leg no other crimes test covers: the HTTP commit's
 * outbox job row delivered to the actual BullMQ queue, picked up by the
 * actual worker, and resolved as a crime.resolved push. Every other suite
 * drives the job through `runPluginJob` directly — which is exactly how the
 * outbox's queue-delivery leg could break while the whole suite stayed
 * green (the 2026-08-29 "accepted, timer, nothing happens" report).
 */
const { db, sql: conn } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);
const subscriber = createSubscriber(loadConfig(process.env).redisUrl);

let app: FastifyInstance;
let closeServer: () => Promise<void>;
let token: string;
let playerId: string;

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer } = await bootTestServer());
  await seedCrimes(db, "v2");
  ({ token, playerId } = await registerVerifiedPlayer({ app, redis }, { username: "E2ECrook", remoteAddress: "10.9.0.21" }));
});

afterAll(async () => { await closeServer(); await conn.end(); redis.disconnect(); subscriber.disconnect(); });

describe("crimes through the real queue", () => {
  it("a PRE-SEEDED FORMULA crime (gl3 seed set, brave-priced) resolves via the real worker", async () => {
    // The beforeEach seeded the v2 set; the gl3 eight are what the formula
    // copy runs, so start clean.
    await resetDb(db);
    await seedCrimes(db, "gl3");
    // resetDb took the beforeEach's player with it; re-register.
    ({ token, playerId } = await registerVerifiedPlayer({ app, redis }, { username: "E2ECrook2", remoteAddress: "10.9.0.22" }));
    // The eight gl3 seeds all carry formulas and brave costs; the v2 three
    // carry neither. The reported break: formula copy accepts + timer +
    // silence — this is that copy's exact crime.
    const [formulaCrime] = await db.select().from(crimes).where(isNotNull(crimes.successFormula));
    if (!formulaCrime) throw new Error("gl3 seed set has no formula crime");

    await subscriber.subscribe(GAME_EVENTS_CHANNEL);
    const seen: unknown[] = [];
    const onMessage = (channel: string, raw: string): void => {
      if (channel !== GAME_EVENTS_CHANNEL) return;
      const parsed = GameEventSchema.safeParse(JSON.parse(raw));
      if (parsed.success && parsed.data.actorId === playerId) seen.push(parsed.data);
    };
    subscriber.on("message", onMessage);

    const res = await app.inject({
      method: "POST", url: `/api/crimes/${formulaCrime.id}/commit`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(202);

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !seen.some((e) => (e as { type: string }).type === "crime.resolved")) {
      await new Promise((r) => setTimeout(r, 100));
    }
    subscriber.off("message", onMessage);

    const resolved = seen.find((e) => (e as { type: string }).type === "crime.resolved");
    expect(resolved).toBeDefined();
    expect(await db.select({ id: outbox.id }).from(outbox)).toEqual([]);
  });

  it("a committed crime resolves via the real BullMQ worker", async () => {
    await subscriber.subscribe(GAME_EVENTS_CHANNEL);
    const seen: unknown[] = [];
    const onMessage = (channel: string, raw: string): void => {
      if (channel !== GAME_EVENTS_CHANNEL) return;
      const parsed = GameEventSchema.safeParse(JSON.parse(raw));
      // Rule 4: this file's own freshly-minted actor only.
      if (parsed.success && parsed.data.actorId === playerId) seen.push(parsed.data);
    };
    subscriber.on("message", onMessage);

    const [pickpocket] = await db.select().from(crimes).where(eq(crimes.name, "Pickpocket"));
    if (!pickpocket) throw new Error("seed missing Pickpocket");
    // Some money so a payout ledger row is possible on success.
    await db.update(playerStats).set({ cash: 0n }).where(eq(playerStats.playerId, playerId));

    const res = await app.inject({
      method: "POST", url: `/api/crimes/${pickpocket.id}/commit`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(202);
    const { jobId } = res.json();
    expect(jobId).toBeTruthy();

    // The whole point: WAIT for the real worker. The outbox fast path
    // delivers within the request; the worker resolves in the hundreds of
    // milliseconds after. Generous timeout, one shot.
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !seen.some((e) => (e as { type: string }).type === "crime.resolved")) {
      await new Promise((r) => setTimeout(r, 100));
    }
    subscriber.off("message", onMessage);

    const resolved = seen.find((e) => (e as { type: string }).type === "crime.resolved") as
      | { type: string; success: boolean }
      | undefined;
    expect(resolved).toBeDefined();

    // And the outbox is empty: the job row was delivered and deleted.
    expect(await db.select({ id: outbox.id }).from(outbox)).toEqual([]);
  });
});
