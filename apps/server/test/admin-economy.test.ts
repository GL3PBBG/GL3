import { AdminEconomyOverviewSchema } from "@gl3/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { players, playerStats, roleModuleAccess, roles, settings, transactions } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * The economy dashboard — `GET /api/admin/economy/overview`, the bespoke
 * AdminEconomy page's one round trip (supply, 7d/30d window totals, per-reason
 * flows, gap-filled daily series). The load-bearing properties under test:
 * NET BY REASON is the faucet/sink signal (transfers cancel; points and stale
 * rows never enter the money aggregates), and `daily` is ascending and
 * contiguous — the client charts it, and a chart with holes renders a lie.
 *
 * The endpoint caches in Redis for five minutes; tests therefore DELETE the
 * cache key in beforeEach, or a later file's fresh-data assertion could read
 * the previous test's payload.
 */

const { db } = testDb();
let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;

async function registerPlayer(username: string): Promise<{ token: string; playerId: string }> {
  return registerVerifiedPlayer({ app, redis }, { username });
}

/** First-registered player auto-becomes Administrator (`*`). */
async function giveRole(playerId: string, moduleKey: string): Promise<void> {
  const roleId = uuidv7();
  await db.insert(roles).values({ id: roleId, name: `role-${moduleKey}-${roleId.slice(-6)}` });
  await db.insert(roleModuleAccess).values({ roleId, moduleKey });
  await db.update(players).set({ roleId }).where(eq(players.id, playerId));
}

const auth = (token: string): { authorization: string } => ({ authorization: `Bearer ${token}` });

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer, redis } = await bootTestServer());
  // The endpoint caches for five minutes; without this a later test's
  // fresh-data assertion could read the previous test's payload.
  await redis.del("stats:economy-admin");
});

afterAll(async () => { await closeServer(); });

describe("admin economy: authorization", () => {
  it("401s with no token", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/economy/overview" });
    expect(res.statusCode).toBe(401);
  });

  it("403s a role with no grant", async () => {
    await registerPlayer("FirstAdmin");
    const p = await registerPlayer("NoRole");
    const res = await app.inject({ method: "GET", url: "/api/admin/economy/overview", headers: auth(p.token) });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "forbidden" });
  });

  it("200s the economy grant and parses against the DTO", async () => {
    await registerPlayer("FirstAdmin");
    const p = await registerPlayer("EconMod");
    await giveRole(p.playerId, "economy");
    const res = await app.inject({ method: "GET", url: "/api/admin/economy/overview", headers: auth(p.token) });
    expect(res.statusCode, res.body).toBe(200);
    expect(AdminEconomyOverviewSchema.safeParse(res.json()).success).toBe(true);
  });

  it("lists the dashboard under /api/admin/plugins for an economy-granted role", async () => {
    await registerPlayer("FirstAdmin");
    const p = await registerPlayer("EconMod2");
    await giveRole(p.playerId, "economy");
    const res = await app.inject({ method: "GET", url: "/api/admin/plugins", headers: auth(p.token) });
    expect(res.statusCode).toBe(200);
    const sections = res.json().sections as { pluginId: string }[];
    expect(sections.some((s) => s.pluginId === "economy")).toBe(true);
  });
});

