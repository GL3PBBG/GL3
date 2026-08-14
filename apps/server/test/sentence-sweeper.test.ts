import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { testDb } from "./helpers/db.js";

const { db, sql: conn } = testDb();
afterAll(async () => { await conn.end(); });

describe("sentence expiry indexes", () => {
  it("indexes both expiry columns partially, so the sweep never seq-scans", async () => {
    const rows = await db.execute<{ indexname: string; indexdef: string }>(sql`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'player_stats'
        AND indexname IN ('player_stats_jailed_until_idx', 'player_stats_hospital_until_idx')
      ORDER BY indexname
    `);
    const found = [...rows].map((r) => r.indexname);
    expect(found).toEqual(["player_stats_hospital_until_idx", "player_stats_jailed_until_idx"]);
    // Partial, not full: the WHERE clause is the whole point.
    for (const row of rows) expect(row.indexdef.toLowerCase()).toContain("where");
  });
});
