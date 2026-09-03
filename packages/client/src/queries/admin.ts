import { useQuery } from "@tanstack/react-query";
import {
  AdminSectionsResponseSchema,
  type AdminSectionsResponse,
} from "@gl3/shared";
import { api } from "../api/client.js";
import { keys } from "../api/keys.js";
import { useMe } from "./core.js";

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
