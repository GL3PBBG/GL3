import type { LeaderboardKind } from "@gl3/shared";

/**
 * Every react-query key in one place.
 *
 * The WebSocket invalidation map (ws/invalidation.ts) and the hooks that
 * declare these queries have to agree exactly, or an event silently refreshes
 * nothing. Ad-hoc `["crimes"]` literals in two files drift; a factory can't.
 */
export const keys = {
  me: () => ["me"] as const,
  jail: () => ["jail"] as const,
  crimes: () => ["crimes"] as const,
  locations: () => ["locations"] as const,
  /** The bullet shop: stock, the effective price, and the per-purchase cap. */
  bulletShop: () => ["bulletShop"] as const,
  ranks: () => ["ranks"] as const,
  leaderboard: (kind: LeaderboardKind, scope: "round" | "all") => ["leaderboard", kind, scope] as const,
  rounds: () => ["rounds"] as const,
  roundStandings: (roundId: string, kind: LeaderboardKind) =>
    ["rounds", roundId, "standings", kind] as const,
  /** The prefix over every kind and scope — for invalidation, not for a query. */
  leaderboards: () => ["leaderboard"] as const,

  // Pass 2 (social). `profile` is keyed by player id because the same query
  // serves both /profile and /players/:playerId — the Gang page also reads
  // the viewer's own profile for their gangId, which /api/auth/me omits.
  profile: (playerId: string) => ["profile", playerId] as const,
  gang: (gangId: string) => ["gang", gangId] as const,
  gangMembers: (gangId: string) => ["gang", gangId, "members"] as const,
  gangLogs: (gangId: string) => ["gang", gangId, "logs"] as const,
  // Not nested under a gang: these are the *viewer's* invites, and the whole
  // point is that they arrive before the viewer belongs to any gang.
  gangInvites: () => ["gangInvites"] as const,
  mail: () => ["mail"] as const,
  mailThread: (threadId: string) => ["mail", "thread", threadId] as const,
  notifications: () => ["notifications"] as const,
  news: () => ["news"] as const,
  online: () => ["online"] as const,

  // Pass 3 (plugin SDK). One key for the whole manifest: menu, pages and event
  // metadata arrive from `GET /api/plugins` in a single payload, so splitting
  // them would only buy three refetches of the same response.
  plugins: () => ["plugins"] as const,

  // Pass 4 (items and combat). `shop` is not keyed by location: the route
  // answers for wherever the caller currently is, and travelling invalidates
  // it through player.travelled anyway.
  inventory: () => ["inventory"] as const,
  shop: () => ["shop"] as const,
  combatTargets: () => ["combat", "targets"] as const,
  combatLog: () => ["combat", "log"] as const,
  weaponCondition: () => ["combat", "weapon"] as const,
  hospital: () => ["hospital"] as const,
  hospitalLocal: () => ["hospital", "local"] as const,
  jailLocal: () => ["jail", "local"] as const,
  bounties: () => ["bounties"] as const,
  detectives: () => ["detectives"] as const,
  oc: () => ["oc"] as const,
  properties: () => ["properties"] as const,
  // Not keyed by location, for the same reason as `shop`: the lobby answers
  // for wherever the caller currently is. Unlike `shop` it is NOT listed under
  // player.travelled in ws/invalidation.ts — travelling is only reachable from
  // another page, so the remount refetches it anyway (staleTime is 0). Add it
  // there the day something can move the player without leaving /casino.
  casino: () => ["casino"] as const,

  // Admin sections (grant-gated).
  adminSections: () => ["admin", "sections"] as const,
};
