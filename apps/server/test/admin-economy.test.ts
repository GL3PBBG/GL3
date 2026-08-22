import { TableRowsResponseSchema } from "@gl3/shared";
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
 * The economy dashboard — three read-only aggregates over the transactions
 * ledger (`/api/admin/economy/{supply,flows,daily}/table`). The load-bearing
 * property under test is that NET BY REASON is the faucet/sink signal: a
 * transfer posts equal-and-opposite rows that cancel, while points rows and
 * stale rows are excluded from the money aggregates entirely.
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
});

afterAll(async () => { await closeServer(); });

describe("admin economy: authorization", () => {
  for (const path of ["/api/admin/economy/supply/table", "/api/admin/economy/flows/table", "/api/admin/economy/daily/table"]) {
    it(`401s with no token on ${path}`, async () => {
      const res = await app.inject({ method: "GET", url: path });
      expect(res.statusCode).toBe(401);
    });

    it(`403s a role with no grant on ${path}`, async () => {
      await registerPlayer("FirstAdmin");
      const p = await registerPlayer("NoRole");
      const res = await app.inject({ method: "GET", url: path, headers: auth(p.token) });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: "forbidden" });
    });

    it(`200s the economy grant on ${path}`, async () => {
      await registerPlayer("FirstAdmin");
      const p = await registerPlayer("EconMod");
      await giveRole(p.playerId, "economy");
      const res = await app.inject({ method: "GET", url: path, headers: auth(p.token) });
      expect(res.statusCode, res.body).toBe(200);
    });
  }

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

    const res = await app.inject({ method: "GET", url: "/api/admin/economy/flows/table", headers: auth(founder.token) });
    expect(res.statusCode, res.body).toBe(200);
    const parsed = TableRowsResponseSchema.safeParse(res.json());
    expect(parsed.success, JSON.stringify(res.json())).toBe(true);

    const rows = res.json().rows as { reason: string; net: string; inflow: string; outflow: string; count: string }[];
    const byReason = new Map(rows.map((r) => [r.reason, r]));

    // Faucet: only the fresh row counts.
    expect(byReason.get("crime.payout")).toMatchObject({ net: "+5000", inflow: "5000", outflow: "0", count: "1" });
    // Sink: outflow reported unsigned, net signed negative.
    expect(byReason.get("travel.cost")).toMatchObject({ net: "-1000", inflow: "0", outflow: "1000", count: "1" });
    // Transfer: inflow and outflow still visible, but net cancels to +0.
    expect(byReason.get("bullets.purchase")).toMatchObject({ net: "+0", inflow: "300", outflow: "300", count: "2" });
    // Points never enter the money aggregate.
    expect(byReason.has("round.payout")).toBe(false);
  });
});

describe("admin economy: daily net", () => {
  it("groups by UTC day, newest first, with signed nets", async () => {
    const founder = await registerPlayer("Founder");
    const today = new Date();
    const yesterday = new Date(today.getTime() - 86_400_000);

    await db.insert(transactions).values([
      { id: uuidv7(), playerId: founder.playerId, amount: 4000n, balanceKind: "cash", reason: "crime.payout", createdAt: today },
      { id: uuidv7(), playerId: founder.playerId, amount: -500n, balanceKind: "bank", reason: "travel.cost", createdAt: today },
      { id: uuidv7(), playerId: founder.playerId, amount: 2000n, balanceKind: "cash", reason: "theft.sell", createdAt: yesterday },
    ]);

    const res = await app.inject({ method: "GET", url: "/api/admin/economy/daily/table", headers: auth(founder.token) });
    expect(res.statusCode, res.body).toBe(200);
    const rows = res.json().rows as { day: string; net: string }[];

    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(new Date(rows[0]!.day).getTime()).toBeGreaterThanOrEqual(new Date(rows[1]!.day).getTime());
    const todayIso = today.toISOString().slice(0, 10);
    const todayRow = rows.find((r) => r.day === todayIso);
    expect(todayRow?.net).toBe("+3500");
    const yesterdayRow = rows.find((r) => r.day === yesterday.toISOString().slice(0, 10));
    expect(yesterdayRow?.net).toBe("+2000");
  });
});

describe("admin economy: money supply", () => {
  it("sums player and gang cash/bank into the supply total", async () => {
    const founder = await registerPlayer("Founder");
    const other = await registerPlayer("Other");

    await db.update(playerStats).set({ cash: 1_500n, bank: 2_500n }).where(eq(playerStats.playerId, founder.playerId));
    await db.update(playerStats).set({ cash: 1_000n }).where(eq(playerStats.playerId, other.playerId));

    const res = await app.inject({ method: "GET", url: "/api/admin/economy/supply/table", headers: auth(founder.token) });
    expect(res.statusCode, res.body).toBe(200);
    const rows = res.json().rows as { label: string; value: string }[];
    const byLabel = new Map(rows.map((r) => [r.label, r.value]));

    expect(byLabel.get("Player cash (total)")).toBe("2500");
    expect(byLabel.get("Player bank (total)")).toBe("2500");
    expect(byLabel.get("Gang cash (total)")).toBe("0");
    expect(byLabel.get("Gang bank (total)")).toBe("0");
    expect(byLabel.get("Money supply (cash + bank)")).toBe("5000");
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
