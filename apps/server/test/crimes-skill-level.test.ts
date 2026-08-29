import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { crimes, locations, playerCrimeSkill, playerStats } from "../src/db/schema/index.js";
import { seedCrimes, seedLocations } from "../src/db/seed.js";
import { runPluginJob } from "../src/plugins/jobs.js";
import crimesPlugin from "@gl3/plugin-crimes";
import { createRng } from "../src/game/rng.js";
import { createRedis } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

// The parity cluster's runtime proofs: V2's skill progression-by-use (read
// from crimes.inc: +1..4 success / +1..2 clean failure / +0 jailed, cap 100),
// the SKILL hybrid token, and the level gates on crimes and towns. All ride
// real Postgres and the real commit job, no mocks.
const { db, sql: conn } = testDb();
const redis = createRedis((await import("../src/config.js")).loadConfig(process.env).redisUrl);
const jobDeps = () => ({ db, redis, queues: new Map(), settings: {}, leaderboardPrefix: "skill-test" });

let app: FastifyInstance;
let closeServer: () => Promise<void>;
let token: string;
let playerId: string;
let auth: { authorization: string };

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer } = await bootTestServer());
  await seedCrimes(db, "v2");
  await seedLocations(db);
  ({ token, playerId } = await registerVerifiedPlayer({ app, redis }, { username: "Clem", remoteAddress: "10.9.0.11" }));
  auth = { authorization: `Bearer ${token}` };
});

afterAll(async () => { await closeServer(); await conn.end(); redis.disconnect(); });

async function crimeByName(name: string): Promise<typeof crimes.$inferSelect> {
  const [row] = await db.select().from(crimes).where(eq(crimes.name, name));
  if (!row) throw new Error(`seed missing crime ${name}`);
  return row;
}

/** Brute-forces a seed whose roll produces the wanted outcome — the
 *  crimes.test.ts pattern. The growth draws run AFTER these draws, so the
 *  outcome a seed produces here is the outcome the job sees. */
async function seedFor(chancePercent: number, wantSuccess: boolean): Promise<string> {
  for (let i = 0; i < 500; i += 1) {
    const candidate = `skill-search-${wantSuccess ? "s" : "f"}-${chancePercent}-${i}`;
    const rng = createRng(candidate);
    const success = rng.int(0, 10_000) < Math.round(chancePercent * 100);
    if (success === wantSuccess) return candidate;
  }
  throw new Error("no seed found");
}

async function commit(crimeId: string, seed: string, jobId: string): Promise<void> {
  await runPluginJob(jobDeps(), crimesPlugin, "commit", { id: jobId, data: { playerId, crimeId, seed } });
}

async function skillChance(crimeId: string): Promise<number | null> {
  const [row] = await db.select().from(playerCrimeSkill)
    .where(and(eq(playerCrimeSkill.playerId, playerId), eq(playerCrimeSkill.crimeId, crimeId)));
  return row ? Number(row.chance) : null;
}

describe("skill progression by use (V2 crimes.inc)", () => {
  it("grows +1..4 on a success, seeding from the 35% default", async () => {
    const pickpocket = await crimeByName("Pickpocket"); // jailChance 0, formula NULL
    await commit(pickpocket.id, await seedFor(35, true), "skill-grow-success");

    const chance = await skillChance(pickpocket.id);
    // No row before -> the default 35 underlies the roll, and the first
    // success writes 35 + 1..4.
    expect(chance).not.toBeNull();
    expect(chance!).toBeGreaterThanOrEqual(36);
    expect(chance!).toBeLessThanOrEqual(39);
  });

  it("grows +1..2 on a clean failure and +0 when jailed", async () => {
    const pickpocket = await crimeByName("Pickpocket"); // jailChance 0
    await commit(pickpocket.id, await seedFor(35, false), "skill-grow-cleanfail");
    const afterClean = await skillChance(pickpocket.id);
    expect(afterClean).toBeGreaterThanOrEqual(36);
    expect(afterClean!).toBeLessThanOrEqual(37);

    const van = await crimeByName("Armoured Van"); // jailChance 40
    // A seed that fails AND rolls under the jail chance — the crimes.test
    // brute-force shape, now for the growth assertion.
    let jailedSeed = "";
    for (let i = 0; i < 500; i += 1) {
      const candidate = `skill-jailed-${i}`;
      const rng = createRng(candidate);
      if (rng.int(0, 10_000) >= Math.round(35 * 100)) {
        if (rng.int(0, 100) < van.jailChancePercent) { jailedSeed = candidate; break; }
      }
    }
    expect(jailedSeed).not.toBe("");
    await commit(van.id, jailedSeed, "skill-grow-jailed");

    // V2's rule: getting caught teaches nothing. No row was ever written
    // for this crime, and the default still underlies the next attempt.
    expect(await skillChance(van.id)).toBeNull();
  });

  it("caps the stored chance at 100", async () => {
    const pickpocket = await crimeByName("Pickpocket");
    await db.insert(playerCrimeSkill).values({ playerId, crimeId: pickpocket.id, chance: "99.00" });
    await commit(pickpocket.id, await seedFor(99, true), "skill-cap");

    expect(await skillChance(pickpocket.id)).toBe(100);
  });

  it("never grows for a formula crime that does not use SKILL", async () => {
    const crimeId = uuidv7();
    await db.insert(crimes).values({
      id: crimeId, name: "Stats only", description: "",
      cooldownSeconds: 10, minPayout: 10n, maxPayout: 20n, minBullets: 0, maxBullets: 0,
      expReward: 1n, jailChancePercent: 0, jailSeconds: 0, minLevel: 0, sort: 99,
      successFormula: "50",
    });
    await commit(crimeId, "any-seed", "skill-no-grow");

    expect(await skillChance(crimeId)).toBeNull();
  });

  it("grows and evaluates for a SKILL-hybrid formula", async () => {
    const crimeId = uuidv7();
    await db.insert(crimes).values({
      id: crimeId, name: "Hybrid", description: "",
      cooldownSeconds: 10, minPayout: 10n, maxPayout: 20n, minBullets: 0, maxBullets: 0,
      expReward: 1n, jailChancePercent: 0, jailSeconds: 0, minLevel: 0, sort: 99,
      // The hybrid shape: the learned chance feeds a stat formula. SKILL 50
      // + half a level-1 player's level: 50.5% underlying the roll.
      successFormula: "SKILL + LEVEL / 2",
    });
    await db.insert(playerCrimeSkill).values({ playerId, crimeId, chance: "50.00" });

    await commit(crimeId, await seedFor(50.5, true), "skill-hybrid-success");

    // The formula consumed the skill AND the growth applied: 50 + 1..4.
    const chance = await skillChance(crimeId);
    expect(chance).toBeGreaterThanOrEqual(51);
    expect(chance!).toBeLessThanOrEqual(54);
  });
});

