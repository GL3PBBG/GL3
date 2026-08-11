import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { testDb } from "./helpers/db.js";

describe("combat_log schema", () => {
  it("has the expected columns and types", async () => {
    const { db } = await testDb();
    const rows = await db.execute(sql`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'combat_log'
      ORDER BY column_name
    `);
    const byName = Object.fromEntries(
      rows.map((r) => [String(r.column_name), { type: String(r.data_type), nullable: r.is_nullable === "YES" }]),
    );

    expect(byName).toMatchObject({
      id: { type: "uuid", nullable: false },
      attacker_id: { type: "uuid", nullable: false },
      target_id: { type: "uuid", nullable: false },
      hit: { type: "boolean", nullable: false },
      damage: { type: "integer", nullable: false },
      fatal: { type: "boolean", nullable: false },
      weapon_item_id: { type: "uuid", nullable: true },
      payout: { type: "bigint", nullable: false },
      created_at: { type: "timestamp with time zone", nullable: false },
    });
  });

  it("has no location_id column (rule 6: a locations FK would invert the lock order)", async () => {
    const { db } = await testDb();
    const rows = await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'combat_log' AND column_name = 'location_id'
    `);
    expect(rows).toHaveLength(0);
  });

  it("indexes both participant columns for the log reads", async () => {
    const { db } = await testDb();
    const rows = await db.execute(sql`
      SELECT indexname FROM pg_indexes WHERE tablename = 'combat_log'
    `);
    const names = rows.map((r) => String(r.indexname));
    expect(names).toContain("combat_log_target_idx");
    expect(names).toContain("combat_log_attacker_idx");
  });
});
