import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  OcCashResponseSchema,
  OcCreateResponseSchema,
  OcStateResponseSchema,
  type OcCashResponse,
  type OcCreateResponse,
  type OcStateResponse,
} from "@gl3/shared";
import { api } from "../api/client.js";
import { keys } from "../api/keys.js";

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
