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
  type ChangePasswordRequest,
  CommitCrimeResponseSchema,
  CrimeListResponseSchema,
  type DeleteAccountRequest,
  JailStatusSchema,
  LeaderboardResponseSchema,
  type LegalDoc,
  type LegalDocResponse,
  LegalDocResponseSchema,
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

/**
 * `enabled` defaults to true, matching every existing caller. A public page
 * that may render for a logged-out visitor should pass `enabled: false` in
 * that case — a second observer mounting on an already-errored, `retry:
 * false` `me` query otherwise refetches on mount and loops with the page's
 * own re-render (see apps/web/src/pages/Legal.tsx).
 */
export function useMe(options?: { enabled?: boolean }) {
  return useQuery<MeResponse>({
    queryKey: keys.me(),
    queryFn: async () => MeResponseSchema.parse(await api("/api/auth/me")),
    retry: false,
    enabled: options?.enabled ?? true,
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
    // `email` and `acceptTerms` are required by RegisterRequestSchema and
    // absent from LoginRequestSchema — sent conditionally rather than
    // always, so a login never carries a stray field the server schema
    // doesn't expect.
    mutationFn: async (input: { username: string; password: string; email?: string; acceptTerms?: boolean }) => {
      const requestBody = mode === "register"
        ? { username: input.username, email: input.email, password: input.password, acceptTerms: input.acceptTerms }
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
    onSettled: async () => {
      // Cancel first: an authenticated request already in flight would
      // otherwise resolve after clear() and repopulate the cache with a
      // logged-in `me` (same race as useDeleteAccount, above).
      await queryClient.cancelQueries();
      // Reset before clear, not instead of it: App.tsx is the parent of
      // <BrowserRouter> and holds its own `useMe()` observer, which only
      // re-renders when ITS query is notified. queryClient.clear() removes
      // queries from the cache silently (QueryCache.clear -> remove ->
      // query.destroy(), which cancels but never dispatches) — App's
      // observer keeps rendering its last successful `me` and the Shell
      // stays mounted. Query.reset() calls setState(), which DOES dispatch
      // to every attached observer; resetQueries() also refetches active
      // queries, and with the token already cleared that refetch 401s,
      // flipping App to logged-out. Doing this after clear() would be a
      // no-op — there would be nothing left in the cache to reset.
      await queryClient.resetQueries();
      queryClient.clear();
    },
  });
}

export function useChangePassword() {
  return useMutation<void, Error, ChangePasswordRequest>({
    mutationFn: async (input) =>
      api<void>("/api/auth/password", { method: "POST", body: JSON.stringify(input) }),
  });
}

/**
 * 204 on success; the account is gone server-side, so the local token and
 * every cached query go with it — same shape as useLogout's cleanup.
 *
 * `onDeleted` runs INSTEAD of a call-site `mutate(vars, { onSuccess })`
 * callback, on purpose: `resetQueries()` below notifies App's `me` observer
 * synchronously (before this hook's `onSuccess` resolves), which flips App
 * to its logged-out branch and unmounts the caller (Profile/DangerZone) in
 * the same tick. `MutationObserver#notify` in react-query only invokes a
 * call-site `onSuccess` when `this.hasListeners()` is still true
 * (`mutationObserver.js`: `if (this.#mutateOptions && this.hasListeners())`
 * guards every call-site callback), and React's `useSyncExternalStore`
 * cleanup unsubscribes that listener on unmount — so a call-site `onSuccess`
 * passed to `.mutate()` would silently never fire once the caller is gone.
 * `onDeleted` is invoked here, inside the hook's own `onSuccess`, while the
 * caller is still mounted and before anything can unmount it.
 */
export function useDeleteAccount(options?: { onDeleted?: () => void }) {
  const queryClient = useQueryClient();
  return useMutation<void, Error, DeleteAccountRequest>({
    mutationFn: async (input) =>
      api<void>("/api/auth/delete", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: async () => {
      tokenStore.clear();
      options?.onDeleted?.();
      // Cancel first: an authenticated request already in flight would
      // otherwise resolve after clear() and repopulate the cache with a
      // logged-in `me`.
      await queryClient.cancelQueries();
      // Reset before clear — see the matching comment in useLogout. Query.reset()
      // dispatches to every attached observer (unlike clear(), which is silent),
      // so App's `me` observer is notified and flips to logged-out here.
      await queryClient.resetQueries();
      queryClient.clear();
    },
  });
}

/** Public; the register page reads it before any session exists. */
export function useLegalDoc(doc: LegalDoc) {
  return useQuery<LegalDocResponse>({
    queryKey: keys.legal(doc),
    queryFn: async () => LegalDocResponseSchema.parse(await api(`/api/legal/${doc}`)),
    staleTime: 5 * 60 * 1000,
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
