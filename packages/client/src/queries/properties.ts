import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  PropertyListResponseSchema,
} from "@gl3/shared";
import { api } from "../api/client.js";
import { keys } from "../api/keys.js";

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
