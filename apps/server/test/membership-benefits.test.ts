import membershipPlugin from "@gl3/plugin-membership";
import type { FastifyInstance } from "fastify";
import type { Redis as IORedis } from "ioredis";
import { eq, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import theftPlugin from "@gl3/plugin-theft";
import { crimes, locations, playerStats } from "../src/db/schema/index.js";
import { runPluginMigrations } from "../src/plugins/migrate.js";
import { resetDb, testDb } from "./helpers/db.js";
import { theftTiers } from "./helpers/plugin-tables.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();

/**
 * Grants a live membership timer directly, bypassing the buy route. Shared
 * by Tasks 8-9, which extend this file with their own membership-consumer
 * tests.
 */
export async function grantMembership(playerId: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO player_timers (player_id, key, expires_at)
    VALUES (${playerId}, 'membership', now() + interval '1 day')`);
}

let app: FastifyInstance;
let redis: IORedis;
let closeServer: () => Promise<void>;

beforeEach(async () => {
  await resetDb(db);
  if (!app) {
    await runPluginMigrations(db, [membershipPlugin, theftPlugin]);
    ({ app, close: closeServer, redis } = await bootTestServer());
  }
});

afterAll(async () => {
  await closeServer?.();
  await conn.end();
});

async function seedCrime(cooldownSeconds: number): Promise<string> {
  const id = uuidv7();
  await db.insert(crimes).values({
    id,
    name: "Getaway Test",
    description: "A crime seeded to test the Getaway Driver benefit.",
    cooldownSeconds,
    minPayout: 50n,
    maxPayout: 250n,
    minBullets: 0,
    maxBullets: 0,
    expReward: 5n,
    minRank: 0,
    sort: 10,
    jailChancePercent: 0,
    jailSeconds: 0,
  });
  return id;
}

interface CrimeRow { id: string; cooldownSeconds: number; cooldownRemaining: number }

describe("crimes membership benefit — Getaway Driver", () => {
  it("member sees a 25%-discounted cooldownSeconds; non-member sees the base cooldown", async () => {
    const crimeId = await seedCrime(100);
    const member = await registerVerifiedPlayer({ app, redis });
    const nonMember = await registerVerifiedPlayer({ app, redis });
    await grantMembership(member.playerId);

    const memberRes = await app.inject({
      method: "GET", url: "/api/crimes",
      headers: { authorization: `Bearer ${member.token}` },
    });
    expect(memberRes.statusCode).toBe(200);
    const memberCrime = memberRes.json<{ crimes: CrimeRow[] }>().crimes.find((c) => c.id === crimeId);
    expect(memberCrime?.cooldownSeconds).toBe(75);

    const nonMemberRes = await app.inject({
      method: "GET", url: "/api/crimes",
      headers: { authorization: `Bearer ${nonMember.token}` },
    });
    expect(nonMemberRes.statusCode).toBe(200);
    const nonMemberCrime = nonMemberRes.json<{ crimes: CrimeRow[] }>().crimes.find((c) => c.id === crimeId);
    expect(nonMemberCrime?.cooldownSeconds).toBe(100);
  });

  it("member's commit burns the discounted TTL, not the base one", async () => {
    const crimeId = await seedCrime(100);
    const member = await registerVerifiedPlayer({ app, redis });
    await grantMembership(member.playerId);
    const auth = { authorization: `Bearer ${member.token}` };

    const commit = await app.inject({ method: "POST", url: `/api/crimes/${crimeId}/commit`, headers: auth });
    expect(commit.statusCode).toBe(202);

    const res = await app.inject({ method: "GET", url: "/api/crimes", headers: auth });
    const remaining = res.json<{ crimes: CrimeRow[] }>().crimes.find((c) => c.id === crimeId)?.cooldownRemaining ?? 0;
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(75);
  });

  it("GET /api/membership/benefits lists Getaway Driver", async () => {
    const player = await registerVerifiedPlayer({ app, redis });
    const res = await app.inject({
      method: "GET", url: "/api/membership/benefits",
      headers: { authorization: `Bearer ${player.token}` },
    });
    expect(res.statusCode).toBe(200);
    const titles = res.json<{ rows: Array<{ title: string }> }>().rows.map((r) => r.title);
    expect(titles).toContain("Getaway Driver");
  });
});

async function seedTown(travelCost: bigint, travelCooldownSeconds = 60): Promise<string> {
  const id = uuidv7();
  await db.insert(locations).values({
    id, name: `Town ${id.slice(0, 8)}`,
    travelCost, travelCooldownSeconds,
    bulletStock: 0, bulletCost: 0n,
  });
  return id;
}

async function fundPlayer(playerId: string, cash: bigint): Promise<void> {
  await db.update(playerStats).set({ cash }).where(eq(playerStats.playerId, playerId));
}

interface LocationRow { id: string; travelCost: string }

describe("travel membership benefit — Frequent Flyer Discount", () => {
  it("member sees a 75%-discounted travelCost in the listing; non-member sees the full fare", async () => {
    const destinationId = await seedTown(1000n);
    const member = await registerVerifiedPlayer({ app, redis });
    const nonMember = await registerVerifiedPlayer({ app, redis });
    await grantMembership(member.playerId);

    const memberRes = await app.inject({
      method: "GET", url: "/api/locations",
      headers: { authorization: `Bearer ${member.token}` },
    });
    expect(memberRes.statusCode).toBe(200);
    const memberLocation = memberRes.json<{ locations: LocationRow[] }>().locations
      .find((l) => l.id === destinationId);
    expect(memberLocation?.travelCost).toBe("250");

    const nonMemberRes = await app.inject({
      method: "GET", url: "/api/locations",
      headers: { authorization: `Bearer ${nonMember.token}` },
    });
    expect(nonMemberRes.statusCode).toBe(200);
    const nonMemberLocation = nonMemberRes.json<{ locations: LocationRow[] }>().locations
      .find((l) => l.id === destinationId);
    expect(nonMemberLocation?.travelCost).toBe("1000");
  });

  it("member travelling pays exactly the discounted fare", async () => {
    const destinationId = await seedTown(1000n);
    const member = await registerVerifiedPlayer({ app, redis });
    await grantMembership(member.playerId);
    await fundPlayer(member.playerId, 10_000n);

    const res = await app.inject({
      method: "POST", url: `/api/travel/${destinationId}`,
      headers: { authorization: `Bearer ${member.token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ cash: string }>().cash).toBe("9750");

    const [row] = await db.select({ cash: playerStats.cash }).from(playerStats)
      .where(eq(playerStats.playerId, member.playerId));
    expect(row?.cash).toBe(9750n);
  });

  it("odd fare rounds up: cost 999 -> member pays 250 (ceil(999/4))", async () => {
    const destinationId = await seedTown(999n);
    const member = await registerVerifiedPlayer({ app, redis });
    await grantMembership(member.playerId);
    await fundPlayer(member.playerId, 10_000n);

    const res = await app.inject({
      method: "POST", url: `/api/travel/${destinationId}`,
      headers: { authorization: `Bearer ${member.token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ cash: string }>().cash).toBe("9750");
  });

  it("GET /api/membership/benefits lists Frequent Flyer Discount", async () => {
    const player = await registerVerifiedPlayer({ app, redis });
    const res = await app.inject({
      method: "GET", url: "/api/membership/benefits",
      headers: { authorization: `Bearer ${player.token}` },
    });
    expect(res.statusCode).toBe(200);
    const titles = res.json<{ rows: Array<{ title: string }> }>().rows.map((r) => r.title);
    expect(titles).toContain("Frequent Flyer Discount");
  });
});

async function seedTier(successChance: number): Promise<string> {
  const id = uuidv7();
  await db.insert(theftTiers).values({
    id, name: `Tier ${id.slice(0, 8)}`,
    successChance, maxDamage: 20,
    minCarValue: 0n, maxCarValue: 100_000n,
  });
  return id;
}

interface TierRow { id: string; successChance: string }

describe("theft membership benefit — Slide Hammer", () => {
  it("member sees a 10%-boosted successChance in the listing; non-member sees the base chance", async () => {
    const tierId = await seedTier(50);
    const member = await registerVerifiedPlayer({ app, redis });
    const nonMember = await registerVerifiedPlayer({ app, redis });
    await grantMembership(member.playerId);

    const memberRes = await app.inject({
      method: "GET", url: "/api/theft/tiers",
      headers: { authorization: `Bearer ${member.token}` },
    });
    expect(memberRes.statusCode).toBe(200);
    const memberTier = memberRes.json<{ rows: TierRow[] }>().rows.find((r) => r.id === tierId);
    expect(memberTier?.successChance).toBe("55");

    const nonMemberRes = await app.inject({
      method: "GET", url: "/api/theft/tiers",
      headers: { authorization: `Bearer ${nonMember.token}` },
    });
    expect(nonMemberRes.statusCode).toBe(200);
    const nonMemberTier = nonMemberRes.json<{ rows: TierRow[] }>().rows.find((r) => r.id === tierId);
    expect(nonMemberTier?.successChance).toBe("50");
  });

  it("GET /api/membership/benefits lists Slide Hammer", async () => {
    const player = await registerVerifiedPlayer({ app, redis });
    const res = await app.inject({
      method: "GET", url: "/api/membership/benefits",
      headers: { authorization: `Bearer ${player.token}` },
    });
    expect(res.statusCode).toBe(200);
    const titles = res.json<{ rows: Array<{ title: string }> }>().rows.map((r) => r.title);
    expect(titles).toContain("Slide Hammer");
  });
});
