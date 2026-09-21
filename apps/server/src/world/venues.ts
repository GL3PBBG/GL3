import type { WorldHook } from "@gl3/plugin-sdk";
import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";

/**
 * Per-town venue eligibility (spec 2026-09-21 town-venues §3.1).
 *
 * A venue EXISTS in a town iff a `p_properties_properties` row for
 * `(location_id, plugin_id)` does — V2's own semantics, owner null meaning
 * state-run and an owner meaning player-owned. Neither case is special here:
 * the ROW is the venue, whoever holds it.
 */

/** Distinct venue ids the loaded hooks name, in first-seen order. */
export function venueKeys(hooks: readonly WorldHook[]): string[] {
  const out: string[] = [];
  for (const h of hooks) if (h.venue !== undefined && !out.includes(h.venue)) out.push(h.venue);
  return out;
}

/**
 * Which of `keys` have a property row in `locationId`.
 *
 * A plain SELECT, no lock and no new edge on the lock graph (rule 6): core
 * reads the plugin's table by name, exactly as `ctx.venues.has` does.
 *
 * Empty when nothing is asked and empty without the properties plugin — the
 * table does not exist on such a boot, and `validatePlugins` already refuses
 * a hook naming a venue there, so the only hooks that could be filtered are
 * ones that cannot be declared.
 *
 * `locationId` is not re-validated: every caller reads the town row first and
 * bails when it is missing, so a value reaching here is a real location id.
 */
export async function venuesAt(
  db: Db,
  locationId: string,
  keys: readonly string[],
  hasProperties: boolean,
): Promise<Set<string>> {
  if (!hasProperties || keys.length === 0) return new Set();
  const list = sql.join(keys.map((k) => sql`${k}`), sql`, `);
  const rows = await db.execute(
    sql`select plugin_id from p_properties_properties where location_id = ${locationId} and plugin_id in (${list})`,
  );
  const present = new Set<string>();
  for (const row of rows) {
    const value: unknown = (row as Record<string, unknown>).plugin_id;
    if (typeof value === "string") present.add(value);
  }
  return present;
}

/**
 * Declaration order kept; a hook with a venue survives only where that venue
 * is present. A venue-less hook — station, bank, shop, corner, garage — is
 * everywhere, as it always was.
 */
export function eligibleHooks(hooks: readonly WorldHook[], present: ReadonlySet<string>): WorldHook[] {
  return hooks.filter((h) => h.venue === undefined || present.has(h.venue));
}
