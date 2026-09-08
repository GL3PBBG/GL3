import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IdSchema, MoneySchema } from "@gl3/shared";
import { z } from "zod";
import { api } from "../api/client.js";
import { keys } from "../api/keys.js";

// The theft plugin serves table rows: numbers and booleans are strings on
// the wire. Preserve quoted money as strings and validate before drawing
// condition bars or enabling an action for the caller's current city.
export const GarageResponseSchema = z.object({
  rows: z.array(z.object({
    id: IdSchema,
    carName: z.string(),
    image: z.string(),
    damage: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(0).max(100)),
    locationName: z.string(),
    saleValue: MoneySchema,
    repairCost: MoneySchema,
    here: z.enum(["yes", "no"]).transform((value) => value === "yes"),
  })),
});
export type GarageCar = z.infer<typeof GarageResponseSchema>["rows"][number];

export function useGarage() {
  return useQuery({
    queryKey: keys.garage(),
    queryFn: async () => GarageResponseSchema.parse(await api("/api/garage")),
  });
}

type GarageAction = { action: "sell" | "repair"; garageId: string };
const SaleResponseSchema = z.object({ payout: MoneySchema });
const RepairResponseSchema = z.object({ cost: MoneySchema });

export function useGarageAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ action, garageId }: GarageAction) => {
      const response = await api(`/api/garage/${action}`, {
        method: "POST", body: JSON.stringify({ garageId }),
      });
      if (action === "sell") return { action, ...SaleResponseSchema.parse(response) } as const;
      // A concurrent repair may have restored the car already: 204 means
      // no charge, not a malformed response or a second repair fee.
      return { action, cost: response === undefined ? null : RepairResponseSchema.parse(response).cost } as const;
    },
    onSettled: async () => {
      // Repair emits no event. Also refresh after refusals (or a lost HTTP
      // response) so stale condition, ownership, location and cash reconcile.
      await Promise.all([
        keys.garage(), keys.me(), keys.locations(), keys.hudExtras(), keys.menuBadges(),
      ].map((queryKey) => queryClient.invalidateQueries({ queryKey })));
    },
  });
}
