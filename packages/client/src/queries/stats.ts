import { useQuery } from "@tanstack/react-query";
import {
  AdminEconomyOverviewSchema,
  type AdminEconomyOverview,
  GameStatsResponseSchema,
  type GameStatsResponse,
} from "@gl3/shared";
import { api } from "../api/client.js";
import { keys } from "../api/keys.js";

// ---------------------------------------------------------------------------
// Game stats
// ---------------------------------------------------------------------------

/**
 * Game-wide totals and 14-day trends. The server already serves this from a
 * five-minute Redis cache, so a short client staleTime only avoids refetching
 * on every remount — it is not what protects the database.
 */
export function useStats() {
  return useQuery<GameStatsResponse>({
    queryKey: keys.stats(),
    queryFn: async () => GameStatsResponseSchema.parse(await api("/api/stats")),
    staleTime: 60_000,
  });
}

/**
 * The admin MIMO dashboard's one round trip (the bespoke AdminEconomy page's
 * data). The server caches for five minutes, so the short staleTime only
 * avoids refetching on remount.
 */
export function useAdminEconomyOverview() {
  return useQuery<AdminEconomyOverview>({
    queryKey: keys.adminEconomyOverview(),
    queryFn: async () => AdminEconomyOverviewSchema.parse(await api("/api/admin/economy/overview")),
    staleTime: 60_000,
  });
}
