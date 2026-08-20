import { coreMoneyFormat, type PluginManifest, type ViewNode } from "@gl3/plugin-sdk";
import { DEFAULT_MONEY_FORMAT } from "@gl3/shared";
import type { FastifyInstance } from "fastify";
import { stampAssetBinderScope } from "./asset-slots.js";
import type { CoreFilters } from "./core-filters.js";

export interface MenuItem { pageId: string; path: string; label: string; order: number }
export interface PagePayload { pluginId: string; id: string; path: string; view: ViewNode }
export interface EventMeta { pluginId: string; name: string; describe: string; invalidates: string[] }
/** The boot-built payload — static across every request. `moneyFormat` is
 * resolved per request in `registerPluginsEndpoint` instead, since it flows
 * through the `core.moneyFormat` filter chain rather than being fixed at boot. */
export interface PluginsPayload {
  menu: MenuItem[]; pages: PagePayload[]; events: EventMeta[];
}

/**
 * Pure and called once at boot (spec: Boot sequence step 6) — the payload is
 * identical for every player in v1, so rebuilding it per request would be
 * work with no result to show for it.
 */
export function buildPluginsPayload(manifests: readonly PluginManifest[]): PluginsPayload {
  const menu: MenuItem[] = [];
  const pages: PagePayload[] = [];
  const events: EventMeta[] = [];

  for (const manifest of manifests) {
    for (const page of manifest.pages) {
      // Stamped, not copied: a `slotImage` on a player page needs the declaring
      // plugin's id to know which scope's art to ask for, and the author never
      // writes it. (`assetBinder` is admin-only and stamped in admin/routes.ts,
      // but the same pass covers both.)
      pages.push({
        pluginId: manifest.id, id: page.id, path: page.path,
        view: stampAssetBinderScope(page.view, manifest.id),
      });
      if (page.menu !== undefined) {
        menu.push({ pageId: page.id, path: page.path, label: page.menu.label, order: page.menu.order });
      }
    }
    for (const event of manifest.events) {
      events.push({
        pluginId: manifest.id, name: event.name,
        describe: event.describe, invalidates: event.invalidates,
      });
    }
  }

  // Ties break on page id so the order is stable across boots rather than
  // depending on the config's plugin order.
  menu.sort((a, b) => a.order - b.order || a.pageId.localeCompare(b.pageId));
  return { menu, pages, events };
}

export function registerPluginsEndpoint(app: FastifyInstance, payload: PluginsPayload, coreFilters: CoreFilters): void {
  app.get("/api/plugins", { preHandler: [app.requireAuth] }, async () => ({
    ...payload,
    moneyFormat: await coreFilters.apply(coreMoneyFormat, null, DEFAULT_MONEY_FORMAT),
  }));
}
