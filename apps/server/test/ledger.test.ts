import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { applyBalanceChange, InsufficientFundsError, lockLocationForUpdate, lockPlayersForUpdate } from "../src/economy/ledger.js";
import { locations, players, playerStats, transactions } from "../src/db/schema/index.js";
import * as schema from "../src/db/schema/index.js";
import { loadConfig } from "../src/config.js";
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

const stats = async (): Promise<{ cash: bigint; bank: bigint; points: bigint }> => {
  const [row] = await db.select({ cash: playerStats.cash, bank: playerStats.bank, points: playerStats.points })
    .from(playerStats)
    .where(eq(playerStats.playerId, playerId));
  if (!row) throw new Error("player_stats row missing");
  return row;
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

  // --- G1: bank and points must be as thoroughly wired as cash. `column` in
  // ledger.ts is a lookup table keyed by `kind`, so the risk is a transposed
  // entry silently moving the wrong column. These prove each kind hits its
  // own column, moves nothing else, and tags its ledger row correctly.

  it("credits and debits bank, leaving cash and points untouched, tagged with balance_kind=bank", async () => {
    const afterCredit = await db.transaction((tx) =>
      applyBalanceChange(tx, { playerId, amount: 500n, kind: "bank", reason: "bank.deposit" }));
    expect(afterCredit).toBe(500n);

    const afterDebit = await db.transaction((tx) =>
      applyBalanceChange(tx, { playerId, amount: -200n, kind: "bank", reason: "bank.withdraw" }));
    expect(afterDebit).toBe(300n);

    const row = await stats();
    expect(row.bank).toBe(300n);
    expect(row.cash).toBe(100n); // untouched — still the beforeEach seed
    expect(row.points).toBe(0n); // untouched

    const rows = await db.select().from(transactions).orderBy(transactions.createdAt);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.balanceKind === "bank")).toBe(true);
    // Both rows can share a created_at tick, whose tie order is unspecified —
    // under full-suite load the pair has come back reversed. The fact under
    // test is which rows exist, not the tick's tiebreak: compare sorted.
    const amounts = rows.map((r) => r.amount).sort((a, b) => (a < b ? -1 : 1));
    expect(amounts).toEqual([-200n, 500n]);
  });

  it("credits and debits points, leaving cash and bank untouched, tagged with balance_kind=points", async () => {
    const afterCredit = await db.transaction((tx) =>
      applyBalanceChange(tx, { playerId, amount: 80n, kind: "points", reason: "rank.points" }));
    expect(afterCredit).toBe(80n);

    const afterDebit = await db.transaction((tx) =>
      applyBalanceChange(tx, { playerId, amount: -30n, kind: "points", reason: "shop.spend-points" }));
    expect(afterDebit).toBe(50n);

    const row = await stats();
    expect(row.points).toBe(50n);
    expect(row.cash).toBe(100n); // untouched
    expect(row.bank).toBe(0n); // untouched

    const rows = await db.select().from(transactions).orderBy(transactions.createdAt);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.balanceKind === "points")).toBe(true);
    expect(rows.map((r) => r.amount)).toEqual([80n, -30n]);
  });

  it("rejects a points overdraft without touching cash or bank", async () => {
    await expect(
      db.transaction((tx) =>
        applyBalanceChange(tx, { playerId, amount: -1n, kind: "points", reason: "shop.spend-points" })),
    ).rejects.toBeInstanceOf(InsufficientFundsError);

    const row = await stats();
    expect(row.points).toBe(0n);
    expect(row.cash).toBe(100n);
    expect(row.bank).toBe(0n);
    expect(await db.select().from(transactions)).toHaveLength(0);
  });
});