describe("crime level gate", () => {
  it("hides over-level crimes from the list and refuses the commit before the cooldown burns", async () => {
    const lockedId = uuidv7();
    await db.insert(crimes).values({
      id: lockedId, name: "Bank Job", description: "",
      cooldownSeconds: 30, minPayout: 100n, maxPayout: 500n, minBullets: 0, maxBullets: 0,
      expReward: 5n, jailChancePercent: 0, jailSeconds: 0, minLevel: 5, sort: 99,
    });

    const list = await app.inject({ method: "GET", url: "/api/crimes", headers: auth });
    expect(list.statusCode).toBe(200);
    expect(list.json().crimes.map((c: { name: string }) => c.name)).not.toContain("Bank Job");

    // A crafted under-level attempt: refused, and costs nothing — no cooldown.
    const attempt = await app.inject({
      method: "POST", url: `/api/crimes/${lockedId}/commit`, headers: auth,
    });
    expect(attempt.statusCode).toBe(409);
    expect(attempt.json().error).toBe("insufficient_level");
    const peek = await redis.send_command("TTL", `cooldown:crime:${playerId}`);
    expect(peek).toBe(-2); // key does not exist

    // At the gate's level the crime appears.
    await db.update(playerStats).set({ level: 5 }).where(eq(playerStats.playerId, playerId));
    const listAfter = await app.inject({ method: "GET", url: "/api/crimes", headers: auth });
    expect(listAfter.json().crimes.map((c: { name: string }) => c.name)).toContain("Bank Job");
  });
});

describe("town level gate", () => {
  it("refuses under-level travel before the cooldown and the fare, and lists the lock", async () => {
    const [lockedTown] = await db.select().from(locations).where(eq(locations.name, "Chicago"));
    if (!lockedTown) throw new Error("seed missing Chicago");
    await db.update(locations).set({ minLevel: 5 }).where(eq(locations.id, lockedTown.id));

    const list = await app.inject({ method: "GET", url: "/api/locations", headers: auth });
    expect(list.statusCode).toBe(200);
    const listed = list.json().locations.find((l: { id: string }) => l.id === lockedTown.id);
    expect(listed.minLevel).toBe(5);

    const [before] = await db.select({ cash: playerStats.cash }).from(playerStats)
      .where(eq(playerStats.playerId, playerId));
    const travel = await app.inject({
      method: "POST", url: `/api/travel/${lockedTown.id}`, headers: auth,
    });
    expect(travel.statusCode).toBe(409);
    expect(travel.json().error).toBe("insufficient_level");
    const [after] = await db.select({ cash: playerStats.cash }).from(playerStats)
      .where(eq(playerStats.playerId, playerId));
    expect(after?.cash).toBe(before?.cash);
    const peek = await redis.send_command("TTL", `cooldown:travel:${playerId}`);
    expect(peek).toBe(-2);

    // At the gate's level the same travel goes through — fund the fare too,
    // so the success leg proves the gate and not the player's wallet.
    await db.update(playerStats).set({ level: 5, cash: 10_000n })
      .where(eq(playerStats.playerId, playerId));
    const ok = await app.inject({ method: "POST", url: `/api/travel/${lockedTown.id}`, headers: auth });
    expect(ok.statusCode).toBe(200);
  });
});
