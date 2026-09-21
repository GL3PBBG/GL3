import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import propertiesPlugin from "@gl3/plugin-properties";
import { locations } from "../src/db/schema/index.js";
import { seedVenueRows } from "../src/db/seed.js";
import { runPluginMigrations } from "../src/plugins/migrate.js";
import { resetDb, testDb } from "./helpers/db.js";

/**
 * First-boot venue seeding (spec 2026-09-21 town-venues §4). A venue exists
 * only where a `p_properties_properties` row does, so a fresh native game
 * would otherwise have none at all — seeding one state-run row per (town ×
 * declared type) keeps it looking exactly as it did before this cluster.
 *
 * The rule that matters most is the other one: it runs ONLY on an empty
 * table, so a game migrated from V2 (whose rows are the truth about which
 * towns have what) is never touched.
 *
 * `seedVenueRows` reads the plugin's table by name in raw SQL — core never
 * imports a plugin schema — so this file runs the properties migrations
 * itself, as every non-`bootTestServer` test that touches a p_* table must.
 */
const { db, sql: conn } = testDb();

/** Raw, by table name, for the same reason the seeder is: core owns no model
 *  of this table. */
async function venueRows(): Promise<{ locationId: string; pluginId: string; owner: string | null; cost: string }[]> {
  const rows = await db.execute(sql`
    select location_id, plugin_id, owner_player_id, cost, profit
      from p_properties_properties
     order by location_id, plugin_id
  `);
  return [...rows].map((r) => ({
    locationId: String(r.location_id),
    pluginId: String(r.plugin_id),
    owner: r.owner_player_id === null ? null : String(r.owner_player_id),
    cost: String(r.cost),
  }));
}

async function seedTown(name: string): Promise<string> {
  const id = uuidv7();
  await db.insert(locations).values({ id, name });
  return id;
}

beforeAll(async () => {
  await resetDb(db);
  await runPluginMigrations(db, [propertiesPlugin]);
});

beforeEach(async () => {
  await resetDb(db);
});

afterAll(async () => {
  await conn.end();
});

describe("seedVenueRows", () => {
  it("inserts one state-run row per town × declared type on an empty table", async () => {
    const a = await seedTown("Alpha");
    const b = await seedTown("Beta");

    await seedVenueRows(db, ["blackjack", "bullets"]);

    const rows = await venueRows();
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((r) => r.locationId))).toEqual(new Set([a, b]));
    expect(new Set(rows.map((r) => r.pluginId))).toEqual(new Set(["blackjack", "bullets"]));
    for (const row of rows) {
      expect(row.owner).toBeNull();
      expect(row.cost).toBe("0");
    }
  });

  it("inserts nothing on a second call — the table is no longer empty", async () => {
    await seedTown("Alpha");
    await seedVenueRows(db, ["blackjack"]);
    expect(await venueRows()).toHaveLength(1);

    await seedVenueRows(db, ["blackjack", "bullets"]);
    expect(await venueRows()).toHaveLength(1);
  });

  it("never touches a table that already has a row (the migrated-game rule)", async () => {
    const a = await seedTown("Alpha");
    await seedTown("Beta");
    // One hand-placed row, as a V2 import would leave: Alpha has a casino and
    // Beta has nothing, and seeding must not fill Beta in.
    await db.execute(sql`
      insert into p_properties_properties (id, location_id, plugin_id, owner_player_id, cost, profit)
      values (${uuidv7()}, ${a}, 'blackjack', null, 0, 0)
    `);

    await seedVenueRows(db, ["blackjack", "bullets"]);

    const rows = await venueRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ locationId: a, pluginId: "blackjack" });
  });

  it("inserts nothing when there are no towns, or no declared types", async () => {
    await seedVenueRows(db, ["blackjack"]);
    expect(await venueRows()).toEqual([]);

    await seedTown("Alpha");
    await seedVenueRows(db, []);
    expect(await venueRows()).toEqual([]);
  });
});
