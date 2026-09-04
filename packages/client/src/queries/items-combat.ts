import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AttackResponseSchema,
  BountyListResponseSchema,
  BuyItemResponseSchema,
  CheckinResponseSchema,
  CombatLogResponseSchema,
  CombatTargetListResponseSchema,
  DetectiveListResponseSchema,
  DischargePlayerResponseSchema,
  DischargeResponseSchema,
  EquipResponseSchema,
  HireDetectivesResponseSchema,
  HospitalStatusSchema,
  InventoryResponseSchema,
  PlaceBountyResponseSchema,
  RemoveDetectiveSearchResponseSchema,
  RepairResponseSchema,
  ShopListResponseSchema,
  UseItemResponseSchema,
  WardListResponseSchema,
  WeaponConditionDtoSchema,
  type AttackResponse,
  type BountyListResponse,
  type BuyItemRequest,
  type BuyItemResponse,
  type CheckinResponse,
  type CombatLogResponse,
  type CombatTargetListResponse,
  type DetectiveListResponse,
  type DischargePlayerResponse,
  type DischargeResponse,
  type EquipRequest,
  type EquipResponse,
  type HireDetectivesRequest,
  type HireDetectivesResponse,
  type HospitalStatus,
  type InventoryResponse,
  type PlaceBountyRequest,
  type PlaceBountyResponse,
  type RemoveDetectiveSearchResponse,
  type RepairResponse,
  type ShopListResponse,
  type UseItemResponse,
  type WardListResponse,
  type WeaponChoice,
  type WeaponConditionDto,
} from "@gl3/shared";
import { api } from "../api/client.js";
import { keys } from "../api/keys.js";
import { hospitalRefetchInterval } from "./shared.js";

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
      // The combat page's weapon panel describes both slots; an equip is
      // the one thing besides a shot that changes what it should say.
      void queryClient.invalidateQueries({ queryKey: keys.weaponCondition() });
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

/**
 * "Here now" is polled, like `useOnline`, because the fact that would refresh
 * it is never pushed to the people it matters to: `player.travelled` goes to
 * the traveller alone (its audience is deliberately private — fare and route
 * are theirs), so a player who leaves town is never announced to the town
 * they left. Without this a bystander's row lingers until the tab refocuses,
 * and a shot at it 409s target_elsewhere after the cooldown is already
 * claimed. Combat's own events (attacked/killed/hospitalised) still
 * invalidate the list immediately; the poll covers only departures.
 */
export const COMBAT_TARGETS_POLL_MS = 30_000;

export function useCombatTargets() {
  return useQuery<CombatTargetListResponse>({
    queryKey: keys.combatTargets(),
    queryFn: async () => CombatTargetListResponseSchema.parse(await api("/api/combat/targets")),
    refetchInterval: COMBAT_TARGETS_POLL_MS,
  });
}

export function useCombatLog() {
  return useQuery<CombatLogResponse>({
    queryKey: keys.combatLog(),
    queryFn: async () => CombatLogResponseSchema.parse(await api("/api/combat/log")),
  });
}

/** A target, and optionally which slot to fire — see `AttackRequestSchema`. */
export interface AttackInput {
  targetId: string;
  weapon?: WeaponChoice;
}

export function useAttack() {
  const queryClient = useQueryClient();
  return useMutation<AttackResponse, Error, AttackInput>({
    // The body is sent only when a weapon was chosen: a bodyless POST is
    // what every caller sent before the choice existed, and the server's
    // precedence answers it byte-identically.
    mutationFn: async ({ targetId, weapon }) =>
      AttackResponseSchema.parse(await api(`/api/combat/attack/${targetId}`, {
        method: "POST",
        ...(weapon === undefined ? {} : { body: JSON.stringify({ weapon }) }),
      })),
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
