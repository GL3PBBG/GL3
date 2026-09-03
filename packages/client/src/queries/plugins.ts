import { useQuery } from "@tanstack/react-query";
import {
  DashboardWidgetsResponseSchema,
  HudExtrasResponseSchema,
  MenuBadgesResponseSchema,
  PluginsPayloadSchema,
  type DashboardWidgetsResponse,
  type HudExtrasResponse,
  type MenuBadgesResponse,
  type PluginsPayload,
} from "@gl3/shared";
import { api } from "../api/client.js";
import { keys } from "../api/keys.js";

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

/** Extra chrome the loaded plugins contribute to the HUD, via `hud.extras`. */
export function useHudExtras() {
  return useQuery<HudExtrasResponse>({
    queryKey: keys.hudExtras(),
    queryFn: async () => HudExtrasResponseSchema.parse(await api("/api/hud/extras")),
  });
}

/** Nav-link counts a plugin wants shown, keyed by the link's own path — see
 *  `menu.badges`. */
export function useMenuBadges() {
  return useQuery<MenuBadgesResponse>({
    queryKey: keys.menuBadges(),
    queryFn: async () => MenuBadgesResponseSchema.parse(await api("/api/menu/badges")),
  });
}

/** Panels a plugin contributes to the dashboard, via `dashboard.widgets`. */
export function useDashboardWidgets() {
  return useQuery<DashboardWidgetsResponse>({
    queryKey: keys.dashboardWidgets(),
    queryFn: async () => DashboardWidgetsResponseSchema.parse(await api("/api/dashboard/widgets")),
  });
}
