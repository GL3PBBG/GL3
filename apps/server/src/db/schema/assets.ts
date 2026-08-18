import { sql } from "drizzle-orm";
import { integer, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * A stored image. `sha256` IS the storage key — the blob is content-addressed,
 * which buys three things for free:
 *
 *  - dedup: the same art bound to two entities is one stored object, and a
 *    re-upload of identical bytes returns the existing row rather than a second
 *    one;
 *  - cache-busting: different bytes are a different key, so an `immutable`
 *    Cache-Control header on the serve route is correct by construction and can
 *    never go stale;
 *  - no rename/overwrite problem, because a key's content cannot change.
 *
 * `width`/`height` are parsed out of the file header at upload (a pure-TS
 * reader — this project takes no native image dependency) and stored so a
 * renderer can reserve the box before the bytes arrive.
 *
 * `uploaded_by` is nullable and carries NO foreign key to `players`. A FK is a
 * lock (NOTES.md rule 6) and this column is provenance only — nothing reads it
 * on any gameplay path, and a deleted admin must not cascade away the art they
 * uploaded.
 */
export const assets = pgTable("assets", {
  id: uuid("id").primaryKey(),
  sha256: text("sha256").notNull(),
  mime: text("mime").notNull(),
  bytes: integer("bytes").notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  uploadedBy: uuid("uploaded_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
}, (t) => ({ sha: uniqueIndex("assets_sha256_key").on(t.sha256) }));

/**
 * Which asset is bound to which entity slot. `scope` is a plugin id, or the
 * literal `"core"` for the core-owned tables plugins read but do not own
 * (`items`, `locations`, `ranks`).
 *
 * **There is deliberately no foreign key on `entity_id`**, and that is the
 * entire reason this table exists instead of an `asset_id` column on each
 * entity table. A per-entity column would cost a migration for every plugin
 * that ever wants an image, and — worse — a new foreign key from each plugin
 * table into a core table. A foreign key is a lock: inserting a row whose FK
 * references another takes `FOR KEY SHARE` on it, which conflicts with
 * `FOR UPDATE`, and no lock call appears in the code for a reader to find. Two
 * deadlocks have already shipped here from exactly that (see NOTES.md rule 6).
 * This design adds ZERO edges into any plugin table; the one new FK below is
 * core-to-core, on a table no gameplay path locks.
 *
 * The price is no referential integrity on `entity_id`: deleting an entity
 * leaves an orphan row here. That is the sweeper's job, not the database's.
 */
export const entityAssets = pgTable("entity_assets", {
  scope: text("scope").notNull(),
  entityId: uuid("entity_id").notNull(),
  slot: text("slot").notNull(),
  assetId: uuid("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
  boundAt: timestamp("bound_at", { withTimezone: true }).notNull().default(sql`now()`),
}, (t) => ({ pk: primaryKey({ columns: [t.scope, t.entityId, t.slot] }) }));
