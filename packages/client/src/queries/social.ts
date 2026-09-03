import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  GangBankResponseSchema,
  GangDtoSchema,
  GangInviteListResponseSchema,
  GangLogListResponseSchema,
  GangMemberListResponseSchema,
  MailDtoSchema,
  MailListResponseSchema,
  NewsListResponseSchema,
  NotificationListResponseSchema,
  OnlineListResponseSchema,
  PlayerSearchResponseSchema,
  ProfileDtoSchema,
  type CreateGangRequest,
  type GangBankResponse,
  type GangDto,
  type GangInviteListResponse,
  type GangLogListResponse,
  type GangMemberListResponse,
  type GangPermission,
  type MailDto,
  type MailListResponse,
  type NewsListResponse,
  type NotificationListResponse,
  type OnlineListResponse,
  type PlayerSearchResponse,
  type ProfileDto,
  type UpdateProfileRequest,
} from "@gl3/shared";
import { api } from "../api/client.js";
import { keys } from "../api/keys.js";

/* ------------------------------------------------------------------ social
 *
 * Every hook below takes the ids its URL needs as *definite* strings. The
 * pages mount these behind a component that already has the player (and,
 * where relevant, the gang) loaded, which keeps `enabled` guards and
 * `?? ""` placeholder keys out of the cache entirely.
 */

export function useProfile(playerId: string, enabled = true) {
  return useQuery<ProfileDto>({
    queryKey: keys.profile(playerId),
    queryFn: async () => ProfileDtoSchema.parse(await api(`/api/players/${playerId}/profile`)),
    enabled,
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

/** Find a player by name. `enabled` is the caller's — the server refuses a
 *  term under two characters, so the page holds the query back until the
 *  debounced input is long enough rather than spending a 400 on every
 *  first keystroke. */
export function usePlayerSearch(q: string, enabled: boolean) {
  return useQuery<PlayerSearchResponse>({
    queryKey: keys.playerSearch(q),
    queryFn: async () => PlayerSearchResponseSchema.parse(
      await api(`/api/players/search?q=${encodeURIComponent(q)}`),
    ),
    enabled,
  });
}
