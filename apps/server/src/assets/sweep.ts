import { and, eq, notExists, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { assets, entityAssets } from "../db/schema/index.js";
import type { StorageDriver } from "./driver.js";
import { findUnreferencedAssets } from "./service.js";

/** Same bound and same reason as the sentence sweeper's: a backlog drains over several passes. */
export const ASSET_SWEEP_BATCH_LIMIT = 100;

/**
 * An hour is long enough for an admin to pick a file, upload it and choose the
 * entity to bind it to, and short enough that a failed upload does not linger
 * for a day.
 */
export const ASSET_SWEEP_GRACE_SECONDS = 3600;

/**
 * Collect assets nothing references any more.
 *
 * This is what pays for `entity_assets` having no foreign key on `entity_id`.
 * That omission is deliberate — it is what keeps image bindings out of the lock
 * graph entirely (see `db/schema/assets.ts`) — and its price is orphan rows the
 * database will not clean up on its own. This does.
 *
 * The candidate SELECT takes no lock, matching the sentence sweeper: two
 * overlapping passes may pick the same row and the DELETE is the claim, with
 * `rowCount` telling us which pass won.
 *
 * Deletion order is database-then-object, the mirror of the upload path's
 * driver-then-database. Both orders are chosen so that a crash mid-way leaves
 * an unreferenced OBJECT rather than a row pointing at a missing one: here the
 * row is gone and the next pass no longer sees it, so the object leaks. That is
 * the acceptable direction — a leaked object costs storage, a dangling row
 * costs a broken image nobody can explain.
 */
export async function sweepUnreferencedAssets(
  db: Db,
  driver: StorageDriver,
  limit: number = ASSET_SWEEP_BATCH_LIMIT,
  graceSeconds: number = ASSET_SWEEP_GRACE_SECONDS,
): Promise<{ collected: string[] }> {
  const candidates = await findUnreferencedAssets(db, limit, graceSeconds);
  const collected: string[] = [];

  for (const candidate of candidates) {
    // The DELETE is the claim. A concurrent bind that raced in between is
    // caught here too: `entity_assets.asset_id` has ON DELETE cascade, so a
    // blind delete would take the fresh binding with it. Re-checking
    // `notExists` inside the delete is what stops that.
    const deleted = await db
      .delete(assets)
      .where(and(
        eq(assets.id, candidate.id),
        notExists(db.select({ one: sql`1` }).from(entityAssets).where(eq(entityAssets.assetId, assets.id))),
      ))
      .returning({ id: assets.id });
    if (deleted.length === 0) continue;

    // Another asset row may share this hash only if the unique index were
    // dropped; it cannot today, so removing the object once the row is gone is
    // safe.
    await driver.delete(candidate.sha256);
    collected.push(candidate.id);
  }

  return { collected };
}

/**
 * Drop `entity_assets` rows in the `core` scope whose entity no longer exists.
 *
 * Only the core scope, and that limit is structural rather than laziness: core
 * cannot enumerate a plugin's tables — "nothing in core may reach into a
 * plugin's tables, and the converse" — so it cannot know whether
 * `("theft", <uuid>, "car")` still points at a real car. Core DOES own `items`,
 * `locations` and `ranks`, so it can answer for its own three slots.
 *
 * A plugin that deletes an entity is responsible for the binding that pointed
 * at it. Until one does, the binding survives, the asset stays referenced, and
 * `sweepUnreferencedAssets` never collects it — a leak bounded by how often
 * plugin entities are deleted, which for game content is rarely and by hand.
 * Documented rather than papered over.
 */
export async function sweepOrphanedCoreBindings(db: Db): Promise<{ removed: number }> {
  const result = await db.execute(sql`
    DELETE FROM entity_assets ea
     WHERE ea.scope = 'core'
       AND (
         (ea.slot = 'item'     AND NOT EXISTS (SELECT 1 FROM items     t WHERE t.id = ea.entity_id))
      OR (ea.slot = 'location' AND NOT EXISTS (SELECT 1 FROM locations t WHERE t.id = ea.entity_id))
      OR (ea.slot = 'rank'     AND NOT EXISTS (SELECT 1 FROM ranks     t WHERE t.id = ea.entity_id))
       )
  `);
  // postgres-js returns the row list; its `count` carries the affected rows.
  return { removed: Number((result as unknown as { count?: number }).count ?? 0) };
}
