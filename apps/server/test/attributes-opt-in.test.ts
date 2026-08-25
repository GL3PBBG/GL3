import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import crimesPlugin from "@gl3/plugin-crimes";
import { definePlugin, on, coreActionCost, type PluginManifest } from "@gl3/plugin-sdk";
import { loadConfig } from "../src/config.js";
import { crimes, playerStats } from "../src/db/schema/index.js";
import { seedCrimes } from "../src/db/seed.js";
import { runPluginJob } from "../src/plugins/jobs.js";
import { createRedis } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);
const jobDeps = () => ({ db, redis, queues: new Map(), settings: {}, leaderboardPrefix: "crimes-cost-test" });

afterAll(async () => { await conn.end(); redis.disconnect(); });

/**
 * Subscribes `crimes.commit` to a flat 4-energy cost, and nothing else — a
 * `costapply`-shaped driver (task-5-report.md), not a real gameplay plugin,
 * since Task 6 only wires crimes and no real attribute plugin exists yet.
 * No `providesAttributes` here deliberately: this plugin prices the action,
 * it does not own the pool (a separate concern — the loader rejects two
 * declarers of the same pool).
 */
const pricesCrimesEnergy: PluginManifest = definePlugin({
  id: "crimeenergycost",
  version: "1.0.0",
  basePaths: ["/api/crimeenergycost"],
  filters: [on(coreActionCost, (_ctx, value) => (
    value.action === "crimes.commit" ? { ...value, costs: { ...value.costs, energy: 4 } } : value
  ))],
});

