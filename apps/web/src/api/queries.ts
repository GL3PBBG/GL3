import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AuthResponseSchema, BankStatusResponseSchema, BuyBulletsResponseSchema,
  CommitCrimeResponseSchema, CrimeListResponseSchema, JailStatusSchema,
  LeaderboardResponseSchema, LocationListResponseSchema, MeResponseSchema,
  RankListResponseSchema, TravelResponseSchema,
  type BankStatusResponse, type BuyBulletsResponse, type CrimeListResponse,
  type JailStatus, type LeaderboardKind, type LeaderboardResponse,
  type LocationListResponse, type MeResponse, type RankListResponse,
} from "@gl3/shared";
import { api, tokenStore } from "./client.js";
import { keys } from "./keys.js";

/** How often to re-ask the server whether a sentence has expired. */
const JAIL_POLL_MS = 2_000;

export function useMe() {
  return useQuery<MeResponse>({
    queryKey: keys.me(),
    queryFn: async () => MeResponseSchema.parse(await api("/api/auth/me")),
    retry: false,
  });
}

export function useCrimes() {
  return useQuery<CrimeListResponse>({
    queryKey: keys.crimes(),
    queryFn: async () => CrimeListResponseSchema.parse(await api("/api/crimes")),
  });
}

/**
 * There is no cron that frees players: `GET /api/jail` calls releaseIfExpired,
 * so *asking* is what ends a sentence. Polling while jailed is therefore load
 * bearing, not cosmetic — without it a player who never touches another gated
 * endpoint stays jailed on screen indefinitely.
 */
export function useJail() {
  return useQuery<JailStatus>({
    queryKey: keys.jail(),
    queryFn: async () => JailStatusSchema.parse(await api("/api/jail")),
    refetchInterval: (query) => (query.state.data?.jailed === true ? JAIL_POLL_MS : false),
  });
}

export function useLocations() {
  return useQuery<LocationListResponse>({
    queryKey: keys.locations(),
    queryFn: async () => LocationListResponseSchema.parse(await api("/api/locations")),
  });
}

export function useRanks() {
  return useQuery<RankListResponse>({
    queryKey: keys.ranks(),
    queryFn: async () => RankListResponseSchema.parse(await api("/api/ranks")),
  });
}

export function useLeaderboard(kind: LeaderboardKind) {
  return useQuery<LeaderboardResponse>({
    queryKey: keys.leaderboard(kind),
    queryFn: async () => LeaderboardResponseSchema.parse(await api(`/api/leaderboard/${kind}`)),
  });
}

export function useAuth(mode: "login" | "register") {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { username: string; password: string }) => {
      const body = AuthResponseSchema.parse(
        await api(`/api/auth/${mode}`, { method: "POST", body: JSON.stringify(input) }),
      );
      tokenStore.set(body.token);
      return body;
    },
    onSuccess: () => { void queryClient.invalidateQueries(); },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    // 204, no body. Clear locally regardless of the server's answer — a failed
    // logout call must not leave the player stuck in a session they asked to
    // end; the token is server-side revoked on success and useless either way.
    mutationFn: async () => {
      try {
        await api<void>("/api/auth/logout", { method: "POST" });
      } finally {
        tokenStore.clear();
      }
    },
    onSettled: () => { queryClient.clear(); },
  });
}

export function useCommitCrime() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (crimeId: string) =>
      CommitCrimeResponseSchema.parse(
        await api(`/api/crimes/${crimeId}/commit`, { method: "POST" }),
      ),
    // The outcome arrives over WS; refresh the cooldown list immediately.
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: keys.crimes() }); },
  });
}

export function useBank() {
  const queryClient = useQueryClient();
  return useMutation<BankStatusResponse, Error, { direction: "deposit" | "withdraw"; amount: string }>({
    mutationFn: async ({ direction, amount }) =>
      BankStatusResponseSchema.parse(
        await api(`/api/bank/${direction}`, { method: "POST", body: JSON.stringify({ amount }) }),
      ),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: keys.me() }); },
  });
}

export function useBuyBullets() {
  const queryClient = useQueryClient();
  return useMutation<BuyBulletsResponse, Error, number>({
    mutationFn: async (quantity) =>
      BuyBulletsResponseSchema.parse(
        await api("/api/bullets/buy", { method: "POST", body: JSON.stringify({ quantity }) }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.me() });
      void queryClient.invalidateQueries({ queryKey: keys.locations() });
    },
  });
}

export function useTravel() {
  const queryClient = useQueryClient();
  return useMutation({
    // Bodyless POST — client.ts omits content-type when there's no body, which
    // is what keeps this off Fastify's empty-JSON-body 400 path.
    mutationFn: async (locationId: string) =>
      TravelResponseSchema.parse(await api(`/api/travel/${locationId}`, { method: "POST" })),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: keys.me() });
      void queryClient.invalidateQueries({ queryKey: keys.locations() });
    },
  });
}
