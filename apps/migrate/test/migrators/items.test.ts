import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { createDb } from "../../../server/src/db/client.js";
import { items } from "../../../server/src/db/schema/index.js";
import { createIsolatedMysqlFixture, createIsolatedPgTarget } from "../helpers/fixtures.js";
import { createReport } from "../../src/report.js";
import { migrateItems } from "../../src/migrators/items.js";

describe("migrateItems", () => {
  it("merges itemEffects and itemMeta into JSONB effects/meta, dropping the orphan effect row", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    try {
      const pool = mysql.createPool(fixture.url);
      const { db, sql } = createDb(target.url);
      const report = createReport(false);

      await migrateItems(pool, db, report);

      const rows = await db.select().from(items);
      expect(rows).toHaveLength(2);
      const bat = rows.find((i) => i.name === "Baseball Bat");
      // I_type 1 resolves through the itemTypes settings registry to "weapon".
      expect(bat?.itemType).toBe("weapon");
      expect(bat?.effects).toEqual({ damage: 15 });
      expect(bat?.meta).toEqual({ rarity: "common" });
      const vest = rows.find((i) => i.name === "Kevlar Vest");
      expect(vest?.itemType).toBe("armor");
      expect(vest?.effects).toEqual({ armor: 20 });
      expect(vest?.meta).toEqual({});

      expect(report.orphans).toContainEqual({ table: "itemEffects", v2Id: 99, reason: "item 99 does not exist" });

      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });
});
