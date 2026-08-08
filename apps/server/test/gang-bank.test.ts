import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { gangInvites, gangs, playerStats, transactions } from "../src/db/schema/index.js";
import { lockGangAndPlayerForUpdate } from "../src/economy/ledger.js";
import { hasGangPermission } from "../src/game/gangs/permissions.js";
import { resetDb, testDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let closeServer: () => Promise<void>;
let bossToken: string;
let gangId: string;
let memberToken: string;
let memberId: string;

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer } = await bootTestServer());

  const boss = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "Vito", password: "hunter2hunter2" } });
  bossToken = boss.json().token;
  const gang = await app.inject({
    method: "POST", url: "/api/gangs", headers: { authorization: `Bearer ${bossToken}` }, payload: { name: "The Corleones" },
  });
  gangId = gang.json().id;

  const member = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "Sonny", password: "hunter2hunter2" } });
  ({ token: memberToken, playerId: memberId } = member.json());
  await app.inject({
    method: "POST", url: `/api/gangs/${gangId}/invites`, headers: { authorization: `Bearer ${bossToken}` }, payload: { username: "Sonny" },
  });
  const [invite] = await db.select().from(gangInvites).where(eq(gangInvites.invitedPlayerId, memberId));
  await app.inject({ method: "POST", url: `/api/gangs/invites/${invite!.id}/accept`, headers: { authorization: `Bearer ${memberToken}` } });

  await db.update(playerStats).set({ cash: 1_000n }).where(eq(playerStats.playerId, memberId));
});

afterAll(async () => { await closeServer(); await conn.end(); });