describe("crimes.commit — opt-out baseline (no attribute plugin installed)", () => {
  let app: FastifyInstance;
  let closeServer: () => Promise<void>;
  let crimeId: string;

  beforeEach(async () => {
    await resetDb(db);
    if (!app) ({ app, close: closeServer } = await bootTestServer());
    await seedCrimes(db);
    const [crime] = await db.select().from(crimes).where(eq(crimes.name, "Pickpocket"));
    crimeId = crime!.id;
  });
  afterAll(async () => { await closeServer(); });

  it("leaves every energy column untouched on a normal commit", async () => {
    const { token, playerId } = await registerVerifiedPlayer({ app, redis }, { remoteAddress: "10.9.1.1" });
    const res = await app.inject({
      method: "POST", url: `/api/crimes/${crimeId}/commit`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(202);

    const [stats] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(stats?.energy).toBe(0);
    expect(stats?.energyMax).toBe(0);
    expect(stats?.energyRegenAt).toBeNull();
  });
});

describe("crimes.commit — priced (an attribute-cost plugin is installed)", () => {
  let app: FastifyInstance;
  let closeServer: () => Promise<void>;
  let crimeId: string;

  beforeEach(async () => {
    await resetDb(db);
    if (!app) ({ app, close: closeServer } = await bootTestServer({ plugins: [pricesCrimesEnergy] }));
    await seedCrimes(db);
    const [crime] = await db.select().from(crimes).where(eq(crimes.name, "Pickpocket"));
    crimeId = crime!.id;
  });
  afterAll(async () => { await closeServer(); });

  it("409s a broke player before the cooldown burns, and enqueues nothing", async () => {
    // A freshly registered player has energy=0 (migration 0016's column
    // default) — insufficient for any positive cost with no grant.
    const { token } = await registerVerifiedPlayer({ app, redis }, { remoteAddress: "10.9.1.2" });
    const auth = { authorization: `Bearer ${token}` };

    const res = await app.inject({ method: "POST", url: `/api/crimes/${crimeId}/commit`, headers: auth });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("insufficient_energy");

    // Cooldown must not have burned — a second attempt still reaches the
    // (still insufficient) funds check rather than 429ing.
    const again = await app.inject({ method: "POST", url: `/api/crimes/${crimeId}/commit`, headers: auth });
    expect(again.statusCode).toBe(409);
  });

  it("spends the priced amount in the job, once, alongside the payout", async () => {
    const { playerId } = await registerVerifiedPlayer({ app, redis }, { remoteAddress: "10.9.1.3" });
    // Grant energy directly — the route's pre-check settles the pool
    // through the FULL registry (routes.ts's collectAttributePools(manifests)),
    // but no plugin in this suite declares `providesAttributes`, so there is
    // no regen decl to seed a max from. Setting the row directly is the
    // simplest way to give this player something to spend, independent of
    // that seeding question.
    await db.update(playerStats).set({ energy: 10, energyMax: 10 }).where(eq(playerStats.playerId, playerId));

    await runPluginJob(jobDeps(), crimesPlugin, "commit", {
      id: "cost-spend-job", data: { playerId, crimeId, seed: "cost-spend-seed", costs: { energy: 4 } },
    });

    const [stats] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(stats?.energy).toBe(6);
  });

  it("does not double-spend on an idempotent replay of the same job id", async () => {
    const { playerId } = await registerVerifiedPlayer({ app, redis }, { remoteAddress: "10.9.1.4" });
    await db.update(playerStats).set({ energy: 10, energyMax: 10 }).where(eq(playerStats.playerId, playerId));

    const job = { id: "cost-replay-job", data: { playerId, crimeId, seed: "cost-replay-seed", costs: { energy: 4 } } };
    await runPluginJob(jobDeps(), crimesPlugin, "commit", job);
    await runPluginJob(jobDeps(), crimesPlugin, "commit", job);

    const [stats] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(stats?.energy).toBe(6);
  });
});

/**
 * The guard mechanism itself, isolated from the job-context registry
 * narrowing that makes it unobservable against the real `crimesPlugin`
 * (which owns no pool). `commitJob`'s own `options.attributePools` is built
 * as `collectAttributePools([manifest])` — the SINGLE manifest passed to
 * `runPluginJob` — so a pool declared by a *different*, separately-loaded
 * plugin is invisible inside crimes' job no matter what the guard does
 * (apps/server/src/plugins/jobs.ts). To observe what the guard prevents, the
 * declaration has to live on the same manifest object the job runs under —
 * hence the spread here. `manifest.jobs.commit` still resolves to the real,
 * unmodified `commitJob` function; only the manifest's `providesAttributes`
 * field is augmented, for this file only.
 */
const crimesWithEnergyPool: PluginManifest = {
  ...crimesPlugin,
  providesAttributes: [{ pool: "energy", defaultMax: 20, regenAmount: 5, regenIntervalSeconds: 60 }],
};

describe("crimes.commit job — the priced.length > 0 guard", () => {
  let app: FastifyInstance;
  let closeServer: () => Promise<void>;
  let crimeId: string;

  beforeEach(async () => {
    await resetDb(db);
    if (!app) ({ app, close: closeServer } = await bootTestServer());
    await seedCrimes(db);
    const [crime] = await db.select().from(crimes).where(eq(crimes.name, "Pickpocket"));
    crimeId = crime!.id;
  });
  afterAll(async () => { await closeServer(); });

  it("an unpriced commit leaves energy_regen_at untouched, even when a pool is declared", async () => {
    // No coreActionCost subscriber anywhere in this describe block, so a
    // real commit route would resolve `costs: {}` — the job data below
    // carries no `costs`, matching exactly what an unpriced commit enqueues.
    const { playerId } = await registerVerifiedPlayer({ app, redis }, { remoteAddress: "10.9.1.5" });

    await runPluginJob(jobDeps(), crimesWithEnergyPool, "commit", {
      id: "guard-proof-job", data: { playerId, crimeId, seed: "guard-proof-seed" },
    });

    const [stats] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
    // This is the assertion the mandatory red-first proof flips: remove the
    // `priced.length > 0` guard in commitJob and this goes non-null, because
    // the lock+settle then runs unconditionally against a manifest that DOES
    // declare a pool.
    expect(stats?.energyRegenAt).toBeNull();
  });
});
