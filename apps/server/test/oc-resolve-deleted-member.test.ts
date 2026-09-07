/**
 * OC resolve tolerates a crew member whose account was hard-deleted.
 *
 * Five plugin-owned columns hold a `player_id` with NO foreign key onto
 * `players` — `p_oc_heists.leader_id`, `p_oc_members.player_id`,
 * `p_combat_weapon_condition.player_id`, `p_education_progress.player_id`,
 * `p_courses_done.player_id`, `p_player_jobs.player_id`. `POST
 * /api/auth/delete` therefore removes the `players` row (and everything that
 * cascades off it, `player_stats` and `transactions` included) while the
 * heist's member row survives.
 *
 * The dangerous case is an accepted member of a heist already `executing`:
 * `resolve` counts a full crew of four, then hands the deleted id to
 * `applyBalanceChange`, which throws `player_stats missing for …`
 * (economy/ledger.ts). BullMQ retries that forever and the three surviving
 * members stay latched by the `p_oc_members_active_player` partial unique
 * index — they can never join another heist.
 *
 * This file drives the REAL delete route (not a raw DELETE) so the scenario is
 * the one a player can actually produce, and then drives `resolve` through
 * `runPluginJob` with a pinned seed and pinned `oc.success_chance` — the
 * oc-ledger.test.ts shape, including pausing the live `oc:resolve` queue so the
 * booted worker cannot race the manual run and steal the pinned outcome.
 */

