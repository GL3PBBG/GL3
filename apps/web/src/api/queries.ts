import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  AdminSectionsResponseSchema,
  AttackResponseSchema, AuthResponseSchema, BailResponseSchema, BankStatusResponseSchema,
  BountyListResponseSchema,
  BulletShopResponseSchema, BustResponseSchema, BuyBulletsResponseSchema, BuyItemResponseSchema,
  CasinoLeaveResponseSchema, CasinoLobbyResponseSchema, CasinoSitResponseSchema,
  CasinoStepResponseSchema, CasinoTableResponseSchema,
  CellBlockListResponseSchema,
  CheckinResponseSchema,
  CombatLogResponseSchema,
  CombatTargetListResponseSchema, CommitCrimeResponseSchema, CrimeListResponseSchema,
  DetectiveListResponseSchema, DischargePlayerResponseSchema, DischargeResponseSchema,
  EquipResponseSchema, ForumListResponseSchema, ForumTopicListResponseSchema,
  ForumTopicViewResponseSchema, GangBankResponseSchema,
  GangDtoSchema, GangInviteListResponseSchema, GangLogListResponseSchema,
  GangMemberListResponseSchema, HireDetectivesResponseSchema, HospitalStatusSchema,
  InventoryResponseSchema, JailStatusSchema,
  LeaderboardResponseSchema,
  LocationListResponseSchema, MailDtoSchema, MailListResponseSchema, MeResponseSchema,
  NewsListResponseSchema, NotificationListResponseSchema, OcCashResponseSchema,
  OcCreateResponseSchema, OcStateResponseSchema, OnlineListResponseSchema, PlaceBountyResponseSchema,
  PluginsPayloadSchema,
  PropertyListResponseSchema,
  ProfileDtoSchema, RankListResponseSchema, RemoveDetectiveSearchResponseSchema,
  RepairResponseSchema,
  RoundListResponseSchema, RoundStandingsResponseSchema,
  ShopListResponseSchema, TravelResponseSchema,
  UseItemResponseSchema,
  WardListResponseSchema,
  WeaponConditionDtoSchema,
  type AdminSectionsResponse,
  type AttackResponse, type BailResponse, type BankStatusResponse, type BountyListResponse,
  type BulletShopResponse,
  type BustResponse,
  type BuyBulletsResponse,
  type BuyItemRequest, type BuyItemResponse,
  type CasinoLeaveResponse, type CasinoLobbyResponse, type CasinoSitResponse,
  type CasinoStepResponse, type CasinoTableResponse,
  type CellBlockListResponse,
  type CheckinResponse,
  type CombatLogResponse,
  type CombatTargetListResponse, type CreateGangRequest,
  type CreatePostRequest, type CreateTopicRequest,
  type CrimeListResponse,
  type DetectiveListResponse, type DischargePlayerResponse, type DischargeResponse,
  type EquipRequest, type EquipResponse,
  type ForumListResponse, type ForumTopicListResponse, type ForumTopicViewResponse,
  type GangBankResponse, type GangDto, type GangInviteListResponse,
  type GangLogListResponse, type GangMemberListResponse, type GangPermission,
  type HireDetectivesRequest, type HireDetectivesResponse,
  type HospitalStatus, type InventoryResponse,
  type JailStatus, type LeaderboardKind, type LeaderboardResponse,
  type LocationListResponse, type MailDto, type MailListResponse, type MeResponse,
  type NewsListResponse, type NotificationListResponse,
  type OcCashResponse, type OcCreateResponse, type OcStateResponse, type OnlineListResponse,
  type PlaceBountyRequest, type PlaceBountyResponse, type PluginsPayload,
  type ProfileDto, type RankListResponse, type RemoveDetectiveSearchResponse,
  type RepairResponse,
  type RoundListResponse, type RoundStandingsResponse,
  type ShopListResponse, type UpdateProfileRequest,
  type UseItemResponse,
  type WardListResponse,
  type WeaponConditionDto,
} from "@gl3/shared";
import { api, tokenStore } from "./client.js";
import { keys } from "./keys.js";

