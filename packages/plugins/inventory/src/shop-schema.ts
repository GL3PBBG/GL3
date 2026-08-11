import { bigint, integer, pgTable, primaryKey, uuid } from "drizzle-orm/pg-core";

/**
 * This plugin's own table — the first one `inventory` owns, declared in the
 * manifest `tables` map and created by `migrations.ts`.
 *
 * No foreign keys, deliberately (NOTES.md rule 6, spec §4.1): an FK to
 * `locations` or `items` would make every stock write take FOR KEY SHARE on
 * those rows. The buy handler already holds the `locations` row FOR UPDATE and
 * is about to take `player_stats`, so a `locations` FK is redundant lock
 * traffic on a row it already owns, and an `items` FK adds a lock edge to a
 * table nothing else locks. FK-free, this table adds no lock edges at all and
 * cannot participate in any cycle. The accepted cost is orphan rows when an
 * item or location is deleted; the listing query inner-joins `items`, so an
 * orphan is invisible to players.
 */
export const shopStock = pgTable(
  "p_inventory_shop_stock",
  {
    locationId: uuid("location_id").notNull(),
    itemId: uuid("item_id").notNull(),
    // bigint because it is money. A default here would have to be written
    // `` .default(sql`0`) `` — `.default(0n)` crashes drizzle-kit's serialiser.
    price: bigint("price", { mode: "bigint" }).notNull(),
    stock: integer("stock").notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.locationId, t.itemId] }) }),
);
