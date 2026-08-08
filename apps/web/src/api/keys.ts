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
};
