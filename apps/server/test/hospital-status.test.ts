import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { players, playerStats, ranks } from "../src/db/schema/index.js";
import { checkHospital, maxHealthFor, sendToHospital, settleHospital } from "../src/game/hospital/status.js";
import { testDb } from "./helpers/db.js";

async function makePlayer(db: Awaited<ReturnType<typeof testDb>>["db"], opts?: { rankMaxHealth?: number }) {
  const id = uuidv7();
  // uuidv7's first 8 hex chars are pure timestamp bits (unchanged for ~65s),
  // so slicing from the front collides across the inserts this file makes in
  // a single fast run. Slice from the random tail instead.
  await db.insert(players).values({ id, username: `hp-${id.slice(-8)}` });
  let rankId: string | null = null;
  if (opts?.rankMaxHealth !== undefined) {
    rankId = uuidv7();
    await db.insert(ranks).values({
      id: rankId, name: `r-${rankId.slice(-8)}`, expRequired: 0n, maxHealth: opts.rankMaxHealth,
    });
  }
  await db.insert(playerStats).values({ playerId: id, health: 100, rankId });
  return id;
}

describe("hospital status", () => {
  it("reports a free player as not hospitalised", async () => {
    const { db } = await testDb();
    const id = await makePlayer(db);
    expect(await checkHospital(db, id)).toEqual({ hospitalised: false, until: null, remainingSeconds: 0 });
  });

  it("sendToHospital zeroes health and sets the deadline", async () => {
    const { db } = await testDb();
    const id = await makePlayer(db);

    const until = await db.transaction((tx) => sendToHospital(tx, id, 300));

    const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, id));
    expect(row?.health).toBe(0);
    expect(row?.hospitalUntil?.getTime()).toBe(until.getTime());

    const status = await checkHospital(db, id);
    expect(status.hospitalised).toBe(true);
    expect(status.remainingSeconds).toBeGreaterThan(290);
  });

  it("settleHospital leaves a live sentence alone", async () => {
    const { db } = await testDb();
    const id = await makePlayer(db);
    await db.transaction((tx) => sendToHospital(tx, id, 300));

    const status = await db.transaction((tx) => settleHospital(tx, id));

    expect(status.hospitalised).toBe(true);
    const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, id));
    expect(row?.health).toBe(0);
  });

  it("settleHospital restores full health once the sentence has elapsed", async () => {
    const { db } = await testDb();
    const id = await makePlayer(db, { rankMaxHealth: 140 });
    await db.update(playerStats)
      .set({ health: 0, hospitalUntil: new Date(Date.now() - 1000) })
      .where(eq(playerStats.playerId, id));

    const status = await db.transaction((tx) => settleHospital(tx, id));

    expect(status).toEqual({ hospitalised: false, until: null, remainingSeconds: 0 });
    const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, id));
    expect(row?.health).toBe(140);
    expect(row?.hospitalUntil).toBeNull();
  });

  it("maxHealthFor falls back to 100 when the player has no rank", async () => {
    const { db } = await testDb();
    const id = await makePlayer(db);
    expect(await db.transaction((tx) => maxHealthFor(tx, id))).toBe(100);
  });

  it("maxHealthFor reads the rank's max_health", async () => {
    const { db } = await testDb();
    const id = await makePlayer(db, { rankMaxHealth: 175 });
    expect(await db.transaction((tx) => maxHealthFor(tx, id))).toBe(175);
  });
});
