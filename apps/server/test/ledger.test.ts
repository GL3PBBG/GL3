import { eq, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { applyBalanceChange, InsufficientFundsError } from "../src/economy/ledger.js";
import { players, playerStats, transactions } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";

const { db, sql: conn } = testDb();
let playerId: string;

beforeEach(async () => {
  await resetDb(db);
  playerId = uuidv7();
  await db.insert(players).values({ id: playerId, username: `p${Date.now()}` });
  await db.insert(playerStats).values({ playerId, cash: 100n });
});
afterAll(async () => { await conn.end(); });

const balance = async (): Promise<bigint> => {
  const [row] = await db.select({ cash: playerStats.cash }).from(playerStats).where(eq(playerStats.playerId, playerId));
  return row?.cash ?? -1n;
};

describe("applyBalanceChange", () => {
  it("credits and writes exactly one ledger row", async () => {
    const next = await db.transaction((tx) =>
      applyBalanceChange(tx, { playerId, amount: 250n, kind: "cash", reason: "crime.payout" }));
    expect(next).toBe(350n);
    expect(await balance()).toBe(350n);

    const rows = await db.select().from(transactions);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.amount).toBe(250n);
    expect(rows[0]?.reason).toBe("crime.payout");
  });

  it("debits when funds suffice", async () => {
    await db.transaction((tx) =>
      applyBalanceChange(tx, { playerId, amount: -40n, kind: "cash", reason: "travel.cost" }));
    expect(await balance()).toBe(60n);
  });

  it("rejects an overdraft and leaves no ledger row behind", async () => {
    await expect(
      db.transaction((tx) =>
        applyBalanceChange(tx, { playerId, amount: -101n, kind: "cash", reason: "travel.cost" })),
    ).rejects.toBeInstanceOf(InsufficientFundsError);

    expect(await balance()).toBe(100n);
    expect(await db.select().from(transactions)).toHaveLength(0);
  });

  it("handles values beyond V2's signed 32-bit ceiling", async () => {
    const huge = 5_000_000_000n; // > 2^31-1, the exact wall real V2 games hit
    await db.transaction((tx) =>
      applyBalanceChange(tx, { playerId, amount: huge, kind: "bank", reason: "test.bigint" }));
    const [row] = await db.select({ bank: playerStats.bank }).from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(row?.bank).toBe(huge);
  });

  it("keeps sum(ledger) == balance across 200 randomised ops", async () => {
    for (let i = 0; i < 200; i += 1) {
      const amount = BigInt(((i * 37) % 21) - 10); // -10..10, deterministic
      if (amount === 0n) continue;
      try {
        await db.transaction((tx) =>
          applyBalanceChange(tx, { playerId, amount, kind: "cash", reason: "test.churn" }));
      } catch (error) {
        if (!(error instanceof InsufficientFundsError)) throw error;
      }
    }
    const [ledger] = await db.select({
      total: sql<string>`coalesce(sum(${transactions.amount}), 0)`,
    }).from(transactions).where(eq(transactions.balanceKind, "cash"));

    expect(await balance()).toBe(100n + BigInt(ledger?.total ?? "0"));
  });
});