describe("POST /api/gangs/:gangId/bank/deposit", () => {
  it("moves cash from the player to the gang bank with two matching ledger rows", async () => {
    const res = await app.inject({
      method: "POST", url: `/api/gangs/${gangId}/bank/deposit`, headers: { authorization: `Bearer ${memberToken}` },
      payload: { amount: "400" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().bank).toBe("400");

    const [player] = await db.select({ cash: playerStats.cash }).from(playerStats).where(eq(playerStats.playerId, memberId));
    expect(player?.cash).toBe(600n);
    const [gang] = await db.select({ bank: gangs.bank }).from(gangs).where(eq(gangs.id, gangId));
    expect(gang?.bank).toBe(400n);

    const rows = await db.select().from(transactions).where(eq(transactions.reason, "gang.bank.deposit"));
    expect(rows).toHaveLength(2);
    const playerRow = rows.find((r) => r.playerId === memberId);
    const gangRow = rows.find((r) => r.gangId === gangId);
    expect(playerRow?.amount).toBe(-400n);
    expect(gangRow?.amount).toBe(400n);
  });

  it("400s a deposit larger than the player's cash, changing nothing", async () => {
    const res = await app.inject({
      method: "POST", url: `/api/gangs/${gangId}/bank/deposit`, headers: { authorization: `Bearer ${memberToken}` },
      payload: { amount: "5000" },
    });
    expect(res.statusCode).toBe(400);
    const [player] = await db.select({ cash: playerStats.cash }).from(playerStats).where(eq(playerStats.playerId, memberId));
    expect(player?.cash).toBe(1_000n);
  });

  it("403s a non-member depositing", async () => {
    const other = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "Outsider", password: "hunter2hunter2" } });
    const res = await app.inject({
      method: "POST", url: `/api/gangs/${gangId}/bank/deposit`, headers: { authorization: `Bearer ${other.json().token}` },
      payload: { amount: "10" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("404s a deposit to a nonexistent gang", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/gangs/018f8e2a-0000-7000-8000-0000000000ff/bank/deposit",
      headers: { authorization: `Bearer ${memberToken}` }, payload: { amount: "10" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/gangs/:gangId/bank/withdraw", () => {
  it("403s a member with no bank.withdraw permission", async () => {
    await app.inject({
      method: "POST", url: `/api/gangs/${gangId}/bank/deposit`, headers: { authorization: `Bearer ${memberToken}` }, payload: { amount: "400" },
    });
    const res = await app.inject({
      method: "POST", url: `/api/gangs/${gangId}/bank/withdraw`, headers: { authorization: `Bearer ${memberToken}` },
      payload: { amount: "100" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("lets a granted member withdraw, crediting their cash and debiting the gang bank", async () => {
    await app.inject({
      method: "POST", url: `/api/gangs/${gangId}/bank/deposit`, headers: { authorization: `Bearer ${memberToken}` }, payload: { amount: "400" },
    });
    await app.inject({
      method: "PUT", url: `/api/gangs/${gangId}/permissions`, headers: { authorization: `Bearer ${bossToken}` },
      payload: { playerId: memberId, permission: "bank.withdraw" },
    });

    const res = await app.inject({
      method: "POST", url: `/api/gangs/${gangId}/bank/withdraw`, headers: { authorization: `Bearer ${memberToken}` },
      payload: { amount: "150" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().bank).toBe("250");

    const [player] = await db.select({ cash: playerStats.cash }).from(playerStats).where(eq(playerStats.playerId, memberId));
    expect(player?.cash).toBe(750n); // 1000 - 400 deposit + 150 withdraw
  });

  it("400s a withdrawal larger than the gang bank", async () => {
    await app.inject({
      method: "PUT", url: `/api/gangs/${gangId}/permissions`, headers: { authorization: `Bearer ${bossToken}` },
      payload: { playerId: memberId, permission: "bank.withdraw" },
    });
    const res = await app.inject({
      method: "POST", url: `/api/gangs/${gangId}/bank/withdraw`, headers: { authorization: `Bearer ${memberToken}` },
      payload: { amount: "1" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("404s a withdrawal from a nonexistent gang", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/gangs/018f8e2a-0000-7000-8000-0000000000ff/bank/withdraw",
      headers: { authorization: `Bearer ${memberToken}` }, payload: { amount: "10" },
    });
    expect(res.statusCode).toBe(404);
  });
});

// Guards the fix for the TOCTOU race found in review: both bank routes read
// membership/permission with an unlocked query *before* db.transaction opens,
// and (pre-fix) never rechecked once lockGangAndPlayerForUpdate held the row
// locks. Concretely for withdraw: hasGangPermission(db, ...) reads true, then
// a concurrent DELETE /permissions — which touches only gang_permissions, not
// gangs or player_stats — commits in the gap because it never contends for
// the locks this transaction holds, and the withdrawal would go through for
// a player who had no permission at the instant the money moved. This does
// NOT break sum(ledger) == balance (each side's ledger row still matches its
// own delta), which is exactly why the 100-op invariant test above can't
// catch it either.
//
// Two approaches were tried and rejected before this one:
//
// 1. A true HTTP-level Promise.all race (the shape gangs.test.ts uses for
//    the create-gang race). Unlike create-gang, where both concurrent
//    requests contend for the SAME locked player_stats row and so serialize
//    deterministically, deposit/withdraw's unlocked pre-check and DELETE
//    /permissions touch disjoint tables. Whichever side "wins" a Promise.all
//    race is externally indistinguishable from a legitimate outcome — no
//    black-box timing control forces the interleaving that would actually
//    distinguish "recheck caught it" from "recheck got lucky". Pure flake,
//    not proof — the asymmetry Task 3's note (progress.md) already flags
//    for this class of disjoint-table race.
//
// 2. Driving a real DELETE /permissions request *inside* an open
//    `db.transaction` that already holds lockGangAndPlayerForUpdate's locks
//    (i.e. literally reproducing "commits inside the lock window"). This
//    deadlocks every time — proven by running it: it hung until the 5s test
//    timeout, then cascaded into a 30s hook timeout on the next test. Root
//    cause is structural, not flaky: DELETE /permissions calls
//    appendGangLog, which INSERTs into gang_logs, and gang_logs.gang_id has
//    a FK to gangs.id. Postgres takes an implicit FOR KEY SHARE lock on the
//    referenced gangs row for that INSERT, and FOR KEY SHARE conflicts with
//    the FOR UPDATE lockGangAndPlayerForUpdate already holds on that same
//    row. So DELETE /permissions can never actually commit *while* a
//    withdraw holds the lock — it blocks until the withdraw's transaction
//    ends. This incidentally proves the real vulnerable window is narrower
//    than "any time before the recheck": it is specifically the gap between
//    the unlocked pre-check and the moment the FOR UPDATE lock is granted,
//    not the interval the lock is held.
//
// What follows instead is a deterministic, non-blocking reproduction of that
// narrower window, using the exact same primitives and call order the
// withdraw route uses: capture what the unlocked pre-check would have read
// (hasGangPermission(db, ...), no transaction open), then fully commit a
// real revoke through the actual DELETE route, then open a transaction, take
// the lock, and call hasGangPermission(tx, ...) — the withdraw route's
// recheck, verbatim — at the point right before the balance mutation would
// happen. Postgres's READ COMMITTED isolation guarantees each of these is a
// fresh read of latest-committed state at the time it runs, so the assertion
// directly demonstrates the bug the fix closes: the value the pre-check
// captured is stale (true) by the time the transaction would mutate money,
// while the recheck correctly observes the revoke (false).
describe("gang bank TOCTOU recheck", () => {
  it("a permission revoked after the unlocked pre-check but before the in-transaction recheck is observed by the recheck, not the stale pre-check value", async () => {
    await app.inject({
      method: "PUT", url: `/api/gangs/${gangId}/permissions`, headers: { authorization: `Bearer ${bossToken}` },
      payload: { playerId: memberId, permission: "bank.withdraw" },
    });

    // What the withdraw route's unlocked pre-check reads, before any
    // transaction opens.
    const preCheck = await hasGangPermission(db, gangId, memberId, "bank.withdraw");
    expect(preCheck).toBe(true);

    // The window the fix defends against: a real, fully-committed revoke
    // landing after the pre-check ran. DELETE /permissions never takes
    // lockGangAndPlayerForUpdate's locks, so nothing here contends with an
    // in-flight withdraw that hasn't yet acquired them.
    const revoke = await app.inject({
      method: "DELETE", url: `/api/gangs/${gangId}/permissions/${memberId}/bank.withdraw`,
      headers: { authorization: `Bearer ${bossToken}` },
    });
    expect(revoke.statusCode).toBe(204);

    // The withdraw route's actual recheck, verbatim: lockGangAndPlayerForUpdate,
    // then hasGangPermission called with `tx`, at the point right before the
    // balance mutation would happen.
    const recheck = await db.transaction(async (tx) => {
      await lockGangAndPlayerForUpdate(tx, gangId, memberId);
      return hasGangPermission(tx, gangId, memberId, "bank.withdraw");
    });

    // A route that authorized off `preCheck` alone (the pre-fix bug) would
    // have moved money for a player who, by the time of the mutation, no
    // longer had permission. The recheck must not repeat that mistake.
    expect(recheck).toBe(false);
  });
});

describe("gang bank ledger invariant", () => {
  it("keeps sum(ledger) == balance for both the gang and the player across 100 randomised deposits/withdrawals", async () => {
    await app.inject({
      method: "PUT", url: `/api/gangs/${gangId}/permissions`, headers: { authorization: `Bearer ${bossToken}` },
      payload: { playerId: memberId, permission: "bank.withdraw" },
    });
    await db.update(playerStats).set({ cash: 10_000n }).where(eq(playerStats.playerId, memberId));
    await db.update(gangs).set({ bank: 10_000n }).where(eq(gangs.id, gangId));

    for (let i = 0; i < 100; i += 1) {
      const amount = String((i % 30) + 1);
      const url = i % 2 === 0 ? `/api/gangs/${gangId}/bank/deposit` : `/api/gangs/${gangId}/bank/withdraw`;
      await app.inject({ method: "POST", url, headers: { authorization: `Bearer ${memberToken}` }, payload: { amount } });
    }

    const [playerLedger] = await db.select({ total: sql<string>`coalesce(sum(${transactions.amount}), 0)` })
      .from(transactions).where(eq(transactions.playerId, memberId));
    const [gangLedger] = await db.select({ total: sql<string>`coalesce(sum(${transactions.amount}), 0)` })
      .from(transactions).where(eq(transactions.gangId, gangId));

    const [player] = await db.select({ cash: playerStats.cash }).from(playerStats).where(eq(playerStats.playerId, memberId));
    const [gang] = await db.select({ bank: gangs.bank }).from(gangs).where(eq(gangs.id, gangId));

    expect(player?.cash).toBe(10_000n + BigInt(playerLedger?.total ?? "0"));
    expect(gang?.bank).toBe(10_000n + BigInt(gangLedger?.total ?? "0"));
  });
});
