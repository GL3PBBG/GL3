import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AuthResponseSchema, BankStatusResponseSchema, BuyBulletsResponseSchema,
  CommitCrimeResponseSchema, CrimeListResponseSchema, GangBankResponseSchema,
  GangDtoSchema, GangInviteListResponseSchema, GangLogListResponseSchema,
  GangMemberListResponseSchema, JailStatusSchema, LeaderboardResponseSchema,
  LocationListResponseSchema, MailDtoSchema, MailListResponseSchema, MeResponseSchema,
  NewsListResponseSchema, NotificationListResponseSchema, PluginsPayloadSchema,
  ProfileDtoSchema, RankListResponseSchema, TravelResponseSchema,
  type BankStatusResponse, type BuyBulletsResponse, type CreateGangRequest,
  type CrimeListResponse, type GangBankResponse, type GangDto, type GangInviteListResponse,
  type GangLogListResponse, type GangMemberListResponse, type GangPermission,
  type JailStatus, type LeaderboardKind, type LeaderboardResponse,
  type LocationListResponse, type MailDto, type MailListResponse, type MeResponse,
  type NewsListResponse, type NotificationListResponse, type PluginsPayload,
  type ProfileDto, type RankListResponse, type UpdateProfileRequest,
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

/* ------------------------------------------------------------------ social
 *
 * Every hook below takes the ids its URL needs as *definite* strings. The
 * pages mount these behind a component that already has the player (and,
 * where relevant, the gang) loaded, which keeps `enabled` guards and
 * `?? ""` placeholder keys out of the cache entirely.
 */

export function useProfile(playerId: string) {
  return useQuery<ProfileDto>({
    queryKey: keys.profile(playerId),
    queryFn: async () => ProfileDtoSchema.parse(await api(`/api/players/${playerId}/profile`)),
  });
}

/** PUT /api/profile answers `{ok:true}`, not the profile — hence the refetch. */
export function useUpdateProfile(viewerId: string) {
  const queryClient = useQueryClient();
  return useMutation<void, Error, UpdateProfileRequest>({
    mutationFn: async (input) =>
      api<void>("/api/profile", { method: "PUT", body: JSON.stringify(input) }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: keys.profile(viewerId) }); },
  });
}

export function useGang(gangId: string) {
  return useQuery<GangDto>({
    queryKey: keys.gang(gangId),
    queryFn: async () => GangDtoSchema.parse(await api(`/api/gangs/${gangId}`)),
  });
}

export function useGangMembers(gangId: string) {
  return useQuery<GangMemberListResponse>({
    queryKey: keys.gangMembers(gangId),
    queryFn: async () =>
      GangMemberListResponseSchema.parse(await api(`/api/gangs/${gangId}/members`)),
  });
}

export function useGangLogs(gangId: string) {
  return useQuery<GangLogListResponse>({
    queryKey: keys.gangLogs(gangId),
    queryFn: async () => GangLogListResponseSchema.parse(await api(`/api/gangs/${gangId}/logs`)),
  });
}

export function useGangInvites() {
  return useQuery<GangInviteListResponse>({
    queryKey: keys.gangInvites(),
    queryFn: async () => GangInviteListResponseSchema.parse(await api("/api/gangs/invites")),
  });
}

export function useCreateGang(viewerId: string) {
  const queryClient = useQueryClient();
  return useMutation<GangDto, Error, CreateGangRequest>({
    mutationFn: async (input) =>
      GangDtoSchema.parse(await api("/api/gangs", { method: "POST", body: JSON.stringify(input) })),
    // The viewer's gang membership lives on their profile, not on /auth/me.
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: keys.profile(viewerId) }); },
  });
}

export function useAcceptInvite(viewerId: string) {
  const queryClient = useQueryClient();
  return useMutation<GangDto, Error, string>({
    mutationFn: async (inviteId) =>
      GangDtoSchema.parse(await api(`/api/gangs/invites/${inviteId}/accept`, { method: "POST" })),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.profile(viewerId) });
      // Accepting clears *every* invite the joiner holds, not just this one.
      void queryClient.invalidateQueries({ queryKey: keys.gangInvites() });
    },
  });
}

export function useDeclineInvite() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: async (inviteId) =>
      api<void>(`/api/gangs/invites/${inviteId}/decline`, { method: "POST" }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: keys.gangInvites() }); },
  });
}

export function useInvitePlayer(gangId: string) {
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: async (username) =>
      api<void>(`/api/gangs/${gangId}/invites`, {
        method: "POST", body: JSON.stringify({ username }),
      }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: keys.gangLogs(gangId) }); },
  });
}

export function useLeaveGang(gangId: string, viewerId: string) {
  const queryClient = useQueryClient();
  return useMutation<void, Error, void>({
    mutationFn: async () => api<void>(`/api/gangs/${gangId}/leave`, { method: "POST" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.profile(viewerId) });
      void queryClient.invalidateQueries({ queryKey: keys.gangMembers(gangId) });
    },
  });
}

