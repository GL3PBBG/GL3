import type { PluginManifest } from "@gl3/plugin-sdk";
import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { pluginMigrations } from "../db/schema/index.js";

/**
 * Applies each plugin's migrations in plugin-id order (spec: Table ownership),
 * tracked in `plugin_migrations` so a re-boot applies nothing twice.
 *
 * The tracking row is inserted FIRST, inside the same transaction as the DDL —
 * the same shape as NOTES.md rule 1. Postgres has transactional DDL, so the
 * pair is atomic in both directions: a second concurrent boot blocks on the
 * primary key and then sees zero rows returned, and a failing migration rolls
 * the tracking row back with it.
 *
 * The key is pushed onto `applied` *after* `db.transaction` resolves, not from
 * inside the callback. The callback finishes before COMMIT is issued, so a
 * push from within it records a migration that a failing COMMIT then rolls
 * back — an entry for work that did not happen. Today that phantom is
 * unobservable, because a rejected transaction propagates out of this function
 * and the array is discarded unread; returning the key makes "in `applied`"
 * mean "committed" by construction rather than by that accident, which is what
 * keeps it true if a caller ever handles a partial failure instead.
 */
export async function runPluginMigrations(
  db: Db,
  manifests: readonly PluginManifest[],
): Promise<string[]> {
  const applied: string[] = [];
  const ordered = [...manifests].sort((a, b) => a.id.localeCompare(b.id));

  for (const manifest of ordered) {
    for (const migration of manifest.migrations) {
      const key = await db.transaction(async (tx) => {
        const claimed = await tx
          .insert(pluginMigrations)
          .values({ pluginId: manifest.id, name: migration.name })
          .onConflictDoNothing()
          .returning({ name: pluginMigrations.name });
        if (claimed.length === 0) return undefined;

        // sql.raw is correct here and nowhere else in this codebase: the string
        // is plugin-authored DDL from a manifest resolved at boot, not a value
        // from a request. Nothing player-supplied can reach it.
        await tx.execute(sql.raw(migration.sql));
        return `${manifest.id}:${migration.name}`;
      });
      if (key !== undefined) applied.push(key);
    }
  }
  return applied;
}
