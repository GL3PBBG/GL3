import inventoryPlugin from "@gl3/plugin-inventory";
import { definePlugin } from "@gl3/plugin-sdk";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { seedItems, seedLocations } from "../src/db/seed.js";
import { pluginMigrations } from "../src/db/schema/index.js";
import { runPluginMigrations } from "../src/plugins/migrate.js";
import { resetDb, testDb } from "./helpers/db.js";
import { pgErrorCode, rejectionOf } from "./helpers/pg-error.js";

// testDb() returns { db, sql } — createDb's pair, not a drizzle db. Destructure
// at module scope and close the connection once, as test/ledger.test.ts:12 does.
const { db, sql: conn } = testDb();

afterAll(async () => {
  await conn.end();
});

// No `beforeEach(resetDb)`: isolated-db.setup.ts gives this file its own
// database, and resetDb TRUNCATEs rather than DROPs, so it would not remove the
// tables these migrations create anyway. Each test uses its own plugin id and
// its own `p_<id>_` table prefix instead.
const plugin = (id: string, migrations: { name: string; sql: string }[]) =>
  definePlugin({ id, version: "1.0.0", basePaths: [`/api/${id}`], migrations });

describe("runPluginMigrations", () => {
  it("applies a migration once across two boots", async () => {
    const manifest = plugin("m1", [
      { name: "0001_init", sql: "CREATE TABLE p_m1_things (id text primary key)" },
    ]);
    expect(await runPluginMigrations(db, [manifest])).toEqual(["m1:0001_init"]);
    // Second boot: no re-apply. Without the tracking row this re-runs the DDL
    // and fails with 42P07 "relation already exists".
    expect(await runPluginMigrations(db, [manifest])).toEqual([]);
    await db.execute(sql`select 1 from p_m1_things limit 1`);
  });

  // Doubles as the complement of definePlugin's within-a-plugin uniqueness
  // refinement: "alpha" and "zeta" both declare a migration named "0001", and
  // both must apply, because the tracking PK is (plugin_id, name). A guard that
  // rejected the name globally would fail here.
  it("applies migrations in plugin-id order, then declaration order", async () => {
    const applied = await runPluginMigrations(db, [
      plugin("zeta", [{ name: "0001", sql: "CREATE TABLE p_zeta_a (id text)" }]),
      plugin("alpha", [
        { name: "0001", sql: "CREATE TABLE p_alpha_a (id text)" },
        { name: "0002", sql: "CREATE TABLE p_alpha_b (id text)" },
      ]),
    ]);
    expect(applied).toEqual(["alpha:0001", "alpha:0002", "zeta:0001"]);
  });

  // The prefix rule (`p_<id>_*`, hyphens as underscores) used to be checked
  // only for manifest-DECLARED tables (plugins/validate.ts), so a table
  // created in a migration escaped it — houses' `p_houses` and jobs'
  // `p_player_jobs` shipped exactly that way. The runner now diffs the table
  // catalog around each plugin's migration run and fails the boot on a stray
  // name. The check is end-of-plugin, so a legacy bad CREATE followed by its
  // append-only rename stays legal on a fresh install.
  it("refuses a migration run that leaves a table outside the plugin's prefix", async () => {
    const rogue = plugin("m4", [
      { name: "0001", sql: "CREATE TABLE wrong_prefix_things (id text)" },
    ]);
    const error = await rejectionOf(runPluginMigrations(db, [rogue]));
    expect(String(error)).toContain("m4");
    expect(String(error)).toContain("wrong_prefix_things");
    expect(String(error)).toContain("p_m4_");
  });

  it("maps a hyphenated plugin id onto an underscore prefix", async () => {
    const hyphenated = plugin("my-plug", [
      { name: "0001", sql: "CREATE TABLE p_my_plug_things (id text)" },
    ]);
    expect(await runPluginMigrations(db, [hyphenated])).toEqual(["my-plug:0001"]);
  });

  it("allows a transiently bad name that a later migration renames into the prefix", async () => {
    // The exact shape of houses/education/jobs after their rename migrations:
    // history keeps the original CREATE, the final state is compliant.
    const legacy = plugin("m6", [
      { name: "0001", sql: "CREATE TABLE badly_named (id text)" },
      { name: "0002", sql: "ALTER TABLE badly_named RENAME TO p_m6_things" },
    ]);
    expect(await runPluginMigrations(db, [legacy])).toEqual(["m6:0001", "m6:0002"]);
  });

  it("refuses a RENAME that leaves the plugin's prefix", async () => {
    const renamer = plugin("m5", [
      { name: "0001", sql: "CREATE TABLE p_m5_things (id text)" },
      { name: "0002", sql: "ALTER TABLE p_m5_things RENAME TO things_free" },
    ]);
    const error = await rejectionOf(runPluginMigrations(db, [renamer]));
    expect(String(error)).toContain("things_free");
  });

  it("rolls back the tracking row when the migration SQL fails", async () => {
    const broken = plugin("m3", [{ name: "0001", sql: "CREATE TABLE (((" }]);

    // Asserting the SQLSTATE, not merely that something threw: a bare
    // `.rejects.toThrow()` here also passes when `runPluginMigrations` fails
    // for a reason that has nothing to do with the migration SQL, and would
    // stay green with the transaction removed entirely.
    const error = await rejectionOf(runPluginMigrations(db, [broken]));
    expect(pgErrorCode(error)).toBe("42601"); // syntax_error

    // The rollback guarantee itself: the tracking row inserted before the DDL
    // must be gone, or a syntax error at boot would permanently mark a table
    // as created that never was.
    const rows = await db.select().from(pluginMigrations).where(eq(pluginMigrations.pluginId, "m3"));
    expect(rows).toEqual([]);

    // …and the retry must genuinely re-apply, not just report that it did.
    const fixed = plugin("m3", [{ name: "0001", sql: "CREATE TABLE p_m3_a (id text)" }]);
    expect(await runPluginMigrations(db, [fixed])).toEqual(["m3:0001"]);
    await db.execute(sql`select 1 from p_m3_a limit 1`);
  });
});