import { and, eq } from "drizzle-orm";
import { bigint, boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { locations, playerStats, players, transactions } from "../src/db/schema/index.js";
import { applyBalanceChange } from "../src/economy/ledger.js";
import { cooldownKey } from "../src/game/cooldown.js";
import { runPluginJob } from "../src/plugins/jobs.js";
import ocPlugin from "@gl3/plugin-oc";
import { resetDb, testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

/** Mirror table definitions for plugin-owned tables — the oc.test.ts pattern. */
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

let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;
let leaderboardPrefix: string;

const SEED_CASH = 500_000n;
const BUY_IN = 1000n;
const MULTIPLIER = 3n;
const CREW_SIZE = 4;
const PASSWORD = "password123";
/** Index into `memberIds` of the crew member whose account gets deleted. */
const DELETED_INDEX = 2;

let locationId: string;
let testCounter = 0;
let memberIds: string[] = [];
let memberTokens: string[] = [];

// Every request carries its own IP. `register` is 5/hour/IP and `delete`
// shares the 5/900s "password" bucket, both keyed by IP only; this file boots
// once and Redis is not touched by resetDb(), so without per-call IPs the
// file's own registrations would 429 partway through.
let ipCounter = 0;
const nextIp = (): string => `10.11.0.${++ipCounter}`;

const inject = (method: "GET" | "POST", url: string, token: string, payload?: Record<string, unknown>) =>
  app.inject({
    method, url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload !== undefined ? { payload } : {}),
  });

async function registerAndSeed(username: string): Promise<{ token: string; playerId: string }> {
  const { token, playerId } = await registerVerifiedPlayer(
    { app, redis }, { username, password: PASSWORD, remoteAddress: nextIp() },
  );
  await db.transaction((tx) =>
    applyBalanceChange(tx, { playerId, amount: SEED_CASH, kind: "cash", reason: "test.seed" }),
  );
  return { token, playerId };
}

/** Build a full four-member heist with every buy-in escrowed, then execute it. */
async function buildAndExecute(): Promise<string> {
  const createRes = await inject("POST", "/api/oc", memberTokens[0]!, { buyIn: String(BUY_IN) });
  expect(createRes.statusCode).toBe(201);
  const heistId = createRes.json().heistId as string;

  const roles = ["driver", "gunman", "hacker"];
  for (let i = 0; i < 3; i++) {
    const invite = await inject("POST", `/api/oc/${heistId}/invite`, memberTokens[0]!, {
      targetUsername: `DelCrew${testCounter}-${i}`, role: roles[i]!,
    });
    expect(invite.statusCode).toBe(201);
    const accept = await inject("POST", `/api/oc/${heistId}/accept`, memberTokens[i + 1]!);
    expect(accept.statusCode).toBe(200);
  }

  const exec = await inject("POST", `/api/oc/${heistId}/execute`, memberTokens[0]!);
  expect(exec.statusCode).toBe(202);
  return heistId;
}

/** Delete one crew member's account through the real route. */
async function deleteAccount(index: number): Promise<void> {
  const res = await app.inject({
    method: "POST", url: "/api/auth/delete",
    headers: { authorization: `Bearer ${memberTokens[index]!}` },
    remoteAddress: nextIp(),
    payload: { password: PASSWORD },
  });
  expect(res.statusCode).toBe(204);
  const rows = await db.select({ id: players.id }).from(players)
    .where(eq(players.id, memberIds[index]!));
  expect(rows).toHaveLength(0);
  // The member row has no FK onto players, so it survives the delete — that
  // survival is the whole premise of this file.
  const member = await db.select().from(ocMembers)
    .where(eq(ocMembers.playerId, memberIds[index]!));
  expect(member).toHaveLength(1);
}

beforeAll(async () => {
  const booted = await bootTestServer();
  app = booted.app;
  redis = booted.redis;
  closeServer = booted.close;
  leaderboardPrefix = booted.leaderboardPrefix;

  // `execute` enqueues a REAL resolve job onto the live plugin worker while
  // every test below drives `resolve` manually with a pinned seed. Both
  // resolvers no-op unless the heist is still "executing", so whichever
  // commits first wins — pausing the queue makes the manual run the only
  // resolver. Same reasoning, verbatim, as oc-ledger.test.ts.
  const resolveQueue = booted.plugins.queues.get("oc:resolve");
  if (!resolveQueue) throw new Error("oc:resolve queue not found — did the oc plugin's job name change?");
  await resolveQueue.pause();
});

beforeEach(async () => {
  await resetDb(db);
  testCounter++;
  memberIds = [];
  memberTokens = [];

  locationId = (await db.insert(locations).values({
    id: crypto.randomUUID(), name: "Chicago", travelCost: 100n,
    travelCooldownSeconds: 60, bulletStock: 500, bulletCost: 5n,
  }).returning({ id: locations.id }))[0]!.id;

  // The leader registers FIRST, so the leader — not the member this file
  // deletes — is the game's sole Administrator and the delete route's
  // `sole_administrator` guard never fires.
  const leader = await registerAndSeed(`DelBoss${testCounter}`);
  memberIds.push(leader.playerId);
  memberTokens.push(leader.token);
  for (let i = 0; i < 3; i++) {
    const m = await registerAndSeed(`DelCrew${testCounter}-${i}`);
    memberIds.push(m.playerId);
    memberTokens.push(m.token);
  }

  for (const pid of memberIds) {
    await db.update(playerStats).set({ locationId }).where(eq(playerStats.playerId, pid));
  }
});

afterEach(async () => {
  for (const id of memberIds) {
    try { await redis.del(cooldownKey(id, "oc")); } catch { /* ignore */ }
  }
});

afterAll(async () => {
  await closeServer();
  await conn.end();
});

describe("oc resolve — a crew member's account was deleted mid-heist", () => {
  it("success: the job completes, the three survivors are paid, the deleted share is forfeited", async () => {
    const heistId = await buildAndExecute();
    await deleteAccount(DELETED_INDEX);

    await runPluginJob(
      { db, redis, queues: new Map(), settings: { "oc.success_chance": "1" }, leaderboardPrefix },
      ocPlugin,
      "resolve",
      { id: `oc-deleted-success-${testCounter}`, data: { heistId, seed: "deleted-member-success" } },
    );

    // pot = buyIn * 4 = 4000, total = 12000, share = 3000. The split stays over
    // CREW_SIZE: the deleted member's share is forfeited, not redistributed.
    const share = (BUY_IN * BigInt(CREW_SIZE) * MULTIPLIER) / BigInt(CREW_SIZE);

    for (const [i, pid] of memberIds.entries()) {
      if (i === DELETED_INDEX) continue;
      const payouts = await db.select().from(transactions)
        .where(and(eq(transactions.playerId, pid), eq(transactions.reason, "oc.payout")));
      expect(payouts, `oc.payout rows for survivor ${i}`).toHaveLength(1);
      expect(payouts[0]!.amount).toBe(share);

      // Net over the whole heist: -1000 buy-in, +3000 payout.
      const [row] = await db.select({ cash: playerStats.cash })
        .from(playerStats).where(eq(playerStats.playerId, pid));
      expect(row!.cash).toBe(SEED_CASH - BUY_IN + share);
    }

    // Nothing in the ledger references the deleted player.
    const orphaned = await db.select({ id: transactions.id }).from(transactions)
      .where(eq(transactions.playerId, memberIds[DELETED_INDEX]!));
    expect(orphaned).toHaveLength(0);

    const [heist] = await db.select().from(ocHeists).where(eq(ocHeists.id, heistId));
    expect(heist!.status).toBe("done");
    expect(heist!.executedAt).not.toBeNull();

    const members = await db.select().from(ocMembers).where(eq(ocMembers.heistId, heistId));
    expect(members).toHaveLength(CREW_SIZE);
    for (const m of members) expect(m.released).toBe(true);
  });

  it("failure: the job completes, the three survivors are jailed, the heist is failed", async () => {
    const heistId = await buildAndExecute();
    await deleteAccount(DELETED_INDEX);

    await runPluginJob(
      { db, redis, queues: new Map(), settings: { "oc.success_chance": "0" }, leaderboardPrefix },
      ocPlugin,
      "resolve",
      { id: `oc-deleted-failure-${testCounter}`, data: { heistId, seed: "deleted-member-failure" } },
    );

    for (const [i, pid] of memberIds.entries()) {
      if (i === DELETED_INDEX) continue;
      const [row] = await db.select({ cash: playerStats.cash, jailedUntil: playerStats.jailedUntil })
        .from(playerStats).where(eq(playerStats.playerId, pid));
      expect(row!.jailedUntil, `jailedUntil for survivor ${i}`).not.toBeNull();
      expect(row!.jailedUntil!.getTime()).toBeGreaterThan(Date.now());
      expect(row!.cash).toBe(SEED_CASH - BUY_IN);

      const payouts = await db.select().from(transactions)
        .where(and(eq(transactions.playerId, pid), eq(transactions.reason, "oc.payout")));
      expect(payouts).toHaveLength(0);
    }

    const [heist] = await db.select().from(ocHeists).where(eq(ocHeists.id, heistId));
    expect(heist!.status).toBe("failed");

    const members = await db.select().from(ocMembers).where(eq(ocMembers.heistId, heistId));
    for (const m of members) expect(m.released).toBe(true);
  });
});
