import { LeaderboardResponseSchema } from "@gl3/shared";
import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { beforeEach, describe, expect, it } from "vitest";
import { players, playerStats, roundEntries, rounds } from "../src/db/schema/index.js";
import { roundStandings } from "../src/game/rounds/standings.js";
import { resetDb, testDb } from "./helpers/db.js";

const { db } = testDb();

async function seedPlayer(username: string): Promise<string> {
  const id = uuidv7();
  await db.insert(players).values({ id, username });
  await db.insert(playerStats).values({ playerId: id });
  return id;
}

async function seedRound(name: string): Promise<string> {
  const id = uuidv7();
  await db.insert(rounds).values({
    id, name,
    startsAt: new Date(Date.now() - 60_000),
    endsAt: new Date(Date.now() + 3_600_000),
  });
  return id;
}

beforeEach(async () => { await resetDb(db); });

describe("round_entries schema", () => {
  it("stores an entry with zero defaults and null final_* columns", async () => {
    const roundId = await seedRound("Schema Round");
    const playerId = await seedPlayer("schema_one");

    await db.insert(roundEntries).values({ roundId, playerId });

    const [row] = await db.select().from(roundEntries).where(eq(roundEntries.playerId, playerId));
    expect(row).toBeDefined();
    expect(row!.expAtStart).toBe(0n);
    expect(row!.cashAtStart).toBe(0n);
    expect(row!.bankAtStart).toBe(0n);
    expect(row!.finalExp).toBeNull();
    expect(row!.finalCash).toBeNull();
    expect(row!.finalBank).toBeNull();
    expect(row!.joinedAt).toBeInstanceOf(Date);
  });

  it("rejects a duplicate (round_id, player_id) pair", async () => {
    const roundId = await seedRound("Dup Round");
    const playerId = await seedPlayer("schema_two");
    await db.insert(roundEntries).values({ roundId, playerId });
    await expect(db.insert(roundEntries).values({ roundId, playerId })).rejects.toThrow();
  });

  it("carries the two new rounds stamps, both null on insert", async () => {
    const roundId = await seedRound("Stamp Round");
    const [row] = await db.select().from(rounds).where(eq(rounds.id, roundId));
    expect(row!.finalizedAt).toBeNull();
    expect(row!.snapshottedAt).toBeNull();
  });
});

async function seedEntry(
  roundId: string, playerId: string,
  start: { exp: bigint; cash: bigint; bank: bigint },
  final?: { exp: bigint; cash: bigint; bank: bigint },
): Promise<void> {
  await db.insert(roundEntries).values({
    roundId, playerId,
    expAtStart: start.exp, cashAtStart: start.cash, bankAtStart: start.bank,
    finalExp: final?.exp ?? null, finalCash: final?.cash ?? null, finalBank: final?.bank ?? null,
  });
}

async function setStats(playerId: string, v: { exp: bigint; cash: bigint; bank: bigint }): Promise<void> {
  await db.update(playerStats).set({ exp: v.exp, cash: v.cash, bank: v.bank })
    .where(eq(playerStats.playerId, playerId));
}

