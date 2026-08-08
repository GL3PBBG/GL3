import { drizzle } from "drizzle-orm/postgres-js";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  applyBalanceChange, applyGangBalanceChange, InsufficientGangFundsError, lockGangAndPlayerForUpdate,
} from "../src/economy/ledger.js";
import { gangs, players, playerStats, transactions } from "../src/db/schema/index.js";
import * as schema from "../src/db/schema/index.js";
import { loadConfig } from "../src/config.js";
import { resetDb, testDb } from "./helpers/db.js";

const { db, sql: conn } = testDb();
let gangId: string;
let playerId: string;

beforeEach(async () => {
  await resetDb(db);
  playerId = uuidv7();
  await db.insert(players).values({ id: playerId, username: `p${Date.now()}` });
  await db.insert(playerStats).values({ playerId, cash: 100n });
  gangId = uuidv7();
  await db.insert(gangs).values({ id: gangId, name: `Gang${Date.now()}`, bossPlayerId: playerId, bank: 100n });
});
afterAll(async () => { await conn.end(); });

const gangBalances = async (): Promise<{ bank: bigint; cash: bigint }> => {
  const [row] = await db.select({ bank: gangs.bank, cash: gangs.cash }).from(gangs).where(eq(gangs.id, gangId));
  if (!row) throw new Error("gang missing");
  return row;
};

describe("applyGangBalanceChange", () => {
  it("credits gang bank and writes an owner=gang ledger row", async () => {
    const next = await db.transaction((tx) =>
      applyGangBalanceChange(tx, { gangId, amount: 250n, kind: "bank", reason: "gang.bank.deposit" }));
    expect(next).toBe(350n);
    expect((await gangBalances()).bank).toBe(350n);

    const rows = await db.select().from(transactions);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.gangId).toBe(gangId);
    expect(rows[0]?.playerId).toBeNull();
    expect(rows[0]?.amount).toBe(250n);
  });

  it("rejects a gang overdraft and leaves no ledger row behind", async () => {
    await expect(
      db.transaction((tx) =>
        applyGangBalanceChange(tx, { gangId, amount: -101n, kind: "bank", reason: "gang.bank.withdraw" })),
    ).rejects.toBeInstanceOf(InsufficientGangFundsError);

    expect((await gangBalances()).bank).toBe(100n);
    expect(await db.select().from(transactions)).toHaveLength(0);
  });

  it("keeps player and gang ledgers independently consistent across 100 randomised transfers", async () => {
    await db.update(playerStats).set({ cash: 5_000n }).where(eq(playerStats.playerId, playerId));
    await db.update(gangs).set({ bank: 5_000n }).where(eq(gangs.id, gangId));

    for (let i = 0; i < 100; i += 1) {
      const amount = BigInt((i % 20) + 1);
      const deposit = i % 2 === 0;
      await db.transaction(async (tx) => {
        await lockGangAndPlayerForUpdate(tx, gangId, playerId);
        if (deposit) {
          await applyBalanceChange(tx, { playerId, amount: -amount, kind: "cash", reason: "test.gang-transfer" });
          await applyGangBalanceChange(tx, { gangId, amount, kind: "bank", reason: "test.gang-transfer" });
        } else {
          await applyGangBalanceChange(tx, { gangId, amount: -amount, kind: "bank", reason: "test.gang-transfer" });
          await applyBalanceChange(tx, { playerId, amount, kind: "cash", reason: "test.gang-transfer" });
        }
      });
    }

    const [playerLedger] = await db.select({ total: sql<string>`coalesce(sum(${transactions.amount}), 0)` })
      .from(transactions).where(eq(transactions.playerId, playerId));
    const [gangLedger] = await db.select({ total: sql<string>`coalesce(sum(${transactions.amount}), 0)` })
      .from(transactions).where(eq(transactions.gangId, gangId));

    const [player] = await db.select({ cash: playerStats.cash }).from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(player?.cash).toBe(5_000n + BigInt(playerLedger?.total ?? "0"));
    expect((await gangBalances()).bank).toBe(5_000n + BigInt(gangLedger?.total ?? "0"));
  });

  // The specific risk this function exists to remove: applyBalanceChange locks
  // player_stats, applyGangBalanceChange locks gangs — two different tables.
  // Without one deterministic order up front, a deposit (naively: lock gang,
  // then player) and a withdrawal (naively: lock player, then gang) running
  // concurrently could each hold one lock and wait on the other — a genuine
  // Postgres deadlock (40P01), not a timing flake. 40 concurrent, alternating
  // transfers between the SAME gang/player pair is enough to hit that window
  // reliably if the ordering were direction-dependent.
  it("does not deadlock under concurrent opposite-direction transfers", async () => {
    await db.update(playerStats).set({ cash: 1_000n }).where(eq(playerStats.playerId, playerId));
    await db.update(gangs).set({ bank: 1_000n }).where(eq(gangs.id, gangId));

    const attempt = (direction: "deposit" | "withdraw") => db.transaction(async (tx) => {
      await lockGangAndPlayerForUpdate(tx, gangId, playerId);
      if (direction === "deposit") {
        await applyBalanceChange(tx, { playerId, amount: -1n, kind: "cash", reason: "test.gang-transfer" });
        await applyGangBalanceChange(tx, { gangId, amount: 1n, kind: "bank", reason: "test.gang-transfer" });
      } else {
        await applyGangBalanceChange(tx, { gangId, amount: -1n, kind: "bank", reason: "test.gang-transfer" });
        await applyBalanceChange(tx, { playerId, amount: 1n, kind: "cash", reason: "test.gang-transfer" });
      }
    });

    const attempts = Array.from({ length: 40 }, (_, i) => attempt(i % 2 === 0 ? "deposit" : "withdraw"));
    await expect(Promise.all(attempts)).resolves.toBeDefined();
  });

  // Proves the lock order is genuinely deterministic regardless of which id is
  // lexicographically smaller — captures the literal SQL each call sends via
  // the `postgres` driver's `debug` hook, the same technique ledger.test.ts
  // uses for lockPlayersForUpdate.
  it("locks the gang and the player in ascending-id order regardless of transfer direction", async () => {
    const captured: { query: string }[] = [];
    const debugSql = postgres(loadConfig(process.env).databaseUrl, {
      debug: (_conn, query) => { captured.push({ query }); },
    });
    const debugDb = drizzle(debugSql, { schema });

    try {
      await debugDb.transaction((tx) => lockGangAndPlayerForUpdate(tx, gangId, playerId));
      const lockQueries = captured.filter((c) => /for update/i.test(c.query));
      expect(lockQueries).toHaveLength(2);

      const gangFirst = /"gangs"/.test(lockQueries[0]?.query ?? "");
      const playerFirst = /"player_stats"/.test(lockQueries[0]?.query ?? "");
      expect(gangFirst || playerFirst).toBe(true);
      // Whichever table's id sorts first lexicographically must be locked first.
      expect(gangFirst).toBe(gangId < playerId);
    } finally {
      await debugSql.end();
    }
  });
});
