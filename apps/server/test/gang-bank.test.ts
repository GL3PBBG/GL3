import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { gangInvites, gangs, playerStats, transactions } from "../src/db/schema/index.js";
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
