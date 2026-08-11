/**
 * Two migrations, not one, and this is a deliberate deviation from the design
 * doc's §4.2: `runPluginMigrations` issues exactly one
 * `tx.execute(sql.raw(migration.sql))` per declared migration, and postgres.js
 * rejects a multi-statement string through `unsafe()` unless `.simple()` is
 * used. So the DDL and the seed are separate declarations.
 *
 * The seed joins core content BY NAME because `seedItems`/`seedLocations`
 * generate their ids with uuidv7 — nothing may hardcode one. In production
 * `apps/server/src/index.ts` runs both seeders before `loadPlugins`, so a
 * fresh install has both starter items for sale in all three cities.
 *
 * Where the seeds have NOT run the SELECT matches nothing and the migration is
 * a no-op that still records itself in `plugin_migrations` — meaning it will
 * not retry later. That is correct for tests, which insert their own stock
 * rows, and it is stated here so nobody expects a backfill.
 */
export const SHOP_MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "0001_shop_stock",
    sql: `CREATE TABLE p_inventory_shop_stock (
      location_id uuid    NOT NULL,
      item_id     uuid    NOT NULL,
      price       bigint  NOT NULL,
      stock       integer NOT NULL,
      PRIMARY KEY (location_id, item_id)
    )`,
  },
  {
    name: "0002_shop_stock_seed",
    // Prices are placeholders. Balance numbers are out of scope, exactly as
    // they were for combat; the intent is only that a weapon costs
    // meaningfully more than a heal.
    sql: `INSERT INTO p_inventory_shop_stock (location_id, item_id, price, stock)
    SELECT l.id, i.id, v.price, v.stock
    FROM (VALUES ('Rusty Pistol', 2500::bigint, 10), ('First Aid Kit', 500::bigint, 25))
           AS v(name, price, stock)
    JOIN items i ON i.name = v.name
    CROSS JOIN locations l
    ON CONFLICT (location_id, item_id) DO NOTHING`,
  },
];