export function useKickMember(gangId: string) {
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: async (playerId) =>
      api<void>(`/api/gangs/${gangId}/members/${playerId}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.gangMembers(gangId) });
      void queryClient.invalidateQueries({ queryKey: keys.gangLogs(gangId) });
    },
  });
}

export function useGrantPermission(gangId: string) {
  const queryClient = useQueryClient();
  return useMutation<void, Error, { playerId: string; permission: GangPermission }>({
    mutationFn: async (input) =>
      api<void>(`/api/gangs/${gangId}/permissions`, {
        method: "PUT", body: JSON.stringify(input),
      }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: keys.gangMembers(gangId) }); },
  });
}

export function useRevokePermission(gangId: string) {
  const queryClient = useQueryClient();
  return useMutation<void, Error, { playerId: string; permission: GangPermission }>({
    // `bank.withdraw` is a path segment here; encode it rather than trusting
    // that no permission will ever contain a slash.
    mutationFn: async ({ playerId, permission }) =>
      api<void>(
        `/api/gangs/${gangId}/permissions/${playerId}/${encodeURIComponent(permission)}`,
        { method: "DELETE" },
      ),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: keys.gangMembers(gangId) }); },
  });
}

export function useTransferBoss(gangId: string) {
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: async (playerId) =>
      api<void>(`/api/gangs/${gangId}/transfer`, {
        method: "POST", body: JSON.stringify({ playerId }),
      }),
    onSuccess: () => {
      // Both offices are gangs columns, so the gang row is stale too — not
      // just the roster the new roles render from.
      void queryClient.invalidateQueries({ queryKey: keys.gang(gangId) });
      void queryClient.invalidateQueries({ queryKey: keys.gangMembers(gangId) });
      void queryClient.invalidateQueries({ queryKey: keys.gangLogs(gangId) });
    },
  });
}

/**
 * The gang bank answers 400 for insufficient_cash / insufficient_gang_funds
 * where the personal bank answers 409 — the copy in lib/errors.ts is keyed on
 * the code, not the status, so both read correctly.
 */
export function useGangBank(gangId: string) {
  const queryClient = useQueryClient();
  return useMutation<GangBankResponse, Error, { direction: "deposit" | "withdraw"; amount: string }>({
    mutationFn: async ({ direction, amount }) =>
      GangBankResponseSchema.parse(
        await api(`/api/gangs/${gangId}/bank/${direction}`, {
          method: "POST", body: JSON.stringify({ amount }),
        }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.gang(gangId) });
      // The money came from (or went to) the player's own cash: the HUD moved.
      void queryClient.invalidateQueries({ queryKey: keys.me() });
      void queryClient.invalidateQueries({ queryKey: keys.gangLogs(gangId) });
    },
  });
}

export function useMail() {
  return useQuery<MailListResponse>({
    queryKey: keys.mail(),
    queryFn: async () => MailListResponseSchema.parse(await api("/api/mail")),
  });
}

export function useMailThread(threadId: string) {
  return useQuery<MailListResponse>({
    queryKey: keys.mailThread(threadId),
    queryFn: async () => MailListResponseSchema.parse(await api(`/api/mail/thread/${threadId}`)),
  });
}

export function useSendMail() {
  const queryClient = useQueryClient();
  return useMutation<MailDto, Error, { recipientUsername: string; subject: string; body: string; threadId?: string }>({
    mutationFn: async (input) =>
      MailDtoSchema.parse(await api("/api/mail", { method: "POST", body: JSON.stringify(input) })),
    // Invalidate off the *sent* message's threadId, not the request's: a new
    // thread has none to invalidate until the server names it.
    onSuccess: (sent) => {
      void queryClient.invalidateQueries({ queryKey: keys.mail() });
      void queryClient.invalidateQueries({ queryKey: keys.mailThread(sent.threadId) });
    },
  });
}

export function useMarkMailRead() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, { mailId: string; threadId: string }>({
    mutationFn: async ({ mailId }) => api<void>(`/api/mail/${mailId}/read`, { method: "POST" }),
    onSuccess: (_result, { threadId }) => {
      void queryClient.invalidateQueries({ queryKey: keys.mail() });
      void queryClient.invalidateQueries({ queryKey: keys.mailThread(threadId) });
    },
  });
}

export function useNotifications() {
  return useQuery<NotificationListResponse>({
    queryKey: keys.notifications(),
    queryFn: async () => NotificationListResponseSchema.parse(await api("/api/notifications")),
  });
}

export function useMarkNotificationRead() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: async (notificationId) =>
      api<void>(`/api/notifications/${notificationId}/read`, { method: "POST" }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: keys.notifications() }); },
  });
}

export function useNews() {
  return useQuery<NewsListResponse>({
    queryKey: keys.news(),
    queryFn: async () => NewsListResponseSchema.parse(await api("/api/news")),
  });
}

/* ------------------------------------------------------------------ plugins
 *
 * The manifest of everything the loaded plugins contribute: menu entries,
 * page views, and the event metadata the feed renders. It is parsed here like
 * every other response — `PagePayload.view` stays `unknown` past this point on
 * purpose, and the renderer narrows it per node kind.
 */

export function usePlugins() {
  return useQuery<PluginsPayload>({
    queryKey: keys.plugins(),
    queryFn: async () => PluginsPayloadSchema.parse(await api("/api/plugins")),
  });
}