/**
 * The server's sentence sweeper ends jail and hospital sentences on a ~2s tick
 * and pushes `player.released` / `player.discharged` over the socket, so the
 * page no longer has to ask. This poll is the backstop for the window where
 * the socket is down (reconnect is 2s, but a server restart can be longer) —
 * without it a mid-reconnect client would sit on a stale "you're jailed"
 * screen. 30s rather than the old 2s: 15× less traffic, and the socket is what
 * makes it feel instant.
 */
export const SENTENCE_SAFETY_POLL_MS = 30_000;

export function jailRefetchInterval(data: JailStatus | undefined): number | false {
  return data?.jailed === true ? SENTENCE_SAFETY_POLL_MS : false;
}

export function hospitalRefetchInterval(data: HospitalStatus | undefined): number | false {
  return data?.hospitalised === true ? SENTENCE_SAFETY_POLL_MS : false;
}

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

/** Who's around: online now, plus active in the last hour. Polled rather than
 *  pushed — presence has no `GameEvent` variant, so there is nothing for the
 *  socket to invalidate this on. */
export function useOnline() {
  return useQuery<OnlineListResponse>({
    queryKey: keys.online(),
    queryFn: async () => OnlineListResponseSchema.parse(await api("/api/online")),
    refetchInterval: 30_000,
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
    // The payload is FIXED for the life of the server process:
    // `buildPluginsPayload` runs once at boot from the loaded manifests and
    // `GET /api/plugins` returns that same object to every player forever
    // after. So an invalidation of this key can never produce a different
    // answer, and without a staleTime it produces a REFETCH — of the whole
    // manifest, every page and every view tree included.
    //
    // That matters now that plugin events are a realtime channel rather than
    // an occasional notice: `pluginInvalidationKeys` prepends `keys.plugins()`
    // to every plugin event (deliberately — an unknown event is exactly when
    // the manifest is most likely stale), so a casino table would have every
    // seated client re-downloading the manifest several times a hand. Marking
    // it permanently fresh keeps that invalidation harmless without touching
    // the invalidation rule itself. A deployment that loads different plugins
    // is a new process, and the client reloads with it.
    staleTime: Infinity,
  });
}

/* ------------------------------------------------------- items and combat */

export function useInventory() {
  return useQuery<InventoryResponse>({
    queryKey: keys.inventory(),
    queryFn: async () => InventoryResponseSchema.parse(await api("/api/inventory")),
  });
}

export function useEquip() {
  const queryClient = useQueryClient();
  return useMutation<EquipResponse, Error, EquipRequest>({
    mutationFn: async (request) =>
      EquipResponseSchema.parse(
        await api("/api/inventory/equip", { method: "PUT", body: JSON.stringify(request) }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.inventory() });
    },
  });
}

export function useUseItem() {
  const queryClient = useQueryClient();
  return useMutation<UseItemResponse, Error, string>({
    mutationFn: async (itemId) =>
      UseItemResponseSchema.parse(await api(`/api/inventory/use/${itemId}`, { method: "POST" })),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.inventory() });
      // Health changed, and both of these show it.
      void queryClient.invalidateQueries({ queryKey: keys.me() });
      void queryClient.invalidateQueries({ queryKey: keys.hospital() });
    },
  });
}

export function useShop() {
  return useQuery<ShopListResponse>({
    queryKey: keys.shop(),
    queryFn: async () => ShopListResponseSchema.parse(await api("/api/shop")),
    // A player who is nowhere gets a 409; that is a stable answer, not a
    // transient failure, so do not retry it.
    retry: false,
  });
}

export function useBuyItem() {
  const queryClient = useQueryClient();
  return useMutation<BuyItemResponse, Error, BuyItemRequest>({
    mutationFn: async (request) =>
      BuyItemResponseSchema.parse(
        await api("/api/shop/buy", { method: "POST", body: JSON.stringify(request) }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.me() });
      void queryClient.invalidateQueries({ queryKey: keys.shop() });
      void queryClient.invalidateQueries({ queryKey: keys.inventory() });
    },
  });
}