describe("roundStandings", () => {
  it("ranks a live board on current minus start", async () => {
    const roundId = await seedRound("Live");
    const a = await seedPlayer("live_a");
    const b = await seedPlayer("live_b");
    await seedEntry(roundId, a, { exp: 100n, cash: 0n, bank: 0n });
    await seedEntry(roundId, b, { exp: 0n, cash: 0n, bank: 0n });
    await setStats(a, { exp: 150n, cash: 0n, bank: 0n });   // +50
    await setStats(b, { exp: 400n, cash: 0n, bank: 0n });   // +400

    const board = await roundStandings(db, roundId, "exp", 10, false);
    expect(board.map((e) => [e.playerId, e.score, e.rank])).toEqual([
      [b, "400", 1],
      [a, "50", 2],
    ]);
    expect(board[0]!.username).toBe("live_b");
  });

  it("freezes a finalized board against later player_stats movement", async () => {
    const roundId = await seedRound("Frozen");
    const a = await seedPlayer("frozen_a");
    const b = await seedPlayer("frozen_b");
    await seedEntry(roundId, a, { exp: 0n, cash: 10n, bank: 5n }, { exp: 90n, cash: 40n, bank: 25n });
    await seedEntry(roundId, b, { exp: 0n, cash: 0n, bank: 0n }, { exp: 10n, cash: 0n, bank: 0n });

    // Capture the frozen board for all three kinds BEFORE moving player_stats,
    // then assert it is unchanged by that movement — that is what "frozen" means.
    const snapshot = {
      exp: await roundStandings(db, roundId, "exp", 10, true),
      cash: await roundStandings(db, roundId, "cash", 10, true),
      bank: await roundStandings(db, roundId, "bank", 10, true),
    };

    await setStats(a, { exp: 999_999n, cash: 999_999n, bank: 999_999n });
    await setStats(b, { exp: 999_999n, cash: 999_999n, bank: 999_999n });

    for (const kind of ["exp", "cash", "bank"] as const) {
      expect(await roundStandings(db, roundId, kind, 10, true)).toEqual(snapshot[kind]);
    }
    expect(snapshot.cash[0]).toMatchObject({ playerId: a, score: "30", rank: 1 });
  });

  it("scores a final_*-NULL entry in a finalized round as zero, not NULL", async () => {
    const roundId = await seedRound("Raced");
    const raced = await seedPlayer("raced_one");
    await seedEntry(roundId, raced, { exp: 77n, cash: 5n, bank: 5n });   // no final_*
    const board = await roundStandings(db, roundId, "exp", 10, true);
    expect(board).toHaveLength(1);
    expect(board[0]!.score).toBe("0");
  });

  it("renders negative cash deltas and sorts them below every positive one", async () => {
    const roundId = await seedRound("Spender");
    const spender = await seedPlayer("spender");
    const saver = await seedPlayer("saver");
    await seedEntry(roundId, spender, { exp: 0n, cash: 500n, bank: 0n });
    await seedEntry(roundId, saver, { exp: 0n, cash: 0n, bank: 0n });
    await setStats(spender, { exp: 0n, cash: 450n, bank: 0n });   // -50
    await setStats(saver, { exp: 0n, cash: 20n, bank: 0n });      // +20

    const entries = await roundStandings(db, roundId, "cash", 10, false);
    expect(entries.map((e) => e.score)).toEqual(["20", "-50"]);
    expect(LeaderboardResponseSchema.parse({ kind: "cash", entries })).toBeTruthy();
  });

  it("keeps exp non-negative given only exp credits", async () => {
    const roundId = await seedRound("Monotonic");
    const p = await seedPlayer("monotonic");
    await seedEntry(roundId, p, { exp: 10n, cash: 0n, bank: 0n });
    await setStats(p, { exp: 60n, cash: 0n, bank: 0n });
    const board = await roundStandings(db, roundId, "exp", 10, false);
    expect(BigInt(board[0]!.score) >= 0n).toBe(true);
  });

  it("breaks ties deterministically across ten identical queries", async () => {
    const roundId = await seedRound("Tied");
    const a = await seedPlayer("tie_a");
    const b = await seedPlayer("tie_b");
    const c = await seedPlayer("tie_c");
    for (const id of [a, b, c]) {
      await seedEntry(roundId, id, { exp: 0n, cash: 0n, bank: 0n });
      await setStats(id, { exp: 42n, cash: 0n, bank: 0n });
    }
    const first = await roundStandings(db, roundId, "exp", 10, false);
    for (let i = 0; i < 9; i += 1) {
      expect(await roundStandings(db, roundId, "exp", 10, false)).toEqual(first);
    }
    expect(first.map((e) => e.playerId)).toEqual([a, b, c].sort());
  });

  it("respects the limit and does not pad a short population", async () => {
    const roundId = await seedRound("Short");
    const a = await seedPlayer("short_a");
    const b = await seedPlayer("short_b");
    await seedEntry(roundId, a, { exp: 0n, cash: 0n, bank: 0n });
    await seedEntry(roundId, b, { exp: 0n, cash: 0n, bank: 0n });
    await setStats(a, { exp: 9n, cash: 0n, bank: 0n });
    await setStats(b, { exp: 3n, cash: 0n, bank: 0n });

    expect(await roundStandings(db, roundId, "exp", 10, false)).toHaveLength(2);
    const capped = await roundStandings(db, roundId, "exp", 1, false);
    expect(capped.map((e) => e.rank)).toEqual([1]);
    expect(capped[0]!.playerId).toBe(a);
  });

  it("returns [] for a round with no entries", async () => {
    const roundId = await seedRound("Empty");
    expect(await roundStandings(db, roundId, "exp", 10, false)).toEqual([]);
    expect(await roundStandings(db, roundId, "exp", 10, true)).toEqual([]);
  });

  it("drops non-positive deltas when minDelta is supplied", async () => {
    const roundId = await seedRound("Filtered");
    const mover = await seedPlayer("filtered_mover");
    const idler = await seedPlayer("filtered_idler");
    await seedEntry(roundId, mover, { exp: 0n, cash: 0n, bank: 0n }, { exp: 5n, cash: 0n, bank: 0n });
    await seedEntry(roundId, idler, { exp: 0n, cash: 0n, bank: 0n }, { exp: 0n, cash: 0n, bank: 0n });

    const paid = await roundStandings(db, roundId, "exp", 10, true, 0n);
    expect(paid.map((e) => e.playerId)).toEqual([mover]);
  });
});
