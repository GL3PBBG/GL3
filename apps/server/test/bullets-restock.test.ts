import { restockIfDue, type BulletSettings } from "@gl3/plugin-bullets";
import { asc, eq, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { locations, settings } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";

/**
 * `restockIfDue` is the port of V2's `bullets.inc.php::restock()`. It is
 * exercised directly against a real transaction rather than through
 * `GET /api/bullets/shop`, because its tunables arrive as an argument: driving
 * it through the route would need one `bootTestServer()` per settings
 * permutation (settings are a boot-time snapshot), which is what makes
 * `theft-chase.test.ts` the slowest file in the suite.
 */
const { db, sql: conn } = testDb();

const CURSOR = "bullets.last_restock";

const tunables = (over: Partial<BulletSettings> = {}): BulletSettings => ({
  stockMinPerHour: 100,
  stockMaxPerHour: 200,
  maxStock: 40000,
  maxCost: null,
  maxBuy: null,
  ...over,
});

/** The hour boundary Postgres itself is on — the same clock `restockIfDue` reads. */
async function thisHour(): Promise<number> {
  const rows = await db.execute<{ epoch: string }>(
    sql`select extract(epoch from date_trunc('hour', now()))::bigint as epoch`,
  );
  return Number(rows[0]?.epoch);
}

async function setCursor(hoursAgo: number): Promise<void> {
  const value = String(await thisHour() - hoursAgo * 3600);
  await db.insert(settings).values({ key: CURSOR, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } });
}

async function readCursor(): Promise<string | null> {
  const [row] = await db.select().from(settings).where(eq(settings.key, CURSOR));
  return row?.value ?? null;
}

async function stocks(): Promise<number[]> {
  const rows = await db.select({ stock: locations.bulletStock }).from(locations).orderBy(asc(locations.id));
  return rows.map((r) => r.stock);
}

async function seedLocations(count: number, stock = 0): Promise<void> {
  for (let i = 0; i < count; i++) {
    await db.insert(locations).values({
      id: uuidv7(), name: `Town ${i}`, travelCost: 0n, travelCooldownSeconds: 0,
      bulletStock: stock, bulletCost: 5n,
    });
  }
}

const run = async (over: Partial<BulletSettings> = {}) =>
  db.transaction(async (tx) => restockIfDue(tx, tunables(over)));

beforeEach(async () => { await resetDb(db); });
afterAll(async () => { await conn.end(); });

describe("restockIfDue", () => {
  it("adds between hours*min and hours*max to every location", async () => {
    await seedLocations(3);
    await setCursor(3);

    const result = await run();

    expect(result.restocked).toBe(true);
    expect(result.hours).toBe(3);
    for (const stock of await stocks()) {
      expect(stock).toBeGreaterThanOrEqual(3 * 100);
      expect(stock).toBeLessThanOrEqual(3 * 200);
    }
  });

  it("clamps the catch-up at 12 hours however stale the cursor is", async () => {
    await seedLocations(1);
    await setCursor(30);

    const result = await run();

    expect(result.hours).toBe(12);
    expect(await stocks()).toEqual([expect.any(Number)]);
    expect((await stocks())[0]).toBeLessThanOrEqual(12 * 200);
  });

  it("does nothing inside the same hour, leaving the cursor untouched", async () => {
    await seedLocations(2, 77);
    await setCursor(0);
    const before = await readCursor();

    const result = await run();

    expect(result.restocked).toBe(false);
    expect(result.hours).toBe(0);
    expect(await stocks()).toEqual([77, 77]);
    expect(await readCursor()).toBe(before);
  });

  it("never lifts a location above max_stock", async () => {
    await seedLocations(1, 39990);
    await setCursor(12);

    await run({ maxStock: 40000 });

    expect((await stocks())[0]).toBe(40000);
  });

  it("caps a location that was already over max_stock rather than adding to it", async () => {
    // V2's second statement: UPDATE locations SET L_bullets = $max WHERE L_bullets > $max.
    await seedLocations(1, 50000);
    await setCursor(1);

    await run({ maxStock: 40000 });

    expect((await stocks())[0]).toBe(40000);
  });

  it("treats a missing cursor row as a fresh install and stamps one", async () => {
    await seedLocations(1);

    const result = await run();

    expect(result.restocked).toBe(true);
    expect(result.hours).toBe(12); // epoch 0 is more than 12 hours ago
    expect(await readCursor()).toBe(String(await thisHour()));
  });

  it("advances the cursor to the hour boundary, not to now", async () => {
    await seedLocations(1);
    await setCursor(5);

    await run();

    expect(await readCursor()).toBe(String(await thisHour()));
  });

  it("restocks once when several transactions race, not once each", async () => {
    // The advisory lock plus the re-read under it is what makes this hold:
    // without the re-read, all four would pass the unlocked check and each
    // would add its own draw.
    await seedLocations(1);
    await setCursor(2);

    const results = await Promise.all([run(), run(), run(), run()]);

    expect(results.filter((r) => r.restocked)).toHaveLength(1);
    expect((await stocks())[0]).toBeLessThanOrEqual(2 * 200);
  });
});
