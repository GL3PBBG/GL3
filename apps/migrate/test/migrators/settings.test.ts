import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { createDb } from "../../../server/src/db/client.js";
import { settings } from "../../../server/src/db/schema/index.js";
import { createIsolatedMysqlFixture, createIsolatedPgTarget } from "../helpers/fixtures.js";
import { createReport } from "../../src/report.js";
import { migrateSettings } from "../../src/migrators/settings.js";

describe("migrateSettings", () => {
  it("migrates key/value settings verbatim and stays idempotent on re-run", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    try {
      const pool = mysql.createPool(fixture.url);
      const { db, sql } = createDb(target.url);

      await migrateSettings(pool, db, createReport(false));
      await migrateSettings(pool, db, createReport(false)); // re-run

      const rows = await db.select().from(settings);
      expect(rows).toHaveLength(9);
      expect(rows.find((r) => r.key === "gangName")?.value).toBe("Family");

      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });

  it("renames V2's six flat bullet keys into the bullets namespace", async () => {
    // `ctx.settings.get` resolves `bullets.<key>`, so a verbatim copy would
    // leave every one of these unreadable and silently revert an operator's
    // tuning to the built-in defaults.
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    try {
      const pool = mysql.createPool(fixture.url);
      const { db, sql } = createDb(target.url);

      await migrateSettings(pool, db, createReport(false));
      await migrateSettings(pool, db, createReport(false)); // re-run

      const rows = await db.select().from(settings);
      const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      expect(byKey).toMatchObject({
        "bullets.stock_min_per_hour": "1000",
        "bullets.stock_max_per_hour": "1500",
        "bullets.max_stock": "25000",
        "bullets.max_cost": "900",
        "bullets.max_buy": "250",
        // Carried over as-is: a stale cursor is bounded by the 12-hour clamp.
        "bullets.last_restock": "1420070400",
      });
      // The flat originals are gone, not duplicated.
      expect(byKey["maxBulletCost"]).toBeUndefined();
      expect(byKey["bulletsStockMinPerHour"]).toBeUndefined();

      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });
});