export function useCombatTargets() {
  return useQuery<CombatTargetListResponse>({
    queryKey: keys.combatTargets(),
    queryFn: async () => CombatTargetListResponseSchema.parse(await api("/api/combat/targets")),
  });
}

export function useCombatLog() {
  return useQuery<CombatLogResponse>({
    queryKey: keys.combatLog(),
    queryFn: async () => CombatLogResponseSchema.parse(await api("/api/combat/log")),
  });
}

export function useAttack() {
  const queryClient = useQueryClient();
  return useMutation<AttackResponse, Error, string>({
    mutationFn: async (targetId) =>
      AttackResponseSchema.parse(await api(`/api/combat/attack/${targetId}`, { method: "POST" })),
    onSuccess: () => {
      // Bullets and (on a kill) cash moved; the target's health and the log
      // both changed. A kill also hospitalises the target, which the WS
      // player.killed event covers for onlookers, but the attacker's own
      // mutation response is what has to refresh their own view of it here.
      void queryClient.invalidateQueries({ queryKey: keys.me() });
      void queryClient.invalidateQueries({ queryKey: keys.combatTargets() });
      void queryClient.invalidateQueries({ queryKey: keys.combatLog() });
      void queryClient.invalidateQueries({ queryKey: keys.hospital() });
      // Every shot wears the weapon, hit, miss, or backfire alike.
      void queryClient.invalidateQueries({ queryKey: keys.weaponCondition() });
    },
  });
}

export function useWeaponCondition() {
  return useQuery<WeaponConditionDto>({
    queryKey: keys.weaponCondition(),
    queryFn: async () => WeaponConditionDtoSchema.parse(await api("/api/combat/weapon")),
  });
}

export function useRepairWeapon() {
  const queryClient = useQueryClient();
  return useMutation<RepairResponse, Error, string>({
    mutationFn: async (itemId) =>
      RepairResponseSchema.parse(
        await api("/api/combat/repair", { method: "POST", body: JSON.stringify({ itemId }) }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.weaponCondition() });
      void queryClient.invalidateQueries({ queryKey: keys.me() });
    },
  });
}

export function useHospital() {
  return useQuery<HospitalStatus>({
    queryKey: keys.hospital(),
    queryFn: async () => HospitalStatusSchema.parse(await api("/api/hospital")),
    // Same shape as the jail query: the sweeper pushes `player.discharged` and
    // this slow poll only covers a dropped socket. It is now CONDITIONAL — the
    // previous version polled unconditionally, so a healthy player sitting on
    // /hospital hit the server every 2 seconds for nothing.
    refetchInterval: (query) => hospitalRefetchInterval(query.state.data),
  });
}

export function useDischarge() {
  const queryClient = useQueryClient();
  return useMutation<DischargeResponse, Error, void>({
    mutationFn: async () =>
      DischargeResponseSchema.parse(await api("/api/hospital/discharge", { method: "POST" })),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.hospital() });
      void queryClient.invalidateQueries({ queryKey: keys.me() });
    },
  });
}

/** The other patients in the caller's current town. No poll: the roster is
 *  not a countdown the tab must keep honest, and each row carries
 *  `remainingSeconds` for the local tick. */
export function useWard() {
  return useQuery<WardListResponse>({
    queryKey: keys.hospitalLocal(),
    queryFn: async () => WardListResponseSchema.parse(await api("/api/hospital/local")),
  });
}

export function useCheckin() {
  const queryClient = useQueryClient();
  return useMutation<CheckinResponse, Error, void>({
    mutationFn: async () =>
      CheckinResponseSchema.parse(await api("/api/hospital/checkin", { method: "POST" })),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.hospital() });
      void queryClient.invalidateQueries({ queryKey: keys.hospitalLocal() });
      void queryClient.invalidateQueries({ queryKey: keys.me() });
    },
  });
}

