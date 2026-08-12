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
  ranks: () => ["ranks"] as const,
  leaderboard: (kind: LeaderboardKind) => ["leaderboard", kind] as const,

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
  hospital: () => ["hospital"] as const,
  bounties: () => ["bounties"] as const,
  detectives: () => ["detectives"] as const,
};
