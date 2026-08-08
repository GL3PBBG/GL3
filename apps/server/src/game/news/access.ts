import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import type { Tx } from "../../economy/ledger.js";
import { players, roleModuleAccess } from "../../db/schema/index.js";

/**
 * Role/module access gate. Spec §1.2: `roleAccess`'s `RA_module='*'` is the
 * admin wildcard, preserved as `role_module_access.moduleKey`.
 *
 * Reviewed against the brief's sample for the concerns called out in the
 * task: a player with no role denies (roles.roleId nullable, defaults null
 * on registration, and `references({onDelete: "set null"})` clears it if
 * the role is ever deleted — so this never has a dangling id to look up); a
 * deleted role can't leave orphaned `role_module_access` rows to match
 * against, since that table's `roleId` is `onDelete: "cascade"`; the "*"
 * wildcard is the deliberately-preserved V2 admin semantic, not an
 * accidental grant, and is only ever populated by direct, ops-controlled
 * DB writes in this milestone (no admin-role-management endpoint exists
 * yet, per the brief) — so it isn't attacker-reachable; and `moduleKey` is
 * always a hardcoded literal supplied by the calling route (e.g. "news"),
 * never end-user input, so case-sensitivity and injection are moot here.
 * Net: the sample's logic is sound as given.
 *
 * The one change from the sample is the parameter type: `Db | Tx` instead
 * of `Db` alone, matching `hasGangPermission`'s established convention
 * (game/gangs/permissions.ts). This is a non-breaking widening — every
 * existing/brief-specified call site passing `Db` still type-checks — but
 * lets a future staff-only feature that mutates state re-check this gate
 * *inside* its transaction under a row lock, the same recheck-under-lock
 * shape gang bank withdraw uses for `hasGangPermission`, without having to
 * change this function's signature later.
 */
export async function hasModuleAccess(db: Db | Tx, playerId: string, moduleKey: string): Promise<boolean> {
  const [player] = await db.select({ roleId: players.roleId }).from(players).where(eq(players.id, playerId));
  if (!player?.roleId) return false;

  const rows = await db.select({ moduleKey: roleModuleAccess.moduleKey }).from(roleModuleAccess).where(eq(roleModuleAccess.roleId, player.roleId));
  return rows.some((r) => r.moduleKey === moduleKey || r.moduleKey === "*");
}