export function useDischargePlayer() {
  const queryClient = useQueryClient();
  return useMutation<DischargePlayerResponse, Error, string>({
    mutationFn: async (playerId) =>
      DischargePlayerResponseSchema.parse(
        await api("/api/hospital/discharge-player", {
          method: "POST", body: JSON.stringify({ playerId }),
        }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.hospitalLocal() });
      void queryClient.invalidateQueries({ queryKey: keys.me() });
    },
  });
}

export function useBounties() {
  return useQuery<BountyListResponse>({
    queryKey: keys.bounties(),
    queryFn: async () => BountyListResponseSchema.parse(await api("/api/bounties")),
  });
}

export function usePlaceBounty() {
  const queryClient = useQueryClient();
  return useMutation<PlaceBountyResponse, Error, PlaceBountyRequest>({
    mutationFn: async (input) =>
      PlaceBountyResponseSchema.parse(await api("/api/bounties", {
        method: "POST", body: JSON.stringify(input),
      })),
    onSuccess: () => {
      // The placer's cash moved and the list gained a row.
      void queryClient.invalidateQueries({ queryKey: keys.me() });
      void queryClient.invalidateQueries({ queryKey: keys.bounties() });
    },
  });
}

export function useDetectives() {
  return useQuery<DetectiveListResponse>({
    queryKey: keys.detectives(),
    queryFn: async () => DetectiveListResponseSchema.parse(await api("/api/detectives")),
    // Reveal and live tracking are pure reads of server time (no WS event —
    // silent to the target rules out broadcast, spec §3): poll while any row
    // is pending or actively tracking, go quiet when all are settled.
    refetchInterval: (query) => {
      const rows = query.state.data?.searches ?? [];
      const now = Date.now();
      const live = rows.some(
        (s) => s.succeeded === null || (s.succeeded === true && now < Date.parse(s.expiresAt)),
      );
      return live ? 5_000 : false;
    },
  });
}

export function useHireDetectives() {
  const queryClient = useQueryClient();
  return useMutation<HireDetectivesResponse, Error, HireDetectivesRequest>({
    mutationFn: async (input) =>
      HireDetectivesResponseSchema.parse(await api("/api/detectives", {
        method: "POST", body: JSON.stringify(input),
      })),
    onSuccess: () => {
      // The hirer's cash moved and the list gained a row.
      void queryClient.invalidateQueries({ queryKey: keys.me() });
      void queryClient.invalidateQueries({ queryKey: keys.detectives() });
    },
  });
}

export function useRemoveDetectiveSearch() {
  const queryClient = useQueryClient();
  return useMutation<RemoveDetectiveSearchResponse, Error, string>({
    mutationFn: async (searchId) =>
      RemoveDetectiveSearchResponseSchema.parse(await api(`/api/detectives/${searchId}`, {
        method: "DELETE",
      })),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.detectives() });
    },
  });
}

// ---------------------------------------------------------------------------
// Organized Crime (heists)
// ---------------------------------------------------------------------------

export function useOc() {
  return useQuery<OcStateResponse>({
    queryKey: keys.oc(),
    queryFn: async () => OcStateResponseSchema.parse(await api("/api/oc")),
  });
}

export function useCreateHeist() {
  const queryClient = useQueryClient();
  return useMutation<OcCreateResponse, Error, { buyIn: string }>({
    mutationFn: async (input) =>
      OcCreateResponseSchema.parse(await api("/api/oc", {
        method: "POST", body: JSON.stringify(input),
      })),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.oc() });
      void queryClient.invalidateQueries({ queryKey: keys.me() });
    },
  });
}

export function useInvite(heistId: string) {
  const queryClient = useQueryClient();
  return useMutation<{ invited: boolean }, Error, { targetUsername: string; role: string }>({
    mutationFn: async (input) =>
      z.object({ invited: z.boolean() }).parse(await api(`/api/oc/${heistId}/invite`, {
        method: "POST", body: JSON.stringify(input),
      })),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.oc() });
    },
  });
}

