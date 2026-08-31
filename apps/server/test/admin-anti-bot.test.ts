import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { players, roleModuleAccess, roles, transactions } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;

async function giveRole(playerId: string, moduleKey: string): Promise<void> {
  const roleId = uuidv7();
  await db.insert(roles).values({ id: roleId, name: `role-${moduleKey}-${roleId.slice(0, 8)}` });
  await db.insert(roleModuleAccess).values({ roleId, moduleKey });
  await db.update(players).set({ roleId }).where(eq(players.id, playerId));
}

/** First player is the sacrificial auto-admin; the mod holds only `anti-bot`. */
async function bootMod(): Promise<{ token: string; playerId: string }> {
  await registerVerifiedPlayer({ app, redis }, { username: "FirstAdmin" });
  const mod = await registerVerifiedPlayer({ app, redis }, { username: "Watcher" });
  await giveRole(mod.playerId, "anti-bot");
  return mod;
}

/** Ledger rows at fixed offsets (seconds before now) for one player. */
async function seedLedger(playerId: string, offsetsSeconds: number[]): Promise<void> {
  const now = Date.now();
  await db.insert(transactions).values(offsetsSeconds.map((offset) => ({
    id: uuidv7(),
    playerId,
    amount: 100n,
    balanceKind: "cash" as const,
    reason: "test.seed",
    createdAt: new Date(now - offset * 1000),
  })));
}

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer, redis } = await bootTestServer());
});

afterAll(async () => { await closeServer(); await conn.end(); });

describe("admin anti-bot: suspects", () => {
  it("ranks a metronomic 24/7 grinder above a bursty human", async () => {
    const mod = await bootMod();
    const bot = await registerVerifiedPlayer({ app, redis }, { username: "TickTock" });
    const human = await registerVerifiedPlayer({ app, redis }, { username: "Sunday" });

    // Bot: one action exactly every 600s across the last 20 hours.
    await seedLedger(bot.playerId, Array.from({ length: 120 }, (_, i) => i * 600));
    // Human: two ragged bursts inside two evening hours.
    await seedLedger(human.playerId, [100, 133, 420, 890, 7300, 7391, 7402, 8100]);

    const res = await app.inject({
      method: "GET", url: "/api/admin/anti-bot/suspects",
      headers: { authorization: `Bearer ${mod.token}` },
    });
    expect(res.statusCode).toBe(200);
    // Every cell a STRING: the admin table renderer zod-parses cells as
    // strings (the form-fed-routes rule's read-side twin) — numbers broke
    // the live page.
    const { rows } = res.json() as {
      rows: { username: string; events: string; activeHours: string; score: string }[];
    };
    const botRow = rows.find((r) => r.username === "TickTock");
    const humanRow = rows.find((r) => r.username === "Sunday");
    expect(botRow).toBeDefined();
    expect(humanRow).toBeDefined();
    expect(botRow!.events).toBe("120");
    expect(Number(botRow!.activeHours)).toBeGreaterThanOrEqual(20);
    expect(Number(botRow!.score)).toBeGreaterThan(Number(humanRow!.score));
    // Usernames identify rows; raw ids must not render (admin-ids-hidden).
    expect(rows.indexOf(botRow!)).toBeLessThan(rows.indexOf(humanRow!));
  });

  it("respects the hours window", async () => {
    const mod = await bootMod();
    const old = await registerVerifiedPlayer({ app, redis }, { username: "Ancient" });
    // Everything older than 24h.
    await seedLedger(old.playerId, [90_000, 91_000, 92_000]);

    const res = await app.inject({
      method: "GET", url: "/api/admin/anti-bot/suspects?hours=24",
      headers: { authorization: `Bearer ${mod.token}` },
    });
    expect(res.statusCode).toBe(200);
    const { rows } = res.json() as { rows: { username: string }[] };
    expect(rows.find((r) => r.username === "Ancient")).toBeUndefined();
  });

  it("403s without the anti-bot grant", async () => {
    await registerVerifiedPlayer({ app, redis }, { username: "FirstAdmin" });
    const pleb = await registerVerifiedPlayer({ app, redis }, { username: "Pleb" });
    const res = await app.inject({
      method: "GET", url: "/api/admin/anti-bot/suspects",
      headers: { authorization: `Bearer ${pleb.token}` },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("admin anti-bot: section", () => {
  it("appears in the sections payload for the granted admin and not for others", async () => {
    const mod = await bootMod();
    const pleb = await registerVerifiedPlayer({ app, redis }, { username: "Bystander" });

    const granted = await app.inject({
      method: "GET", url: "/api/admin/plugins", headers: { authorization: `Bearer ${mod.token}` },
    });
    expect(granted.statusCode).toBe(200);
    const sections = (granted.json() as { sections: { pluginId: string }[] }).sections;
    expect(sections.some((s) => s.pluginId === "anti-bot")).toBe(true);

    const denied = await app.inject({
      method: "GET", url: "/api/admin/plugins", headers: { authorization: `Bearer ${pleb.token}` },
    });
    expect(denied.statusCode).toBe(403);
  });
});

describe("admin anti-bot: ip clusters", () => {
  it("groups accounts sharing an address and omits singletons", async () => {
    const mod = await bootMod();
    const a = await registerVerifiedPlayer({ app, redis }, { username: "TwinA", remoteAddress: "203.0.113.9" });
    const b = await registerVerifiedPlayer({ app, redis }, { username: "TwinB", remoteAddress: "203.0.113.9" });
    await registerVerifiedPlayer({ app, redis }, { username: "Loner", remoteAddress: "198.51.100.7" });

    const res = await app.inject({
      method: "GET", url: "/api/admin/anti-bot/ip-clusters",
      headers: { authorization: `Bearer ${mod.token}` },
    });
    expect(res.statusCode).toBe(200);
    const { rows } = res.json() as { rows: { ip: string; usernames: string; accounts: string }[] };
    const twins = rows.find((r) => r.ip === "203.0.113.9");
    expect(twins).toBeDefined();
    expect(twins!.accounts).toBe("2");
    expect(twins!.usernames).toContain("TwinA");
    expect(twins!.usernames).toContain("TwinB");
    expect(rows.find((r) => r.ip === "198.51.100.7")).toBeUndefined();
    void a; void b;
  });
});
