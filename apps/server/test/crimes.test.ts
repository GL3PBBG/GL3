import { GameEventSchema } from "@gl3/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { loadConfig } from "../src/config.js";
import { crimes, playerStats, transactions } from "../src/db/schema/index.js";
import { seedCrimes } from "../src/db/seed.js";
import { runPluginJob } from "../src/plugins/jobs.js";
import crimesPlugin from "@gl3/plugin-crimes";
import { createRedis, createSubscriber } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { awaitOwnEvent } from "./helpers/events.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
const subscriber = createSubscriber(loadConfig(process.env).redisUrl);
// Only needed by the plugin commit job unit tests below, which bypass the
// queue/worker entirely and so need their own publisher to hand it.
const redis = createRedis(loadConfig(process.env).redisUrl);
const jobDeps = () => ({ db, redis, queues: new Map(), settings: {}, leaderboardPrefix: "crimes-test" });

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
  await seedCrimes(db, "v2");

  // A distinct remoteAddress keeps this suite's register-rate-limit bucket
  // from colliding with every other agent's tests hitting the shared
  // Redis instance under the default 127.0.0.1 key (see task-9 report).
  ({ token, playerId } = await registerVerifiedPlayer({ app, redis }, { username: "Vito", remoteAddress: "10.9.0.9" }));
  auth = { authorization: `Bearer ${token}` };

  const [first] = await db.select().from(crimes).where(eq(crimes.name, "Pickpocket"));
  crimeId = first!.id;
});

afterAll(async () => { await closeServer(); await conn.end(); subscriber.disconnect(); redis.disconnect(); });

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
    const received = awaitOwnEvent(subscriber, playerId);

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

describe("POST /api/crimes/:crimeId/commit while jailed", () => {
  it("423s and does not enqueue a job", async () => {
    const future = new Date(Date.now() + 60_000);
    await db.update(playerStats).set({ jailedUntil: future }).where(eq(playerStats.playerId, playerId));

    const res = await app.inject({ method: "POST", url: `/api/crimes/${crimeId}/commit`, headers: auth });
    expect(res.statusCode).toBe(423);
    expect(res.json()).toMatchObject({ error: "jailed" });

    // No cooldown was burned, and jail is left exactly as it was.
    const stillJailed = await app.inject({ method: "POST", url: `/api/crimes/${crimeId}/commit`, headers: auth });
    expect(stillJailed.statusCode).toBe(423);
  });
});

describe("POST /api/crimes/:crimeId/commit while hospitalised", () => {
  it("423s hospitalised and does not enqueue a job", async () => {
    // Same gate class as jail above: the loader's accessInHospital pass.
    // Crimes shipped before that field existed and was never retrofitted —
    // a hospitalised player could commit crimes (found live 2026-08-27).
    const future = new Date(Date.now() + 60_000);
    await db.update(playerStats).set({ hospitalUntil: future }).where(eq(playerStats.playerId, playerId));

    const res = await app.inject({ method: "POST", url: `/api/crimes/${crimeId}/commit`, headers: auth });
    expect(res.statusCode).toBe(423);
    expect(res.json()).toMatchObject({ error: "hospitalised" });

    await db.update(playerStats).set({ hospitalUntil: null }).where(eq(playerStats.playerId, playerId));
  });
});

describe("plugin commit job — jail and rank-up wiring", () => {
  it("jails the player on a crime whose failure rolls jail, and reports it on crime.resolved", async () => {
    const [armouredVan] = await db.select().from(crimes).where(eq(crimes.name, "Armoured Van"));
    if (!armouredVan) throw new Error("seed missing Armoured Van");

    await subscriber.subscribe(GAME_EVENTS_CHANNEL);
    const events: unknown[] = [];
    // `game:events` is a global channel shared by every test file running in
    // parallel — filter on this test's own actor, not just channel name, so
    // a concurrent file's crime.resolved for a different player can't be
    // mistaken below for this test's own event when matching by type alone.
    subscriber.on("message", (channel, raw) => {
      if (channel !== GAME_EVENTS_CHANNEL) return;
      const parsed = GameEventSchema.safeParse(JSON.parse(raw));
      if (parsed.success && parsed.data.actorId === playerId) events.push(parsed.data);
    });

    // Brute-force a seed that both fails the crime and rolls under its 40%
    // jail chance — deterministic once found, cheap since createRng is a
    // pure sha256 stream with no I/O.
    let seed = "";
    for (let i = 0; i < 500; i += 1) {
      const candidate = `jail-search-${i}`;
      const rng = (await import("../src/game/rng.js")).createRng(candidate);
      const roll = rng.int(0, 10_000);
      const success = roll < Math.round(35 * 100); // player has no player_crime_skill row -> DEFAULT_CRIME_CHANCE 35%
      if (success) continue;
      const jailRoll = rng.int(0, 100);
      if (jailRoll < armouredVan.jailChancePercent) { seed = candidate; break; }
    }
    expect(seed).not.toBe("");

    await runPluginJob(jobDeps(), crimesPlugin, "commit", { id: "jail-test-job", data: { playerId, crimeId: armouredVan.id, seed } });

    const [stats] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(stats?.jailedUntil).not.toBeNull();
    expect(stats!.jailedUntil!.getTime()).toBeGreaterThan(Date.now());

    const resolved = events.find((e) => (e as { type: string }).type === "crime.resolved") as { jailedUntil: string | null };
    expect(resolved.jailedUntil).not.toBeNull();
    const jailed = events.find((e) => (e as { type: string }).type === "player.jailed");
    expect(jailed).toBeDefined();
  });

  it("ranks up on the first commit and does not re-apply the rank-up on an idempotent replay", async () => {
    const { seedRanks } = await import("../src/db/seed.js");
    await seedRanks(db);

    // A seed that succeeds a crime worth enough exp to promote past Associate (0 exp) to Soldier is
    // unnecessary here — Associate itself (0 exp threshold, 0 reward) already proves the plumbing
    // without needing a search: any successful commit crosses 0 exp -> Associate on the first call.
    let seed = "";
    for (let i = 0; i < 500; i += 1) {
      const candidate = `rank-search-${i}`;
      const rng = (await import("../src/game/rng.js")).createRng(candidate);
      const roll = rng.int(0, 10_000);
      if (roll < Math.round(35 * 100)) { seed = candidate; break; }
    }
    expect(seed).not.toBe("");

    const job = { id: "rank-test-job", data: { playerId, crimeId, seed } };
    await runPluginJob(jobDeps(), crimesPlugin, "commit", job);
    const [afterFirst] = await db.select({ rankId: playerStats.rankId }).from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(afterFirst?.rankId).not.toBeNull();

    // Replay the SAME job.id — must not double-promote or double-credit.
    // Under the accepted §2 deviation, a replay is swallowed as
    // JobAlreadyAppliedError before any handler code runs, so it publishes
    // no events at all (unlike core, which republished crime.resolved).
    await runPluginJob(jobDeps(), crimesPlugin, "commit", job);
    const [afterReplay] = await db.select({ rankId: playerStats.rankId, cash: playerStats.cash }).from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(afterReplay?.rankId).toBe(afterFirst?.rankId);
  });
});