export function useAccept(heistId: string) {
  const queryClient = useQueryClient();
  return useMutation<OcCashResponse, Error, void>({
    mutationFn: async () =>
      OcCashResponseSchema.parse(await api(`/api/oc/${heistId}/accept`, { method: "POST" })),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.oc() });
      void queryClient.invalidateQueries({ queryKey: keys.me() });
    },
  });
}

export function useDecline(heistId: string) {
  const queryClient = useQueryClient();
  return useMutation<{ declined: boolean }, Error, void>({
    mutationFn: async () =>
      z.object({ declined: z.boolean() }).parse(await api(`/api/oc/${heistId}/decline`, { method: "POST" })),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.oc() });
    },
  });
}

export function useLeave(heistId: string) {
  const queryClient = useQueryClient();
  return useMutation<OcCashResponse, Error, void>({
    mutationFn: async () =>
      OcCashResponseSchema.parse(await api(`/api/oc/${heistId}/leave`, { method: "POST" })),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.oc() });
      void queryClient.invalidateQueries({ queryKey: keys.me() });
    },
  });
}

export function useCancel(heistId: string) {
  const queryClient = useQueryClient();
  return useMutation<{ cancelled: boolean }, Error, void>({
    mutationFn: async () =>
      z.object({ cancelled: z.boolean() }).parse(await api(`/api/oc/${heistId}/cancel`, { method: "POST" })),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.oc() });
      void queryClient.invalidateQueries({ queryKey: keys.me() });
    },
  });
}

export function useExecute(heistId: string) {
  const queryClient = useQueryClient();
  return useMutation<{ jobId: string }, Error, void>({
    mutationFn: async () =>
      z.object({ jobId: z.string() }).parse(await api(`/api/oc/${heistId}/execute`, { method: "POST" })),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.oc() });
    },
  });
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

export function useProperties() {
  return useQuery({
    queryKey: keys.properties(),
    queryFn: async () => PropertyListResponseSchema.parse(await api("/api/properties")),
  });
}

/** Buys `pluginId`'s franchise slot at `locationId` — not scoped to an
 *  existing row, since an unowned type may not have one yet (the row is
 *  created lazily on first purchase). */
export function useBuyProperty() {
  const queryClient = useQueryClient();
  return useMutation<{ propertyId: string }, Error, { pluginId: string; locationId: string }>({
    mutationFn: async (input) =>
      z.object({ propertyId: z.string() }).parse(
        await api("/api/properties/buy", { method: "POST", body: JSON.stringify(input) }),
      ),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: keys.properties() });
      // The buyer's cash moved.
      void queryClient.invalidateQueries({ queryKey: keys.me() });
    },
  });
}

/** Sets the owner's local lever (e.g. bullets' price-per-bullet). No cash of
 *  the caller's own moves, so only the row itself needs refreshing. */
export function useSetLever(propertyId: string) {
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: async (value) =>
      api<void>(`/api/properties/${propertyId}/lever`, {
        method: "POST", body: JSON.stringify({ value }),
      }),
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: keys.properties() }); },
  });
}

export function useTransferProperty(propertyId: string) {
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: async (username) =>
      api<void>(`/api/properties/${propertyId}/transfer`, {
        method: "POST", body: JSON.stringify({ username }),
      }),
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: keys.properties() }); },
  });
}

/** Drops the property with no refund; the row survives, unowned. */
/** Answers the refund actually paid — half the declared price, the server's
 *  figure. The page warns with the same number before it calls this. */
export function useDropProperty(propertyId: string) {
  const queryClient = useQueryClient();
  return useMutation<{ refund: string }, Error, void>({
    mutationFn: async () =>
      api<{ refund: string }>(`/api/properties/${propertyId}/drop`, { method: "POST" }),
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: keys.properties() }); },
  });
}