describe("admin economy: flows by reason", () => {
  it("nets faucets positive, sinks negative, and cancels transfers; excludes points and stale rows", async () => {
    const founder = await registerPlayer("Founder");
    const other = await registerPlayer("Other");

    // A faucet, a sink, and a transfer pair (two rows, same reason, opposite
    // sides) — plus a points row and an 8-day-old row that must both drop out.
    await db.insert(transactions).values([
      { id: uuidv7(), playerId: founder.playerId, amount: 5000n, balanceKind: "cash", reason: "crime.payout" },
      { id: uuidv7(), playerId: founder.playerId, amount: -1000n, balanceKind: "cash", reason: "travel.cost" },
      { id: uuidv7(), playerId: founder.playerId, amount: -300n, balanceKind: "cash", reason: "bullets.purchase" },
      { id: uuidv7(), playerId: other.playerId, amount: 300n, balanceKind: "cash", reason: "bullets.purchase" },
      { id: uuidv7(), playerId: founder.playerId, amount: 10n, balanceKind: "points", reason: "round.payout" },
      {
        id: uuidv7(), playerId: founder.playerId, amount: 99_999n, balanceKind: "cash", reason: "crime.payout",
        createdAt: new Date(Date.now() - 8 * 86_400_000),
      },
    ]);

    const res = await app.inject({ method: "GET", url: "/api/admin/economy/overview", headers: auth(founder.token) });
    expect(res.statusCode, res.body).toBe(200);
    const body = AdminEconomyOverviewSchema.parse(res.json());

    const byReason = new Map(body.flows.map((f) => [f.reason, f]));

    // Faucet: only the fresh row counts.
    expect(byReason.get("crime.payout")).toMatchObject({ net: "5000", inflow: "5000", outflow: "0", count: 1 });
    // Sink: outflow reported unsigned, net signed negative — a plain signed
    // MoneySchema string now, no explicit `+` (the client formats the sign).
    expect(byReason.get("travel.cost")).toMatchObject({ net: "-1000", inflow: "0", outflow: "1000", count: 1 });
    // Transfer: inflow and outflow still visible, but net cancels to 0.
    expect(byReason.get("bullets.purchase")).toMatchObject({ net: "0", inflow: "300", outflow: "300", count: 2 });
    // Points never enter the money aggregate.
    expect(byReason.has("round.payout")).toBe(false);

    // The 7-day window totals are the sum of exactly these rows: +5000 −1000
    // (−300 + 300) = +4000 net, 5300 in, 1300 out.
    expect(body.windows.d7).toEqual({ net: "4000", inflow: "5300", outflow: "1300" });
    // Ordered by |net| so the biggest mover leads.
    expect(body.flows[0]?.reason).toBe("crime.payout");
  });
});

describe("admin economy: daily series", () => {
  it("is thirty ascending gap-filled UTC days with per-day nets and window totals", async () => {
    const founder = await registerPlayer("Founder");
    const today = new Date();
    const yesterday = new Date(today.getTime() - 86_400_000);

    await db.insert(transactions).values([
      { id: uuidv7(), playerId: founder.playerId, amount: 4000n, balanceKind: "cash", reason: "crime.payout", createdAt: today },
      { id: uuidv7(), playerId: founder.playerId, amount: -500n, balanceKind: "bank", reason: "travel.cost", createdAt: today },
      { id: uuidv7(), playerId: founder.playerId, amount: 2000n, balanceKind: "cash", reason: "theft.sell", createdAt: yesterday },
    ]);

    const res = await app.inject({ method: "GET", url: "/api/admin/economy/overview", headers: auth(founder.token) });
    expect(res.statusCode, res.body).toBe(200);
    const body = AdminEconomyOverviewSchema.parse(res.json());

    // Ascending, contiguous, exactly thirty UTC days ending today — Postgres
    // buckets by date_trunc at UTC, so the keys are computed the same way.
    expect(body.daily).toHaveLength(30);
    const todayKey = today.toISOString().slice(0, 10);
    expect(body.daily[body.daily.length - 1]?.day).toBe(todayKey);
    for (let i = 1; i < body.daily.length; i += 1) {
      const prev = new Date(`${body.daily[i - 1]!.day}T00:00:00Z`).getTime();
      const next = new Date(`${body.daily[i]!.day}T00:00:00Z`).getTime();
      expect(next - prev).toBe(86_400_000);
    }

    const byDay = new Map(body.daily.map((d) => [d.day, d]));
    expect(byDay.get(todayKey)).toMatchObject({ net: "3500", inflow: "4000", outflow: "500" });
    expect(byDay.get(yesterday.toISOString().slice(0, 10))).toMatchObject({ net: "2000", inflow: "2000", outflow: "0" });
    // An empty day is a zero row, not a hole — the client charts this array.
    expect(byDay.get(new Date(today.getTime() - 2 * 86_400_000).toISOString().slice(0, 10)))
      .toMatchObject({ net: "0", inflow: "0", outflow: "0" });

    // The 30-day window totals sum the same rows.
    expect(body.windows.d30).toEqual({ net: "5500", inflow: "6000", outflow: "500" });
  });
});

