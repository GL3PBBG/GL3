import { GameEventSchema } from "@gl3/shared";
import { and, eq } from "drizzle-orm";
import { bigint, boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { loadConfig } from "../src/config.js";
import {
  locations,
  playerStats,
  players,
  transactions,
} from "../src/db/schema/index.js";
import { runPluginJob } from "../src/plugins/jobs.js";
import { runPluginMigrations } from "../src/plugins/migrate.js";
import ocPlugin from "@gl3/plugin-oc";
import { createRedis, createSubscriber } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";

/**
 * Mirror table definitions for plugin-owned tables — same pattern as oc.test.ts.
 * These are NOT used for inserts (the job handler does that).
 */
const ocHeists = pgTable("p_oc_heists", {
  id: uuid("id").primaryKey(),
  leaderId: uuid("leader_id").notNull(),
  locationId: uuid("location_id").notNull(),
  status: text("status").notNull(),
  buyIn: bigint("buy_in", { mode: "bigint" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  executedAt: timestamp("executed_at", { withTimezone: true }),
});

const ocMembers = pgTable("p_oc_members", {
  heistId: uuid("heist_id").notNull(),
  playerId: uuid("player_id").notNull(),
  role: text("role").notNull(),
  state: text("state").notNull(),
  released: boolean("released").notNull().default(false),
});

const { db, sql: conn } = testDb();
const config = loadConfig(process.env);
const redis = createRedis(config.redisUrl);
const subscriber = createSubscriber(config.redisUrl);

// runPluginJob drives the real plugin handler in-process (no HTTP, no
// boot) with the real plugin_job_runs guard.
const deps = (overrides: Record<string, string> = {}) => ({
  db,
  redis,
  queues: new Map(),
  settings: { ...overrides },
  leaderboardPrefix: "oc-worker-test",
});

const BUY_IN = 1000n;
const MEMBER_COUNT = 4;
const MULTIPLIER = 3n;
const JAIL_SECONDS = 600;
const COOLDOWN_SECONDS = 1800;

let locationId: string;
let memberIds: string[];
let heistId: string;

beforeEach(async () => {
  await resetDb(db);
  // Create plugin-owned tables (the runPluginJob harness doesn't boot a server).
  await runPluginMigrations(db, [ocPlugin]);

  // Shared location for all members
  locationId = uuidv7();
  await db.insert(locations).values({
    id: locationId,
    name: "Chicago",
    travelCost: 100n,
    travelCooldownSeconds: 60,
    bulletStock: 500,
    bulletCost: 5n,
  });

  // Create 4 players with co-located stats
  memberIds = [];
  for (let i = 0; i < MEMBER_COUNT; i++) {
    const playerId = uuidv7();
    memberIds.push(playerId);
    await db.insert(players).values({ id: playerId, username: `crew-${i}-${playerId}` });
    await db.insert(playerStats).values({ playerId, locationId });
    // Fund via bare playerStats UPDATE — matches oc.test.ts fixture pattern.
    await db.update(playerStats).set({ cash: 100_000n })
      .where(eq(playerStats.playerId, playerId));
  }

  // Insert heist row
  heistId = uuidv7();
  await db.insert(ocHeists).values({
    id: heistId,
    leaderId: memberIds[0]!,
    locationId,
    status: "executing",
    buyIn: BUY_IN,
  });

  // Insert 4 accepted member rows
  const roles = ["mastermind", "driver", "gunman", "hacker"];
  for (let i = 0; i < MEMBER_COUNT; i++) {
    await db.insert(ocMembers).values({
      heistId,
      playerId: memberIds[i]!,
      role: roles[i]!,
      state: "accepted",
      released: false,
    });
  }
});

afterEach(async () => {
  // Clean up cooldown keys set during the test
  for (const id of memberIds) {
    try { await redis.del(`cooldown:oc:${id}`); } catch { /* ignore */ }
  }
});

afterAll(async () => {
  await conn.end();
  redis.disconnect();
  subscriber.disconnect();
});

describe("oc resolve job — success", () => {
  it("success: pot x multiplier split equally among all 4 members", async () => {
    await subscriber.subscribe(GAME_EVENTS_CHANNEL);
    const events: unknown[] = [];
    subscriber.on("message", (channel, raw) => {
      if (channel !== GAME_EVENTS_CHANNEL) return;
      const parsed = GameEventSchema.safeParse(JSON.parse(raw));
      if (parsed.success && memberIds.includes(parsed.data.actorId)) {
        events.push(parsed.data);
      }
    });

    await runPluginJob(
      deps({ "oc.success_chance": "1" }),
      ocPlugin,
      "resolve",
      { id: "oc-success-1", data: { heistId, seed: "fixed-seed-oc-success" } },
    );

    // pot = buyIn * 4 = 4000, total = pot * 3 = 12000, share = 3000 each
    const pot = BUY_IN * BigInt(MEMBER_COUNT);
    const total = pot * MULTIPLIER;
    const share = total / BigInt(MEMBER_COUNT);

    // One oc.payout ledger row per member
    for (const pid of memberIds) {
      const rows = await db.select().from(transactions)
        .where(and(eq(transactions.playerId, pid), eq(transactions.reason, "oc.payout")));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.amount).toBe(share);
    }

    // Status = done
    const [heist] = await db.select().from(ocHeists).where(eq(ocHeists.id, heistId));
    expect(heist!.status).toBe("done");
    expect(heist!.executedAt).not.toBeNull();

    // All member rows released
    const members = await db.select().from(ocMembers).where(eq(ocMembers.heistId, heistId));
    for (const m of members) expect(m.released).toBe(true);

    // One oc.resolved event per member
    await new Promise((resolve) => setTimeout(resolve, 200));
    const resolved = events.filter((e) => (e as { type: string }).type === "oc.resolved");
    expect(resolved).toHaveLength(MEMBER_COUNT);
  });
});

describe("oc resolve job — failure", () => {
  it("failure: no payout rows, all four jailed, status failed", async () => {
    await runPluginJob(
      deps({ "oc.success_chance": "0" }),
      ocPlugin,
      "resolve",
      { id: "oc-fail-1", data: { heistId, seed: "fixed-seed-oc-fail" } },
    );

    // Zero oc.payout rows total
    for (const pid of memberIds) {
      const rows = await db.select().from(transactions)
        .where(and(eq(transactions.playerId, pid), eq(transactions.reason, "oc.payout")));
      expect(rows).toHaveLength(0);
    }

    // All four jailed
    for (const pid of memberIds) {
      const [stats] = await db.select({ jailedUntil: playerStats.jailedUntil })
        .from(playerStats).where(eq(playerStats.playerId, pid));
      expect(stats!.jailedUntil).not.toBeNull();
      expect(stats!.jailedUntil!.getTime()).toBeGreaterThan(Date.now());
    }

    // Status = failed
    const [heist] = await db.select().from(ocHeists).where(eq(ocHeists.id, heistId));
    expect(heist!.status).toBe("failed");
    expect(heist!.executedAt).not.toBeNull();

    // All member rows released
    const members = await db.select().from(ocMembers).where(eq(ocMembers.heistId, heistId));
    for (const m of members) expect(m.released).toBe(true);
  });
});

describe("oc resolve job — idempotency", () => {
  it("BullMQ retry applies nothing twice (plugin_job_runs)", async () => {
    const job = { id: "oc-retry-1", data: { heistId, seed: "s" } };

    await runPluginJob(deps({ "oc.success_chance": "1" }), ocPlugin, "resolve", job);
    await runPluginJob(deps({ "oc.success_chance": "1" }), ocPlugin, "resolve", job);

    // Exactly ONE oc.payout row per member, not two
    for (const pid of memberIds) {
      const rows = await db.select().from(transactions)
        .where(and(eq(transactions.playerId, pid), eq(transactions.reason, "oc.payout")));
      expect(rows).toHaveLength(1);
    }
  });
});

describe("oc resolve job — stale job", () => {
  it("a stale job against a resolved heist no-ops", async () => {
    // Set status "done" by hand
    await db.update(ocHeists).set({ status: "done" }).where(eq(ocHeists.id, heistId));

    // Run with a FRESH id — not idempotency guard, but the stale-status check
    await runPluginJob(
      deps({ "oc.success_chance": "1" }),
      ocPlugin,
      "resolve",
      { id: "oc-stale-fresh-id", data: { heistId, seed: "s" } },
    );

    // No oc.payout rows
    for (const pid of memberIds) {
      const rows = await db.select().from(transactions)
        .where(and(eq(transactions.playerId, pid), eq(transactions.reason, "oc.payout")));
      expect(rows).toHaveLength(0);
    }
  });
});

describe("oc resolve job — cooldown", () => {
  it("resolve sets the per-member oc cooldown", async () => {
    await runPluginJob(
      deps({
        "oc.success_chance": "1",
        "oc.cooldown_seconds": String(COOLDOWN_SECONDS),
      }),
      ocPlugin,
      "resolve",
      { id: "oc-cd-1", data: { heistId, seed: "s" } },
    );

    for (const id of memberIds) {
      const ttl = await redis.ttl(`cooldown:oc:${id}`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(COOLDOWN_SECONDS);
    }
  });
});
