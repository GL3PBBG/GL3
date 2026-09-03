import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type ChallengeAnswerResponse,
  type ChallengeQuestion,
  AuthResponseSchema,
  BailResponseSchema,
  BankStatusResponseSchema,
  BulletShopResponseSchema,
  BustResponseSchema,
  BuyBulletsResponseSchema,
  CellBlockListResponseSchema,
  CommitCrimeResponseSchema,
  CrimeListResponseSchema,
  JailStatusSchema,
  LeaderboardResponseSchema,
  LocationListResponseSchema,
  MeResponseSchema,
  RankListResponseSchema,
  RoundListResponseSchema,
  RoundStandingsResponseSchema,
  TravelResponseSchema,
  type BailResponse,
  type BankStatusResponse,
  type BulletShopResponse,
  type BustResponse,
  type BuyBulletsResponse,
  type CellBlockListResponse,
  type CrimeListResponse,
  type JailStatus,
  type LeaderboardKind,
  type LeaderboardResponse,
  type LocationListResponse,
  type MeResponse,
  type RankListResponse,
  type RoundListResponse,
  type RoundStandingsResponse,
} from "@gl3/shared";
import { api } from "../api/client.js";
import { keys } from "../api/keys.js";
import { tokenStore } from "../config.js";
import { jailRefetchInterval } from "./shared.js";

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
 * `GET /api/jail` still calls releaseIfExpired, so asking is still *a* way a
 * sentence ends — but it is no longer the only one. The server's sentence
 * sweeper ends sentences on a tick and pushes `player.released`, which
 * invalidates this query (see ws/invalidation.ts). The slow poll here is the
 * backstop for a client whose socket is down, not the mechanism.
 */
export function useJail() {
  return useQuery<JailStatus>({
    queryKey: keys.jail(),
    queryFn: async () => JailStatusSchema.parse(await api("/api/jail")),
    refetchInterval: (query) => jailRefetchInterval(query.state.data),
  });
}

/** The other inmates in the caller's current town. No poll: the roster is
 *  not a countdown the tab must keep honest, and each row carries
 *  `remainingSeconds` for the local tick. */
export function useCellBlock() {
  return useQuery<CellBlockListResponse>({
    queryKey: keys.jailLocal(),
    queryFn: async () => CellBlockListResponseSchema.parse(await api("/api/jail/local")),
  });
}

export function useBail() {
  const queryClient = useQueryClient();
  return useMutation<BailResponse, Error, string>({
    mutationFn: async (playerId) =>
      BailResponseSchema.parse(await api("/api/jail/bail", {
        method: "POST", body: JSON.stringify({ playerId }),
      })),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.jailLocal() });
      void queryClient.invalidateQueries({ queryKey: keys.me() });
    },
  });
}

export function useBust() {
  const queryClient = useQueryClient();
  return useMutation<BustResponse, Error, string>({
    mutationFn: async (playerId) =>
      BustResponseSchema.parse(await api("/api/jail/bust", {
        method: "POST", body: JSON.stringify({ playerId }),
      })),
    onSuccess: () => {
      // A failed bust jails the CLICKER, so the caller's own jail status is
      // part of this mutation's result — invalidate it too.
      void queryClient.invalidateQueries({ queryKey: keys.jailLocal() });
      void queryClient.invalidateQueries({ queryKey: keys.jail() });
      void queryClient.invalidateQueries({ queryKey: keys.me() });
    },
  });
}

