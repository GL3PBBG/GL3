import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import type { Tx } from "../../economy/ledger.js";
import { gangPermissions, gangs } from "../../db/schema/index.js";

export const GANG_PERMISSIONS = ["invite", "kick", "bank.withdraw", "edit_info", "grant_permissions"] as const;
export type GangPermission = typeof GANG_PERMISSIONS[number];

/**
 * V2's gangPermissions table had no gang column at all — membership implied
 * it (spec §1.2). GL3's gang_permissions carries a real gang_id, but the
 * boss/underboss bypass below preserves V2's effective behaviour: leadership
 * always had every permission, whether or not a gangPermissions row existed.
 */
export async function hasGangPermission(
  db: Db | Tx, gangId: string, playerId: string, permission: GangPermission,
): Promise<boolean> {
  const [gang] = await db.select({ boss: gangs.bossPlayerId, underboss: gangs.underbossPlayerId })
    .from(gangs).where(eq(gangs.id, gangId));
  if (!gang) return false;
  if (gang.boss === playerId || gang.underboss === playerId) return true;

  const [row] = await db.select({ permission: gangPermissions.permission })
    .from(gangPermissions)
    .where(and(
      eq(gangPermissions.gangId, gangId),
      eq(gangPermissions.playerId, playerId),
      eq(gangPermissions.permission, permission),
    ));
  return row !== undefined;
}