describe("admin economy: money supply", () => {
  it("sums player and gang cash/bank into the supply total", async () => {
    const founder = await registerPlayer("Founder");
    const other = await registerPlayer("Other");

    await db.update(playerStats).set({ cash: 1_500n, bank: 2_500n }).where(eq(playerStats.playerId, founder.playerId));
    await db.update(playerStats).set({ cash: 1_000n }).where(eq(playerStats.playerId, other.playerId));

    const res = await app.inject({ method: "GET", url: "/api/admin/economy/overview", headers: auth(founder.token) });
    expect(res.statusCode, res.body).toBe(200);
    const body = AdminEconomyOverviewSchema.parse(res.json());

    expect(body.supply).toMatchObject({
      playerCash: "2500",
      playerBank: "2500",
      gangCash: "0",
      gangBank: "0",
      moneySupply: "5000",
    });
  });

  it("serves the five-minute Redis cache on a second read", async () => {
    const founder = await registerPlayer("Founder");
    const first = await app.inject({ method: "GET", url: "/api/admin/economy/overview", headers: auth(founder.token) });
    expect(first.statusCode, first.body).toBe(200);
    const generatedAt = first.json().generatedAt as string;

    // A row landing AFTER the cached compute must not appear — the payload is
    // the cached one, byte for byte.
    await db.insert(transactions).values({
      id: uuidv7(), playerId: founder.playerId, amount: 999n, balanceKind: "cash", reason: "cache.probe",
    });
    const second = await app.inject({ method: "GET", url: "/api/admin/economy/overview", headers: auth(founder.token) });
    expect(second.statusCode).toBe(200);
    expect(second.json().generatedAt).toBe(generatedAt);
    expect(JSON.stringify(second.json())).toBe(JSON.stringify(first.json()));
  });
});

describe("admin economy: wealth tax settings", () => {
  it("shows parser-effective defaults for unset keys", async () => {
    const founder = await registerPlayer("Founder");
    const res = await app.inject({ method: "GET", url: "/api/admin/economy/tax/table", headers: auth(founder.token) });
    expect(res.statusCode, res.body).toBe(200);
    const byLabel = new Map((res.json().rows as { label: string; value: string }[]).map((r) => [r.label, r.value]));
    expect(byLabel.get("Percent of excess bank per day (0 = off)")).toBe("1");
    expect(byLabel.get("Threshold above which the excess is taxed")).toBe("10000000");
  });

  it("upserts both keys and reads them back through the parsers", async () => {
    const founder = await registerPlayer("Founder");
    const write = await app.inject({
      method: "POST", url: "/api/admin/economy/tax", headers: auth(founder.token),
      payload: { percent: 2, threshold: "5000000" },
    });
    expect(write.statusCode, write.body).toBe(204);

    const [row] = await db.select().from(settings).where(eq(settings.key, "economy.wealth_tax_percent"));
    expect(row?.value).toBe("2");

    const list = await app.inject({ method: "GET", url: "/api/admin/economy/tax/table", headers: auth(founder.token) });
    const byLabel = new Map((list.json().rows as { label: string; value: string }[]).map((r) => [r.label, r.value]));
    expect(byLabel.get("Percent of excess bank per day (0 = off)")).toBe("2");
    expect(byLabel.get("Threshold above which the excess is taxed")).toBe("5000000");
  });

  it("403s without the economy grant and 400s bad bodies", async () => {
    const admin = await registerPlayer("FirstAdmin"); // soaks up the auto-admin slot
    const p = await registerPlayer("NoGrant");
    const forbidden = await app.inject({ method: "POST", url: "/api/admin/economy/tax", headers: auth(p.token), payload: { percent: 1, threshold: "1000" } });
    expect(forbidden.statusCode).toBe(403);

    const badPercent = await app.inject({
      method: "POST", url: "/api/admin/economy/tax", headers: auth(admin.token),
      payload: { percent: 101, threshold: "1000" },
    });
    expect(badPercent.statusCode).toBe(400);

    const badThreshold = await app.inject({
      method: "POST", url: "/api/admin/economy/tax", headers: auth(admin.token),
      payload: { percent: 1, threshold: "12.50" },
    });
    expect(badThreshold.statusCode).toBe(400);
  });
});
