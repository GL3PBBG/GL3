import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  AdminSectionsResponseSchema,
  AttackResponseSchema, AuthResponseSchema, BankStatusResponseSchema,
  BountyListResponseSchema,
  BuyBulletsResponseSchema, BuyItemResponseSchema, CombatLogResponseSchema,
  CombatTargetListResponseSchema, CommitCrimeResponseSchema, CrimeListResponseSchema,
  DetectiveListResponseSchema, DischargeResponseSchema, EquipResponseSchema, GangBankResponseSchema,
  GangDtoSchema, GangInviteListResponseSchema, GangLogListResponseSchema,
  GangMemberListResponseSchema, HireDetectivesResponseSchema, HospitalStatusSchema,
  InventoryResponseSchema, JailStatusSchema,
  LeaderboardResponseSchema,
  LocationListResponseSchema, MailDtoSchema, MailListResponseSchema, MeResponseSchema,
  NewsListResponseSchema, NotificationListResponseSchema, OcCashResponseSchema,
  OcCreateResponseSchema, OcStateResponseSchema, PlaceBountyResponseSchema,
  PluginsPayloadSchema,
  ProfileDtoSchema, RankListResponseSchema, RemoveDetectiveSearchResponseSchema,
  RepairResponseSchema,
  ShopListResponseSchema, TravelResponseSchema,
  UseItemResponseSchema,
  WeaponConditionDtoSchema,
  type AdminSectionsResponse,
  type AttackResponse, type BankStatusResponse, type BountyListResponse,
  type BuyBulletsResponse,
  type BuyItemRequest, type BuyItemResponse, type CombatLogResponse,
  type CombatTargetListResponse, type CreateGangRequest,
  type CrimeListResponse,
  type DetectiveListResponse, type DischargeResponse,
  type EquipRequest, type EquipResponse,
  type GangBankResponse, type GangDto, type GangInviteListResponse,
  type GangLogListResponse, type GangMemberListResponse, type GangPermission,
  type HireDetectivesRequest, type HireDetectivesResponse,
  type HospitalStatus, type InventoryResponse,
  type JailStatus, type LeaderboardKind, type LeaderboardResponse,
  type LocationListResponse, type MailDto, type MailListResponse, type MeResponse,
  type NewsListResponse, type NotificationListResponse,
  type OcCashResponse, type OcCreateResponse, type OcStateResponse,
  type PlaceBountyRequest, type PlaceBountyResponse, type PluginsPayload,
  type ProfileDto, type RankListResponse, type RemoveDetectiveSearchResponse,
  type RepairResponse,
  type ShopListResponse, type UpdateProfileRequest,
  type UseItemResponse,
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