describe("lockPlayersForUpdate", () => {
  // --- G2: every current caller (applyBalanceChange) only ever locks a
  // single-element array, so the multi-id, ascending-order behaviour this
  // function exists for is otherwise never exercised.

  it("accepts several ids supplied in descending order and genuinely locks every row", async () => {
    const idB = uuidv7();
    const idC = uuidv7();
    await db.insert(players).values([
      { id: idB, username: `b${Date.now()}` },
      { id: idC, username: `c${Date.now()}` },
    ]);
    await db.insert(playerStats).values([{ playerId: idB }, { playerId: idC }]);

    // Deliberately descending, i.e. the opposite of what the function should
    // impose internally.
    const idsDescending = [playerId, idB, idC].sort().reverse();
    expect(idsDescending).not.toEqual([...idsDescending].sort());

    let signalLocked: () => void;
    const locked = new Promise<void>((resolve) => { signalLocked = resolve; });
    let releaseHolder: () => void;
    const released = new Promise<void>((resolve) => { releaseHolder = resolve; });

    const holder = db.transaction(async (tx) => {
      await lockPlayersForUpdate(tx, idsDescending);
      signalLocked();
      await released;
    });

    await locked;

    // While the holder transaction is open, a NOWAIT lock probe against any
    // of the three ids must fail immediately with Postgres SQLSTATE 55P03
    // (lock_not_available) — proving the row is actually locked, not that
    // the query merely ran without error. Wrapped in try/finally so a
    // failing assertion here can never leave the holder transaction open —
    // an orphaned open transaction would hold its row locks forever and
    // wedge every later test's resetDb() TRUNCATE.
    try {
      for (const id of [playerId, idB, idC]) {
        let caught: unknown;
        try {
          await db.select({ id: playerStats.playerId })
            .from(playerStats)
            .where(eq(playerStats.playerId, id))
            .for("update", { noWait: true });
        } catch (error) {
          caught = error;
        }
        const code = (caught as { cause?: { code?: string } } | undefined)?.cause?.code;
        expect(code).toBe("55P03");
      }
    } finally {
      releaseHolder!();
      await holder;
    }

    // Once released, the same probes succeed immediately.
    for (const id of [playerId, idB, idC]) {
      await expect(
        db.select({ id: playerStats.playerId })
          .from(playerStats)
          .where(eq(playerStats.playerId, id))
          .for("update", { noWait: true }),
      ).resolves.toHaveLength(1);
    }
  });

  // Whether lockPlayersForUpdate's internal sort is *observed* by the
  // database as ascending is not visible through applyBalanceChange's return
  // value or the row data alone — the only externally-observable trace is
  // the actual SQL Postgres receives. Rather than mock the DB (disallowed)
  // or introspect ledger.ts internals, we open a second real connection with
  // the `postgres` driver's `debug` hook — a genuine driver feature, not a
  // test double — and read the literal bound parameters of the `IN (...)`
  // clause the query builder sent for this exact call.
  it("sends the IN clause to Postgres in ascending id order regardless of call-site order", async () => {
    const idB = uuidv7();
    const idC = uuidv7();
    await db.insert(players).values([
      { id: idB, username: `d${Date.now()}` },
      { id: idC, username: `e${Date.now()}` },
    ]);
    await db.insert(playerStats).values([{ playerId: idB }, { playerId: idC }]);

    const captured: { query: string; params: unknown[] }[] = [];
    const debugSql = postgres(loadConfig(process.env).databaseUrl, {
      debug: (_conn, query, params) => { captured.push({ query, params }); },
    });
    const debugDb = drizzle(debugSql, { schema });

    try {
      const idsDescending = [playerId, idB, idC].sort().reverse();
      await debugDb.transaction(async (tx) => {
        await lockPlayersForUpdate(tx, idsDescending);
      });

      const lockQuery = captured.find((c) => /for update/i.test(c.query));
      expect(lockQuery).toBeDefined();
      // The three ids as bound IN-clause parameters, in the order Postgres
      // actually received them.
      const boundIds = (lockQuery?.params ?? []).filter((p): p is string => typeof p === "string");
      expect(boundIds).toEqual([...idsDescending].sort());
      expect(boundIds).not.toEqual(idsDescending);
    } finally {
      await debugSql.end();
    }
  });
});

describe("concurrent double-spend", () => {
  // --- G3: the permanent version of the reviewer's throwaway probe. Two
  // concurrent transactions each try to debit more than half of a 100
  // balance (60 + 60 > 100), so at most one can succeed no matter which one
  // wins the row lock race — this is deterministic by construction, not
  // timing-dependent: whichever transaction's SELECT ... FOR UPDATE is
  // granted first commits, dropping the balance to 40; the other blocks on
  // that same row lock, then — once unblocked — re-reads the now-committed
  // 40 under READ COMMITTED and 40 - 60 < 0 fails every time. No sleeps, no
  // retries, no unstable ordering assumption.
  it("lets exactly one of two concurrent debits succeed and leaves the ledger consistent", async () => {
    const attemptDebit = () =>
      db.transaction((tx) =>
        applyBalanceChange(tx, { playerId, amount: -60n, kind: "cash", reason: "test.concurrent-debit" }));

    const results = await Promise.allSettled([attemptDebit(), attemptDebit()]);

    const fulfilled = results.filter((r): r is PromiseFulfilledResult<bigint> => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(InsufficientFundsError);
    expect(fulfilled[0]?.value).toBe(40n);

    expect(await balance()).toBe(40n);

    const rows = await db.select().from(transactions).where(eq(transactions.reason, "test.concurrent-debit"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.amount).toBe(-60n);
  });
});

describe("lockLocationForUpdate", () => {
  it("serializes two concurrent stock decrements against the same location", async () => {
    const locationId = uuidv7();
    await db.insert(locations).values({ id: locationId, name: "Testville", bulletStock: 10, bulletCost: 1n });

    const decrement = () => db.transaction(async (tx) => {
      await lockLocationForUpdate(tx, locationId);
      const [row] = await tx.select({ bulletStock: locations.bulletStock }).from(locations).where(eq(locations.id, locationId));
      await tx.update(locations).set({ bulletStock: row!.bulletStock - 5 }).where(eq(locations.id, locationId));
    });

    await Promise.all([decrement(), decrement()]);
    const [final] = await db.select({ bulletStock: locations.bulletStock }).from(locations).where(eq(locations.id, locationId));
    expect(final?.bulletStock).toBe(0); // both decrements applied in sequence, never lost
  });
});
