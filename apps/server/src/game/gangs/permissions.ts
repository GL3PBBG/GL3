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
 * permission row for a player who is not actually in the gang would confer
 * real authority to an outsider.
 *
 * This is the last of three layers, and it is a *mask*, not a delete —
 * knowing which is which matters, because an earlier version of this comment
 * claimed it "closed" the dangling-grant case and it does not:
 *
 *   1. PUT /api/gangs/:gangId/permissions refuses a target who is not a
 *      member (routes.ts), so no route can create a dangling row.
 *   2. Rows nonetheless present at join time — pre-dating layer 1, or
 *      written out of band — are deleted inside the accept-invite
 *      transaction, mirroring removeMember, which deletes them on the way
 *      out (so leaving or being kicked genuinely clears them, and rejoining
 *      does not restore them).
 *   3. This join, which denies any row that survives the two above. It
 *      still earns its place: removeMember only clears rows naming the gang
 *      the player left, so a stale row naming a *different* gang would
 *      otherwise linger, and a row is masked the instant membership ends
 *      rather than whenever a cleanup path happens to run.
 *
 * Enforcing membership here, centrally, gives every caller that last layer
 * at once, without duplicating a membership check at each call site.
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
