import type mysql from "mysql2/promise";
import { settings } from "../../../server/src/db/schema/index.js";
import { bumpTable, type MigrationReport } from "../report.js";
import type { Executor } from "../pg/types.js";

// V2's settings table keys rows by the S_desc column (class/settings.php:
// SELECT ... WHERE S_desc = :desc) — S_desc is the key, S_value the value.
interface SettingRow { S_desc: string; S_value: string | null; }

/**
 * V2's settings are flat; GL3 namespaces every plugin setting as
 * `<pluginId>.<key>`, because `ctx.settings.get` looks the key up that way.
 * A verbatim copy would therefore leave an operator's tuned bullet options
 * unreadable and silently revert the game to the built-in defaults — a
 * failure with no error anywhere. These nine are the only keys any GL3 plugin
 * reads today; everything else in the table is still core's or unread, and
 * keeps its V2 name — except the two `SKIPPED_KEYS` below, which are
 * reported "skipped" rather than migrated under any name.
 */
const RENAMES: Readonly<Record<string, string>> = {
  bulletsStockMinPerHour: "bullets.stock_min_per_hour",
  bulletsStockMaxPerHour: "bullets.stock_max_per_hour",
  maxBulletStock: "bullets.max_stock",
  maxBulletCost: "bullets.max_cost",
  maxBulletBuy: "bullets.max_buy",
  // Carried over rather than reset: V2's own 12-hour catch-up clamp bounds
  // what a years-stale cursor can pay out.
  lastBulletRestock: "bullets.last_restock",
  // Detectives' three knobs — including detectiveDuration, whose shipped V2
  // default of 1 second an operator may have tuned deliberately (fast-testing
  // vs. 3600 for real hours); carried, not defaulted.
  detectiveCost: "detectives.cost",
  detectiveDuration: "detectives.duration",
  detectiveExpire: "detectives.expire",
};

/**
 * V2's flat display keys for the premium-membership feature (a nav link
 * label and a feature name). `premiumMembership` itself now migrates as
 * content (Task 10, `p_membership_packages`), but nothing in GL3's
 * `membership` plugin reads either of these two settings keys — the page
 * name and link text are hardcoded, not admin-configurable — so, unlike the
 * nine renamed above, these are dead and simply skipped. `itemTypes` is
 * V2-side-only configuration (the int→name registry the items migrator maps
 * I_type through); GL3 stores the type string on each item row instead, so
 * copying the registry across would be dead weight.
 */
const SKIPPED_KEYS = new Set(["membershipLinkName", "membershipName", "itemTypes"]);

/**
 * No id_map here: settings.key is a natural key, identical on both sides for
 * every key but the six renamed above. ON CONFLICT (key) DO UPDATE alone gives
 * idempotency — see Global Constraints, "Not every table needs id_map" — and
 * the rename is a pure function of the key, so a re-run maps to the same
 * target row.
 */
export async function migrateSettings(pool: mysql.Pool, exec: Executor, report: MigrationReport): Promise<void> {
  const [rows] = await pool.query<(SettingRow & mysql.RowDataPacket)[]>("SELECT S_desc, S_value FROM settings");
  for (const row of rows) {
    bumpTable(report, "settings", "read");
    if (SKIPPED_KEYS.has(row.S_desc)) {
      bumpTable(report, "settings", "skipped");
      continue;
    }
    const key = RENAMES[row.S_desc] ?? row.S_desc;
    await exec.insert(settings).values({ key, value: row.S_value ?? "" })
      .onConflictDoUpdate({ target: settings.key, set: { value: row.S_value ?? "" } });
    bumpTable(report, "settings", "written");
  }
}