describe("inventory shop stock migrations", () => {
  it("creates the table and seeds one row per (location, seeded item), once", async () => {
    // The seed migration joins core content BY NAME because ids are uuidv7,
    // so the real seeders have to have run first — exactly the production
    // order in apps/server/src/index.ts (seed, then loadPlugins).
    await seedItems(db);
    await seedLocations(db);

    const applied = await runPluginMigrations(db, [inventoryPlugin]);
    expect(applied).toEqual(["inventory:0001_shop_stock", "inventory:0002_shop_stock_seed"]);

    const rows = await db.execute<{ name: string; price: string; stock: number }>(
      sql`select i.name, s.price::text as price, s.stock
          from p_inventory_shop_stock s
          join items i on i.id = s.item_id
          order by i.name`,
    );
    // 3 seeded locations x 2 seeded items.
    expect(rows.length).toBe(6);
    expect(rows.filter((r) => r.name === "Rusty Pistol")).toHaveLength(3);
    expect(rows[0]?.price).toBe("500");
    expect(rows[0]?.stock).toBe(25);

    // Second boot: the tracking rows mean neither migration re-runs, so the
    // seed does not double the stock rows.
    expect(await runPluginMigrations(db, [inventoryPlugin])).toEqual([]);
    const again = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from p_inventory_shop_stock`,
    );
    expect(again[0]?.n).toBe("6");
  });

  /**
   * Regression for the 42P07 combat.test.ts hit while diagnosing an unrelated
   * task: resetDb() (helpers/db.ts) TRUNCATEs every public table for test
   * isolation between test bodies, `plugin_migrations` included. TRUNCATE
   * empties the tracking row but leaves `p_inventory_shop_stock` standing —
   * plain `CREATE TABLE`, no `IF NOT EXISTS` (migrations.ts:21, deliberately;
   * see that file's comment) — so a second `runPluginMigrations` call (what
   * any test that reboots the server mid-file does) reran the DDL against a
   * table that was never dropped and threw `relation already exists`.
   *
   * The fix is in resetDb, not here: migration bookkeeping is not test data,
   * so it is preserved the same way `__drizzle_migrations` already is. This
   * test would 42P07 on that second `runPluginMigrations` call without it.
   */
  // This test calls resetDb inside the body (the thing under test), so it
  // pays resetDb's full TRUNCATE-CASCADE cost on top of two seeds and two
  // plugin-migration boots — too much for vitest's 5s default under full-suite
  // load.  Same budget the workspace already grants resetDb in hooks
  //  (dbHookTimeout).
  it("survives a resetDb() between boots without re-running a migration", async () => {
    await seedItems(db);
    await seedLocations(db);
    await runPluginMigrations(db, [inventoryPlugin]);

    const before = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from p_inventory_shop_stock`,
    );
    expect(before[0]?.n).toBe("6");

    await resetDb(db);

    // The tracking rows must have survived resetDb, so this must be a no-op
    // — not a re-application (which would 42P07 on the standing table) and
    // not silently swallowed data loss on plugin_migrations itself.
    expect(await runPluginMigrations(db, [inventoryPlugin])).toEqual([]);

    // resetDb DOES truncate p_inventory_shop_stock itself — it is game data,
    // not migration bookkeeping — and since the seed migration correctly did
    // NOT re-run, those rows do not silently come back. A test that needs
    // shop stock after a reset must seed it itself, exactly as shop.test.ts
    // already does via its own seedShop() helper rather than relying on the
    // migration seed.
    const afterReset = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from p_inventory_shop_stock`,
    );
    expect(afterReset[0]?.n).toBe("0");
  }, 30_000);
});
