import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { lockPlayersForUpdate } from "../src/economy/ledger.js";
import { syncRankToLevel } from "../src/economy/ranks.js";
import { players, playerStats, ranks, transactions } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";

const { db, sql: conn } = testDb();

// Ordinal ladder — five ranks ascending by exp_required, named R1..R5 by
// position. Only the ORDER matters for syncRankToLevel; exp_required values
// are otherwise arbitrary and never read by it directly.
let rankIds: string[] = []; // rankIds[0] = R1 (position 0) .. rankIds[4] = R5 (position 4)
let playerId: string;

const FIXTURE_HEALTH = 77;

beforeEach(async () => {
  await resetDb(db);

  rankIds = [];
  for (let i = 0; i < 5; i += 1) {
    const id = uuidv7();
    rankIds.push(id);
    await db.insert(ranks).values({
      id,
      name: `R${i + 1}`,
      expRequired: BigInt(i * 1000),
      cashReward: BigInt((i + 1) * 100),
      bulletReward: (i + 1) * 10,
      maxHealth: 100 + i * 25,
    });
  }

  playerId = uuidv7();
  await db.insert(players).values({ id: playerId, username: `sync${Date.now()}` });
  await db.insert(playerStats).values({
    playerId,
    cash: 0n,
    bullets: 0,
    health: FIXTURE_HEALTH,
    level: 0,
    rankId: null,
  });
});

afterAll(async () => { await conn.end(); });

const stampRank = async (rankId: string | null, level: number): Promise<void> => {
  await db.update(playerStats).set({ rankId, level }).where(eq(playerStats.playerId, playerId));
};

const readStats = async (): Promise<{ rankId: string | null; bullets: bigint; health: number }> => {
  const [row] = await db.select({ rankId: playerStats.rankId, bullets: playerStats.bullets, health: playerStats.health })
    .from(playerStats).where(eq(playerStats.playerId, playerId));
  if (!row) throw new Error("player_stats row missing");
  return row;
};

const rewardRows = async (): Promise<{ amount: bigint; refId: string | null }[]> =>
  db.select({ amount: transactions.amount, refId: transactions.refId })
    .from(transactions).where(eq(transactions.reason, "rank.reward"));

describe("syncRankToLevel", () => {
  it("promotes to the level-derived rank and pays its reward when pay=true", async () => {
    await stampRank(rankIds[1] as string, 3); // stored R2, level 3 → target R3 (position 2)

    const result = await db.transaction(async (tx) => {
      await lockPlayersForUpdate(tx, [playerId]);
      return syncRankToLevel(tx, playerId, { pay: true });
    });

    expect(result).not.toBeNull();
    expect(result?.rankId).toBe(rankIds[2]);

    const stats = await readStats();
    expect(stats.rankId).toBe(rankIds[2]);
    expect(stats.health).toBe(FIXTURE_HEALTH); // never touched

    const rows = await rewardRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.refId).toBe(rankIds[2]);
    expect(rows[0]?.amount).toBe(300n); // R3's cashReward = (2+1)*100

    expect(stats.bullets).toBe(30n); // R3's bulletReward = (2+1)*10
  });

  it("promotes without paying when pay=false", async () => {
    await stampRank(rankIds[1] as string, 3); // stored R2, level 3 → target R3

    const result = await db.transaction(async (tx) => {
      await lockPlayersForUpdate(tx, [playerId]);
      return syncRankToLevel(tx, playerId, { pay: false });
    });

    expect(result).toBeNull();

    const stats = await readStats();
    expect(stats.rankId).toBe(rankIds[2]);
    expect(stats.bullets).toBe(0n);

    const rows = await rewardRows();
    expect(rows).toHaveLength(0);
  });

  it("returns null and leaves rankId untouched at level 0", async () => {
    await stampRank(null, 0);

    const result = await db.transaction(async (tx) => {
      await lockPlayersForUpdate(tx, [playerId]);
      return syncRankToLevel(tx, playerId, { pay: true });
    });

    expect(result).toBeNull();
    const stats = await readStats();
    expect(stats.rankId).toBeNull();

    const rows = await rewardRows();
    expect(rows).toHaveLength(0);
  });

  it("returns null with no rows when the target equals the stored rank", async () => {
    await stampRank(rankIds[2] as string, 3); // stored R3, level 3 → target R3

    const result = await db.transaction(async (tx) => {
      await lockPlayersForUpdate(tx, [playerId]);
      return syncRankToLevel(tx, playerId, { pay: true });
    });

    expect(result).toBeNull();
    const stats = await readStats();
    expect(stats.rankId).toBe(rankIds[2]);

    const rows = await rewardRows();
    expect(rows).toHaveLength(0);
  });

  it("caps the target at the top of the ladder for a level past its length", async () => {
    await stampRank(rankIds[1] as string, 99); // stored R2, level 99 → capped at R5 (position 4)

    const result = await db.transaction(async (tx) => {
      await lockPlayersForUpdate(tx, [playerId]);
      return syncRankToLevel(tx, playerId, { pay: true });
    });

    expect(result).not.toBeNull();
    expect(result?.rankId).toBe(rankIds[4]);

    const stats = await readStats();
    expect(stats.rankId).toBe(rankIds[4]);
  });

  it("treats a NULL stored rank as position -1, paying the destination once", async () => {
    await stampRank(null, 2); // stored NULL (position -1), level 2 → target R2 (position 1)

    const result = await db.transaction(async (tx) => {
      await lockPlayersForUpdate(tx, [playerId]);
      return syncRankToLevel(tx, playerId, { pay: true });
    });

    expect(result).not.toBeNull();
    expect(result?.rankId).toBe(rankIds[1]);

    const stats = await readStats();
    expect(stats.rankId).toBe(rankIds[1]);

    const rows = await rewardRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.refId).toBe(rankIds[1]);
    expect(rows[0]?.amount).toBe(200n); // R2's cashReward = (1+1)*100
    expect(stats.bullets).toBe(20n); // R2's bulletReward = (1+1)*10
  });

  it("stamps a demotion-shaped move down with zero payout and returns null", async () => {
    await stampRank(rankIds[3] as string, 2); // stored R4 (position 3), level 2 → target R2 (position 1)

    const result = await db.transaction(async (tx) => {
      await lockPlayersForUpdate(tx, [playerId]);
      return syncRankToLevel(tx, playerId, { pay: true });
    });

    expect(result).toBeNull();

    const stats = await readStats();
    expect(stats.rankId).toBe(rankIds[1]); // still stamped down to R2
    expect(stats.bullets).toBe(0n);

    const rows = await rewardRows();
    expect(rows).toHaveLength(0);
  });
});