/** Zeroes the lifetime P&L. Moves no money. */
export function useResetProperty(propertyId: string) {
  const queryClient = useQueryClient();
  return useMutation<void, Error, void>({
    mutationFn: async () => api<void>(`/api/properties/${propertyId}/reset`, { method: "POST" }),
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: keys.properties() }); },
  });
}

// ---------------------------------------------------------------------------
// Casino
// ---------------------------------------------------------------------------

/** The tables in the town the player is standing in, plus their own open hand. */
export function useCasino() {
  return useQuery<CasinoLobbyResponse>({
    queryKey: keys.casino(),
    queryFn: async () => CasinoLobbyResponseSchema.parse(await api("/api/casino")),
  });
}

/**
 * Opens a hand. `wager` is a decimal string all the way down — it is a bigint
 * server-side, and passing it through Number here is exactly the floating-point
 * reintroduction the money rule forbids.
 *
 * A one-shot game (or blackjack dealing a natural) comes back `done: true` with
 * a payout and no session ever opens, so the caller must read `done` rather
 * than assume a hand is now in play.
 */
export function usePlayCasino() {
  const queryClient = useQueryClient();
  return useMutation<CasinoStepResponse, Error, { gameId: string; wager: string }>({
    mutationFn: async (input) =>
      CasinoStepResponseSchema.parse(
        await api("/api/casino/play", { method: "POST", body: JSON.stringify(input) }),
      ),
    onSettled: () => {
      // The wager left the player's cash whether the hand won, lost or 409'd
      // partway — refresh both even on failure.
      void queryClient.invalidateQueries({ queryKey: keys.casino() });
      void queryClient.invalidateQueries({ queryKey: keys.me() });
    },
  });
}

/**
 * Advances the caller's open hand. The action is whatever the game's own
 * `action` schema accepts (blackjack: "hit" | "stand" | "double") — the hub
 * validates only the envelope, so this stays a string here.
 */
export function useCasinoAct() {
  const queryClient = useQueryClient();
  return useMutation<CasinoStepResponse, Error, string>({
    mutationFn: async (action) =>
      CasinoStepResponseSchema.parse(
        await api("/api/casino/act", { method: "POST", body: JSON.stringify({ action }) }),
      ),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: keys.casino() });
      // A double raises the wager and a settle pays out, so cash moves here too.
      void queryClient.invalidateQueries({ queryKey: keys.me() });
    },
  });
}

/**
 * How often a seated player re-reads their table, in milliseconds.
 *
 * WS invalidation is the fast path: the hub publishes a SILENT `table` event
 * to every seat at the end of each mutating table transaction, and
 * `invalidates: ["casino"]` refreshes this query the moment anything at the
 * table moves. Silent because a blackjack hand is ~10 transitions across up
 * to five seats, which is the right amount of cache invalidation and far too
 * many feed lines — the flag is what made this possible at all.
 *
 * The poll stays as the LAZY CLOCK'S BACKSTOP, and that is now its only job:
 * the table advances because somebody read it (`advanceTable`), so a table
 * nobody is acting at produces no request for the server to publish from.
 * This interval is the worst case for a lapsed turn to be auto-stood there.
 * It was 2500 when it was also the realtime channel.
 */
export const TABLE_POLL_MS = 15_000;

/**
 * The caller's seat, wherever it is. `{ table: null }` when they hold none.
 *
 * `seated` gates the POLL, never the query: nothing else on the client knows
 * whether this player holds a seat — the lobby reports the town's tables, not
 * the caller's place at one — so the first read is what answers the question,
 * and the caller feeds the answer back in. Polling unconditionally instead
 * would hit the server forever to be told `null`, which is exactly the bug
 * the hospital query shipped (see `hospitalRefetchInterval`).
 */
