import type { GangMemberDto, GangPermission } from "@gl3/shared";

/**
 * Which gang buttons a viewer gets to see.
 *
 * This mirrors the server's `hasGangPermission` (game/gangs/permissions.ts)
 * and the guards in the gang routes. It is a *rendering* decision only — the
 * server re-checks every one of these, and a client that got it wrong would
 * get a 403, not a privilege. What it buys is a roster that doesn't offer
 * actions the server will refuse.
 *
 * The roster DTO is what makes this mirror possible: role is derived from the
 * `gangs` boss/underboss columns rather than stored, and the server already
 * folds that plus the `gang_permissions` rows into `GangMemberDto`.
 */

/** The viewer's own row in a roster, or undefined if they aren't in it. */
export function memberOf(
  members: readonly GangMemberDto[], playerId: string,
): GangMemberDto | undefined {
  return members.find((m) => m.playerId === playerId);
}

export function roleOf(
  members: readonly GangMemberDto[], playerId: string,
): GangMemberDto["role"] | null {
  return memberOf(members, playerId)?.role ?? null;
}

/**
 * Leadership holds every permission with no `gang_permissions` row to back it
 * — the same bypass hasGangPermission applies before it looks at any row.
 * The roster already expands leadership's `permissions` to the full list, so
 * this is belt-and-braces; it keeps the predicate correct even if a caller
 * hands it a member built some other way.
 */
export function hasPermission(
  member: GangMemberDto | undefined, permission: GangPermission,
): boolean {
  if (!member) return false;
  if (member.role === "boss" || member.role === "underboss") return true;
  return member.permissions.includes(permission);
}

export function canInvite(viewer: GangMemberDto | undefined): boolean {
  return hasPermission(viewer, "invite");
}

export function canGrant(viewer: GangMemberDto | undefined): boolean {
  return hasPermission(viewer, "grant_permissions");
}

export function canWithdraw(viewer: GangMemberDto | undefined): boolean {
  return hasPermission(viewer, "bank.withdraw");
}

/**
 * The boss cannot be kicked (the server answers 409 cannot_kick_boss), and
 * kicking yourself is left out here even though the server allows it: leaving
 * is its own button, and a "kick" that removes you reads as a mistake.
 */
export function canKick(
  viewer: GangMemberDto | undefined, target: GangMemberDto,
): boolean {
  if (!hasPermission(viewer, "kick")) return false;
  if (target.role === "boss") return false;
  return target.playerId !== viewer?.playerId;
}

/**
 * Boss only, and never to yourself — the server answers 409 already_boss for
 * that. There is no permission that stands in for being the boss here:
 * `hasGangPermission`'s bypass would hand an underboss the transfer, and the
 * route deliberately does not.
 */
export function canTransfer(
  viewer: GangMemberDto | undefined, target: GangMemberDto,
): boolean {
  if (viewer?.role !== "boss") return false;
  return target.playerId !== viewer.playerId;
}
