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
    // The `p_<id>_` prefix rule used to be enforced only for manifest-DECLARED
    // tables (plugins/validate.ts), so a table created inside a migration
    // escaped it — houses' `p_houses` and jobs' `p_player_jobs` shipped that
    // way (renamed since, by append-only rename migrations). The runner now
    // snapshots the catalog around each plugin's migration RUN and refuses a
    // boot that leaves a stray name behind. The check is end-of-plugin, not
    // per-migration, deliberately: append-only history means a legacy CREATE
    // under a bad name followed by its rename must stay legal on a fresh
    // install — only the plugin's FINAL state is the contract. Lazy snapshot:
    // a boot where every migration is already tracked runs zero catalog
    // queries.
    const prefix = `p_${manifest.id.replaceAll("-", "_")}_`;
    let before: Set<string> | undefined;

    for (const migration of manifest.migrations) {
      const key = await db.transaction(async (tx) => {
        const claimed = await tx
          .insert(pluginMigrations)
          .values({ pluginId: manifest.id, name: migration.name })
          .onConflictDoNothing()
          .returning({ name: pluginMigrations.name });
        if (claimed.length === 0) return undefined;

        before ??= await publicTables(tx);

        // sql.raw is correct here and nowhere else in this codebase: the string
        // is plugin-authored DDL from a manifest resolved at boot, not a value
        // from a request. Nothing player-supplied can reach it.
        await tx.execute(sql.raw(migration.sql));
        return `${manifest.id}:${migration.name}`;
      });
      if (key !== undefined) applied.push(key);
    }

    if (before !== undefined) {
      const beforeSet = before;
      const after = await publicTables(db);
      const strays = [...after].filter((t) => !beforeSet.has(t) && !t.startsWith(prefix));
      if (strays.length > 0) {
        throw new Error(
          `plugin "${manifest.id}" migrations leave table(s) ${strays.map((t) => `"${t}"`).join(", ")} ` +
            `outside its prefix — plugin tables must be named ${prefix}*`,
        );
      }
    }
  }
  return applied;
}

async function publicTables(tx: { execute: Db["execute"] }): Promise<Set<string>> {
  const rows = await tx.execute<{ table_name: string }>(
    sql`select table_name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'`,
  );
  return new Set(rows.map((r) => r.table_name));
}
