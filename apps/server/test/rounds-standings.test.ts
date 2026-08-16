import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { beforeEach, describe, expect, it } from "vitest";
import { players, playerStats, roundEntries, rounds } from "../src/db/schema/index.js";
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
