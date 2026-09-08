import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { api } from "../api/client.js";
import { keys } from "../api/keys.js";

const AvailabilitySchema = z.object({
  minLevel: z.number().int().nonnegative(),
  townMinLevel: z.number().int().nonnegative(),
});

/** Optional plugin endpoint: never request it unless brothel is installed. */
export function useBrothelAvailability(enabled: boolean) {
  return useQuery({
    queryKey: keys.brothelAvailability(),
    queryFn: async () => AvailabilitySchema.parse(await api("/api/brothel/availability")),
    enabled,
    retry: false,
  });
}