export function useCasinoTable(seated: boolean) {
  return useQuery<CasinoTableResponse>({
    queryKey: keys.casinoTable(),
    queryFn: async () => CasinoTableResponseSchema.parse(await api("/api/casino/table")),
    refetchInterval: seated ? TABLE_POLL_MS : false,
  });
}

/** Takes a seat at a table of `gameId` in the caller's town, opening one if needed. */
export function useSitCasino() {
  const queryClient = useQueryClient();
  return useMutation<CasinoSitResponse, Error, string>({
    mutationFn: async (gameId) =>
      CasinoSitResponseSchema.parse(
        await api("/api/casino/table/sit", { method: "POST", body: JSON.stringify({ gameId }) }),
      ),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: keys.casinoTable() });
      // The lobby's seat counts moved too — and on a 409 the caller is seated
      // somewhere they did not expect, which only a refetch can show them.
      void queryClient.invalidateQueries({ queryKey: keys.casino() });
    },
  });
}

/**
 * Gives the seat up. `deferred` is true when a stake was still in play: the
 * seat is marked leaving and frees itself when the hand settles, so the table
 * query keeps answering until then.
 */
export function useLeaveCasino() {
  const queryClient = useQueryClient();
  return useMutation<CasinoLeaveResponse, Error, void>({
    mutationFn: async () =>
      CasinoLeaveResponseSchema.parse(
        // No body at all — the route declares no schema, and `api` omits the
        // JSON content-type when there is nothing to send (FST_ERR_CTP_EMPTY_JSON_BODY).
        await api("/api/casino/table/leave", { method: "POST" }),
      ),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: keys.casinoTable() });
      void queryClient.invalidateQueries({ queryKey: keys.casino() });
      // Leaving can SETTLE the hand on the way out (the clock runs inside
      // `leave`), which pays out — so cash can move on this route.
      void queryClient.invalidateQueries({ queryKey: keys.me() });
    },
  });
}

/**
 * Puts this hand's stake up. Answers the whole table, which is why the
 * response is written straight into the table query rather than only
 * invalidating it: the bet may have completed the table and DEALT, and without
 * the write the player watches the pre-deal table for up to a whole poll.
 */
export function useTableBet() {
  const queryClient = useQueryClient();
  return useMutation<CasinoTableResponse, Error, string>({
    mutationFn: async (wager) =>
      CasinoTableResponseSchema.parse(
        await api("/api/casino/table/bet", { method: "POST", body: JSON.stringify({ wager }) }),
      ),
    onSuccess: (table) => { queryClient.setQueryData(keys.casinoTable(), table); },
    // The escrow left the player's cash. `onSettled` rather than `onSuccess`
    // for the same reason `usePlayCasino` uses it: a refused bet moves nothing
    // (the route throws inside the transaction, which rolls the escrow back),
    // but a refetch on a failure costs one request and removes a whole class
    // of "did that take my money?" from ever being possible.
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: keys.me() }); },
  });
}

/**
 * Plays the caller's turn. The action is whatever the game's own `action`
 * schema accepts (blackjack: "hit" | "stand" | "double"); the hub validates
 * only the envelope, so it stays a string here — `useCasinoAct`'s reasoning.
 */
export function useTableAct() {
  const queryClient = useQueryClient();
  return useMutation<CasinoTableResponse, Error, string>({
    mutationFn: async (action) =>
      CasinoTableResponseSchema.parse(
        await api("/api/casino/table/act", { method: "POST", body: JSON.stringify({ action }) }),
      ),
    onSuccess: (table) => { queryClient.setQueryData(keys.casinoTable(), table); },
    // A double raises the stake and a settle pays out, so cash moves here.
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: keys.me() }); },
  });
}

// ---------------------------------------------------------------------------
// Forum
// ---------------------------------------------------------------------------

export function useForums() {
  return useQuery<ForumListResponse>({
    queryKey: keys.forums(),
    queryFn: async () => ForumListResponseSchema.parse(await api("/api/forum")),
  });
}

