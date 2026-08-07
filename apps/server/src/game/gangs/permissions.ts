import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import type { Tx } from "../../economy/ledger.js";
import { gangMembers, gangPermissions, gangs } from "../../db/schema/index.js";

export const GANG_PERMISSIONS = ["invite", "kick", "bank.withdraw", "edit_info", "grant_permissions"] as const;
export type GangPermission = typeof GANG_PERMISSIONS[number];

/**
 * V2's gangPermissions table had no gang column at all — membership implied
 * it (spec §1.2). GL3's gang_permissions carries a real gang_id, but the
 * boss/underboss bypass below preserves V2's effective behaviour: leadership
 * always had every permission, whether or not a gangPermissions row existed.
 *
 * The row-based branch requires a matching gang_members row for the same
 * (gangId, playerId) before a gang_permissions row counts. Without this, a
 * permission row granted to a player who was never a member — or who was a
 * member and later left — would confer real authority to someone who isn't
 * actually in the gang: PUT /api/gangs/:gangId/permissions never checked
 * the target's membership before inserting, and removeMember never deletes
 * gang_permissions rows for a member kicked or leaving a *different* gang
 * from the one the row names. Enforcing membership here, centrally, closes
 * both the dangling-grant and the stale-row-after-leaving cases for every
 * caller at once, without having to duplicate a membership check at each
 * call site.
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
    .innerJoin(gangMembers, and(
      eq(gangMembers.gangId, gangPermissions.gangId),
      eq(gangMembers.playerId, gangPermissions.playerId),
    ))
    .where(and(
      eq(gangPermissions.gangId, gangId),
      eq(gangPermissions.playerId, playerId),
      eq(gangPermissions.permission, permission),
    ));
  return row !== undefined;
}