export function useEscape() {
  const queryClient = useQueryClient();
  return useMutation<BustResponse, Error, void>({
    mutationFn: async () =>
      BustResponseSchema.parse(await api("/api/jail/escape", { method: "POST" })),
    onSuccess: () => {
      // Success frees the caller; failure extends their sentence — either
      // way the caller's own jail status changed.
      void queryClient.invalidateQueries({ queryKey: keys.jail() });
      void queryClient.invalidateQueries({ queryKey: keys.me() });
    },
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

export function useLeaderboard(kind: LeaderboardKind, scope: "round" | "all") {
  return useQuery<LeaderboardResponse>({
    queryKey: keys.leaderboard(kind, scope),
    queryFn: async () => LeaderboardResponseSchema.parse(await api(`/api/leaderboard/${kind}?scope=${scope}`)),
  });
}

export function useRounds() {
  return useQuery<RoundListResponse>({
    queryKey: keys.rounds(),
    queryFn: async () => RoundListResponseSchema.parse(await api("/api/rounds")),
  });
}

export function useRoundStandings(roundId: string, kind: LeaderboardKind) {
  return useQuery<RoundStandingsResponse>({
    queryKey: keys.roundStandings(roundId, kind),
    queryFn: async () =>
      RoundStandingsResponseSchema.parse(await api(`/api/rounds/${roundId}/standings?kind=${kind}`)),
  });
}

export function useAuth(mode: "login" | "register") {
  const queryClient = useQueryClient();
  return useMutation({
    // `email` is required by RegisterRequestSchema and absent from
    // LoginRequestSchema — sent conditionally rather than always, so a login
    // never carries a stray field the server schema doesn't expect.
    mutationFn: async (input: { username: string; password: string; email?: string }) => {
      const requestBody = mode === "register"
        ? { username: input.username, email: input.email, password: input.password }
        : { username: input.username, password: input.password };
      const body = AuthResponseSchema.parse(
        await api(`/api/auth/${mode}`, { method: "POST", body: JSON.stringify(requestBody) }),
      );
      tokenStore.set(body.token);
      return body;
    },
    onSuccess: () => { void queryClient.invalidateQueries(); },
  });
}

/**
 * `code` from the emailed link or pasted by hand. The response is `{}` on
 * success — nothing in `MeResponseSchema` reflects verification state, so
 * there is nothing meaningful to invalidate here.
 */
export function useVerify() {
  return useMutation<void, Error, { code: string }>({
    mutationFn: async (input) =>
      api<void>("/api/auth/verify", { method: "POST", body: JSON.stringify(input) }),
  });
}

export function useChallengeQuestion() {
  return useQuery<ChallengeQuestion, Error>({
    queryKey: keys.challenge(),
    queryFn: async () => api<ChallengeQuestion>("/api/challenge"),
    // Every GET mints a fresh question and burns nothing; but background
    // refetches would invalidate the one the player is mid-typing on.
    staleTime: Infinity,
    retry: false,
  });
}

export function useAnswerChallenge() {
  return useMutation<ChallengeAnswerResponse, Error, string>({
    mutationFn: async (answer) =>
      api<ChallengeAnswerResponse>("/api/challenge", { method: "POST", body: JSON.stringify({ answer }) }),
  });
}

export function useResendVerify() {
  return useMutation<void, Error, void>({
    mutationFn: async () => api<void>("/api/auth/verify/resend", { method: "POST" }),
  });
}

/** Always 200 regardless of whether the address is registered — anti-
 *  enumeration by design (see auth/routes.ts). */
export function useForgot() {
  return useMutation<void, Error, { email: string }>({
    mutationFn: async (input) =>
      api<void>("/api/auth/forgot", { method: "POST", body: JSON.stringify(input) }),
  });
}

export function useReset() {
  return useMutation<void, Error, { token: string; password: string }>({
    mutationFn: async (input) =>
      api<void>("/api/auth/reset", { method: "POST", body: JSON.stringify(input) }),
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

/**
 * The bullet shop. Replaces reading stock out of `useLocations()`: this
 * carries the price the buy route will really charge, and reading it is what
 * runs the hourly restock — so a town at zero stock refills when a player
 * opens the page, which is the only moment they can reach it.
 */
export function useBulletShop() {
  return useQuery<BulletShopResponse>({
    queryKey: keys.bulletShop(),
    queryFn: async () => BulletShopResponseSchema.parse(await api("/api/bullets/shop")),
    // A player who is nowhere gets a 409 from this route; the page renders the
    // "travel somewhere first" branch off the error rather than retrying it.
    retry: false,
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
      void queryClient.invalidateQueries({ queryKey: keys.bulletShop() });
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
