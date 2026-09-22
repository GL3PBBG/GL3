import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import propertiesPlugin from "@gl3/plugin-properties";
import { locations, players } from "../src/db/schema/index.js";
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

/**
 * The upgrade seam. An already-running NATIVE game reaching this cluster is
 * indistinguishable from a migrated one — both have a non-empty table — and
 * the two want opposite things, so first-boot mode says what is missing and
 * `fill` closes it on demand. Nothing about the migrated-game rule changes:
 * `fill` is an explicit env var for one boot, and it still writes only rows
 * that are absent.
 */
describe("seedVenueRows upgrade modes", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("warns naming the gap on a non-empty table and inserts nothing", async () => {
    const a = await seedTown("Alpha");
    await seedTown("Beta");
    await db.execute(sql`
      insert into p_properties_properties (id, location_id, plugin_id, owner_player_id, cost, profit)
      values (${uuidv7()}, ${a}, 'blackjack', null, 0, 0)
    `);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await seedVenueRows(db, ["blackjack", "bullets"]);

    // Alpha/bullets, Beta/blackjack, Beta/bullets.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatchObject({ missing: 3 });
    expect(String(warn.mock.calls[0]![1])).toContain("SEED_VENUES=fill");
    expect(await venueRows()).toHaveLength(1);
  });

  it("stays silent on a non-empty table with every pair already present", async () => {
    const a = await seedTown("Alpha");
    await db.execute(sql`
      insert into p_properties_properties (id, location_id, plugin_id, owner_player_id, cost, profit)
      values (${uuidv7()}, ${a}, 'blackjack', null, 0, 0)
    `);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await seedVenueRows(db, ["blackjack"]);

    expect(warn).not.toHaveBeenCalled();
  });

  it("fills exactly the missing pairs, leaving an owned row untouched", async () => {
    const a = await seedTown("Alpha");
    const b = await seedTown("Beta");
    const ownerId = uuidv7();
    await db.insert(players).values({ id: ownerId, username: `owner-${ownerId.slice(0, 8)}` });
    // Alpha's casino is OWNED and priced: the fill must not reset either.
    await db.execute(sql`
      insert into p_properties_properties (id, location_id, plugin_id, owner_player_id, cost, profit)
      values (${uuidv7()}, ${a}, 'blackjack', ${ownerId}, 250, 900)
    `);
    vi.spyOn(console, "info").mockImplementation(() => {});

    await seedVenueRows(db, ["blackjack", "bullets"], "fill");

    const rows = await venueRows();
    expect(rows).toHaveLength(4);
    const alphaCasino = rows.find((r) => r.locationId === a && r.pluginId === "blackjack")!;
    expect(alphaCasino).toMatchObject({ owner: ownerId, cost: "250" });
    for (const row of rows.filter((r) => r !== alphaCasino)) {
      expect(row.owner).toBeNull();
      expect(row.cost).toBe("0");
    }
    expect(new Set(rows.map((r) => `${r.locationId}/${r.pluginId}`))).toEqual(new Set([
      `${a}/blackjack`, `${a}/bullets`, `${b}/blackjack`, `${b}/bullets`,
    ]));
  });

  it("is a no-op when fill finds nothing missing", async () => {
    const a = await seedTown("Alpha");
    await seedVenueRows(db, ["blackjack"]);
    const before = await venueRows();

    await seedVenueRows(db, ["blackjack"], "fill");

    expect(await venueRows()).toEqual(before);
    expect(before[0]).toMatchObject({ locationId: a, pluginId: "blackjack" });
  });

  it("fills a whole empty table the way a first boot would", async () => {
    const a = await seedTown("Alpha");
    const b = await seedTown("Beta");
    vi.spyOn(console, "info").mockImplementation(() => {});

    await seedVenueRows(db, ["blackjack", "bullets"], "fill");

    const rows = await venueRows();
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((r) => `${r.locationId}/${r.pluginId}`))).toEqual(new Set([
      `${a}/blackjack`, `${a}/bullets`, `${b}/blackjack`, `${b}/bullets`,
    ]));
    for (const row of rows) expect(row.owner).toBeNull();
  });
});
