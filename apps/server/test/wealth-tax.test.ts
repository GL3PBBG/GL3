import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { gangs, notifications, players, playerStats, settings as settingsTable, transactions } from "../src/db/schema/index.js";
import { applyBalanceChange } from "../src/economy/ledger.js";
import { settleWealthTaxOnce } from "../src/economy/tax.js";
import { resetDb, testDb } from "./helpers/db.js";

/**
 * The daily wealth tax, driven directly (the bullets-restock test pattern:
 * tunables as arguments, no bootTestServer, no seeded settings rows). The
 * cursor is stamped inside the settle transaction, so every "already ran"
 * case is just a second call against the same day.
 */

const { db, sql: conn } = testDb();

beforeEach(async () => {
  await resetDb(db);
});
afterAll(async () => { await conn.end(); });

async function seedPlayer(bank: bigint, cash: bigint = 0n): Promise<string> {
  const id = uuidv7();
  await db.insert(players).values({ id, username: `taxed${id.slice(-8)}` });
  await db.insert(playerStats).values({ playerId: id, bank, cash });
  return id;
}

async function seedGang(bank: bigint): Promise<string> {
  const id = uuidv7();
  await db.insert(gangs).values({ id, name: `gang${id.slice(-8)}`, bank });
  return id;
}

const bankOf = async (playerId: string): Promise<bigint> => {
  const [row] = await db.select({ bank: playerStats.bank }).from(playerStats).where(eq(playerStats.playerId, playerId));
  return row?.bank ?? -1n;
};

const gangBankOf = async (gangId: string): Promise<bigint> => {
  const [row] = await db.select({ bank: gangs.bank }).from(gangs).where(eq(gangs.id, gangId));
  return row?.bank ?? -1n;
};

const cursor = async (): Promise<string | null> => {
  const [row] = await db.select().from(settingsTable).where(eq(settingsTable.key, "economy.wealth_tax.last_day"));
  return row?.value ?? null;
};

describe("settleWealthTaxOnce", () => {
  it("taxes only the excess above the threshold, players and gangs, and leaves cash alone", async () => {
    const rich = await seedPlayer(50_000_000n, 7_000_000n);
    const mid = await seedPlayer(10_500_000n);
    const poor = await seedPlayer(10_000_000n); // exactly at the threshold: no tax
    const gang = await seedGang(20_000_000n);

    const result = await settleWealthTaxOnce(db, {});
    expect(result.ran).toBe(true);
    expect(result.playersTaxed).toBe(2);
    expect(result.gangsTaxed).toBe(1);

    // 1% of (50M - 10M) = 400k; 1% of 500k = 5k; gang 1% of 10M = 100k.
    expect(await bankOf(rich)).toBe(49_600_000n);
    expect(await bankOf(mid)).toBe(10_495_000n);
    expect(await bankOf(poor)).toBe(10_000_000n);
    expect(await gangBankOf(gang)).toBe(19_900_000n);

    // Cash is deliberately untouched — pocket money stays stealable, which is
    // what keeps depositing a tradeoff.
    const [richStats] = await db.select().from(playerStats).where(eq(playerStats.playerId, rich));
    expect(richStats?.cash).toBe(7_000_000n);
  });

  it("writes ledger rows and keeps sum(ledger) == balance for every drained owner", async () => {
    // Seed through the LEDGER, not a raw insert — sum(ledger) == balance is
    // only provable when the opening balance has a ledger row behind it (the
    // hospital suite documents the same trap for discharge).
    const rich = await seedPlayer(0n);
    await db.transaction((tx) => applyBalanceChange(tx, {
      playerId: rich, amount: 50_000_000n, kind: "bank", reason: "test.seed",
    }));
    await settleWealthTaxOnce(db, {});

    const rows = await db.select().from(transactions).where(eq(transactions.reason, "economy.wealth_tax"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.amount).toBe(-400_000n);
    expect(rows[0]?.balanceKind).toBe("bank");

    const ledger = await db.select().from(transactions).where(eq(transactions.playerId, rich));
    const sum = ledger.reduce((acc, t) => acc + t.amount, 0n);
    expect(sum).toBe(await bankOf(rich));
  });

  it("notifies drained players inside the settle transaction", async () => {
    const rich = await seedPlayer(50_000_000n);
    await settleWealthTaxOnce(db, {});

    const notes = await db.select().from(notifications).where(eq(notifications.playerId, rich));
    expect(notes).toHaveLength(1);
    expect(notes[0]?.body).toBe("The bank took 400000 from your account in wealth tax.");
  });

  it("stamps the day's cursor — a second call in the same day is a no-op", async () => {
    await seedPlayer(50_000_000n);
    const first = await settleWealthTaxOnce(db, {});
    expect(first.ran).toBe(true);
    expect(await cursor()).not.toBeNull();

    // Drop a fresh whale in AFTER the day settled: the cursor, not the
    // balance scan, decides — the whale is taxed tomorrow.
    await seedPlayer(99_000_000n);
    const second = await settleWealthTaxOnce(db, {});
    expect(second).toEqual({ ran: false, playersTaxed: 0, gangsTaxed: 0 });

    const rows = await db.select().from(transactions).where(eq(transactions.reason, "economy.wealth_tax"));
    expect(rows).toHaveLength(1);
  });

  it("skips without stamping when the percent is 0 — enabling taxes on the next tick", async () => {
    await seedPlayer(50_000_000n);
    const result = await settleWealthTaxOnce(db, { "economy.wealth_tax_percent": "0" });
    expect(result.ran).toBe(false);
    expect(await cursor()).toBeNull();
    expect(await db.select().from(transactions)).toEqual([]);

    // The un-stamped cursor is what lets the very next tick tax.
    const after = await settleWealthTaxOnce(db, {});
    expect(after.ran).toBe(true);
  });

  it("honours settings overrides for percent and threshold", async () => {
    const rich = await seedPlayer(50_000_000n);
    await settleWealthTaxOnce(db, {
      "economy.wealth_tax_percent": "2",
      "economy.wealth_tax_threshold": "1000000",
    });
    // 2% of (50M - 1M) = 980k.
    expect(await bankOf(rich)).toBe(49_020_000n);
  });

  it("rounds the tax up — the bank gets the rounding, like the wealth-scaled fees", async () => {
    // Excess 101 with 1%: exact 1.01 → 2.
    await seedPlayer(10_000_101n);
    const result = await settleWealthTaxOnce(db, {});
    expect(result.playersTaxed).toBe(1);
    const [row] = await db.select().from(transactions).where(eq(transactions.reason, "economy.wealth_tax"));
    expect(row?.amount).toBe(-2n);
  });
});