export function useForumTopics(forumId: string, page: number) {
  return useQuery<ForumTopicListResponse>({
    queryKey: keys.forumTopics(forumId, page),
    queryFn: async () =>
      ForumTopicListResponseSchema.parse(await api(`/api/forum/${forumId}/topics?page=${page}`)),
  });
}

export function useForumTopic(topicId: string, page: number) {
  return useQuery<ForumTopicViewResponse>({
    queryKey: keys.forumTopic(topicId, page),
    queryFn: async () =>
      ForumTopicViewResponseSchema.parse(await api(`/api/forum/topics/${topicId}?page=${page}`)),
  });
}

/** Opens a topic (and its first post) in one call. 429 `on_cooldown` carries
 *  `retryAfter` — the 60s per-player topic cooldown. */
export function useCreateTopic(forumId: string) {
  const queryClient = useQueryClient();
  return useMutation<{ topicId: string }, Error, CreateTopicRequest>({
    mutationFn: async (input) =>
      z.object({ topicId: z.string() }).parse(
        await api(`/api/forum/${forumId}/topics`, { method: "POST", body: JSON.stringify(input) }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.forumTopicsAll(forumId) });
      // topicCount on the forum list moved too.
      void queryClient.invalidateQueries({ queryKey: keys.forums() });
    },
  });
}

/** Replies to a topic. 429 `on_cooldown` carries `retryAfter` — the 15s
 *  per-player post cooldown; 409 `topic_locked` when a moderator closed it. */
export function useCreatePost(topicId: string) {
  const queryClient = useQueryClient();
  return useMutation<{ postId: string }, Error, CreatePostRequest>({
    mutationFn: async (input) =>
      z.object({ postId: z.string() }).parse(
        await api(`/api/forum/topics/${topicId}/posts`, { method: "POST", body: JSON.stringify(input) }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.forumTopicAll(topicId) });
      // `postCount`/`lastPostAt` on some forum's topic list moved too, and this
      // hook doesn't know which forum that is — ForumTopicSchema carries no
      // `forumId` — so the whole prefix goes rather than a key it can't build.
      void queryClient.invalidateQueries({ queryKey: keys.forum() });
    },
  });
}

/** Moderator-only (`forum` or `*` grant), checked server-side too. */
export function useLockTopic(topicId: string) {
  const queryClient = useQueryClient();
  return useMutation<void, Error, boolean>({
    mutationFn: async (locked) =>
      api<void>(`/api/forum/topics/${topicId}/lock`, {
        method: "POST", body: JSON.stringify({ locked }),
      }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: keys.forumTopicAll(topicId) }); },
  });
}

/** Moderator-only. Sets a topic sticky or normal. */
export function useSetTopicType(topicId: string) {
  const queryClient = useQueryClient();
  return useMutation<void, Error, "normal" | "sticky">({
    mutationFn: async (type) =>
      api<void>(`/api/forum/topics/${topicId}/type`, {
        method: "POST", body: JSON.stringify({ type }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.forumTopicAll(topicId) });
      // Sort order (sticky-first) on the forum's topic list moved too.
      void queryClient.invalidateQueries({ queryKey: keys.forum() });
    },
  });
}

/** Moderator-only. Deletes one post; `postId` is the mutation input. */
export function useDeletePost(topicId: string) {
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: async (postId) => api<void>(`/api/forum/posts/${postId}`, { method: "DELETE" }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: keys.forumTopicAll(topicId) }); },
  });
}

/** Moderator-only. Deletes a whole topic — its posts cascade server-side. */
export function useDeleteTopic() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: async (topicId) => api<void>(`/api/forum/topics/${topicId}`, { method: "DELETE" }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: keys.forum() }); },
  });
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export function useAdminSections() {
  const me = useMe();
  return useQuery<AdminSectionsResponse>({
    queryKey: keys.adminSections(),
    queryFn: async () => AdminSectionsResponseSchema.parse(await api("/api/admin/plugins")),
    enabled: (me.data?.grants.length ?? 0) > 0,
    retry: false,
  });
}
