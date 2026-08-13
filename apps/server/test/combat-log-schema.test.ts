import combatPlugin from "@gl3/plugin-combat";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runPluginMigrations } from "../src/plugins/migrate.js";
import { testDb } from "./helpers/db.js";

// testDb() returns { db, sql } — createDb's pair. Destructured once at module
// scope and closed once, as plugin-migrate.test.ts:13 does; the previous shape
// called testDb() inside each `it` and left three connections open.
const { db, sql: conn } = testDb();

afterAll(async () => {
  await conn.end();
});

/**
 * `p_combat_log` is owned by the combat plugin, not core — core relinquished
 * it (as `combat_log`) in `0007_relinquish_plugin_tables`. The test template
 * database is built from core migrations only (helpers/global-setup.ts:47),
 * so this file has to run the plugin's own migrations before the table exists.
 * That is the whole reason for the beforeAll: without it every assertion here
 * would pass vacuously against an absent table (`information_schema` returns
 * zero rows, `toMatchObject` on `{}` against `{}`), which is exactly the
 * failure mode the "no location_id" case below is shaped like.
 */
describe("p_combat_log schema", () => {
  beforeAll(async () => {
    await runPluginMigrations(db, [combatPlugin]);
  });

  it("creates the table at all (guards the vacuous-pass shape below)", async () => {
    const rows = await db.execute(sql`
      SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'p_combat_log'
    `);
    expect(rows).toHaveLength(1);
  });

  it("has the expected columns and types", async () => {
    const rows = await db.execute(sql`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'p_combat_log'
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
    const rows = await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'p_combat_log' AND column_name = 'location_id'
    `);
    expect(rows).toHaveLength(0);
  });

  it("indexes both participant columns for the log reads", async () => {
    const rows = await db.execute(sql`
      SELECT indexname FROM pg_indexes WHERE tablename = 'p_combat_log'
    `);
    const names = rows.map((r) => String(r.indexname));
    expect(names).toContain("p_combat_log_target_idx");
    expect(names).toContain("p_combat_log_attacker_idx");
  });

  /**
   * The FKs moved with the table (see the plugin's migrations.ts for why they
   * were kept where p_inventory_shop_stock and p_oc_* have none). Pinning them
   * here is what makes "keeping them" a decision the suite defends rather than
   * an accident of the DDL: dropping one would silently start leaving orphan
   * log rows behind deleted players.
   */
  it("keeps the two players FKs and the items FK the move carried over", async () => {
    const rows = await db.execute<{ column_name: string; delete_rule: string; foreign_table_name: string }>(sql`
      SELECT kcu.column_name, rc.delete_rule, ccu.table_name AS foreign_table_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = tc.constraint_name
      JOIN information_schema.referential_constraints rc
        ON rc.constraint_name = tc.constraint_name
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
      WHERE tc.table_name = 'p_combat_log' AND tc.constraint_type = 'FOREIGN KEY'
    `);
    const byColumn = Object.fromEntries(
      rows.map((r) => [r.column_name, { to: r.foreign_table_name, onDelete: r.delete_rule }]),
    );

    expect(byColumn).toEqual({
      attacker_id: { to: "players", onDelete: "CASCADE" },
      target_id: { to: "players", onDelete: "CASCADE" },
      weapon_item_id: { to: "items", onDelete: "SET NULL" },
    });
  });
});
