import { coreMoneyFormat, type PluginManifest, type ViewNode } from "@gl3/plugin-sdk";
import { DEFAULT_MONEY_FORMAT, MoneyFormatSchema, type NavCategoryId } from "@gl3/shared";
import type { FastifyInstance } from "fastify";
import { stampAssetBinderScope } from "./asset-slots.js";
import type { CoreFilters } from "./core-filters.js";

export interface MenuItem {
  pageId: string; path: string; label: string; order: number;
  /** The page's declared nav home (`menu.category`). Omitted, never `undefined`. */
  category?: NavCategoryId;
}
export interface PagePayload { pluginId: string; id: string; path: string; view: ViewNode }
export interface EventMeta {
  pluginId: string; name: string; describe: string; invalidates: string[];
  /** Feed suppression (`PluginEventDecl.silent`). Omitted, never `false`. */
  silent?: boolean;
}
/** The boot-built payload — static across every request. `moneyFormat` is
 * resolved per request in `registerPluginsEndpoint` instead, since it flows
 * through the `core.moneyFormat` filter chain rather than being fixed at boot. */
export interface PluginsPayload {
  menu: MenuItem[]; pages: PagePayload[]; events: EventMeta[];
  /** Every installed plugin id, sorted — the client's feature detection. */
  installed: string[];
}

/** Which bundled set a boot loaded — see `plugins/core-plugins.ts`. */
export type Gl3Profile = "gl3" | "v2" | "mccodes" | "framework";

/**
 * Core-owned gameplay screens that ride the plugin payload so the client
 * shows them exactly when the server serves them. Jail and hospital are core
 * modules, not plugins — but their pages behave like plugin pages: they
 * appear in `pages`/`menu` only when the profile registers their routes, so
 * a framework boot's nav and routes lose them with zero client-side
 * mechanism. The view is a stub because the client renders a hand-written
 * override for these ids (apps/web PAGE_OVERRIDES) and never falls through
 * to the schema view.
 */
const FULL_PROFILE_CORE_PAGES = [
  { id: "jail", label: "Jail", order: 38, category: "town" },
  { id: "hospital", label: "Hospital", order: 39, category: "town" },
] as const;

/**
 * Pure and called once at boot (spec: Boot sequence step 6) — the payload is
 * identical for every player in v1, so rebuilding it per request would be
 * work with no result to show for it.
 */
export function buildPluginsPayload(
  manifests: readonly PluginManifest[],
  profile: Gl3Profile = "v2",
): PluginsPayload {
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
        menu.push({
          pageId: page.id, path: page.path, label: page.menu.label, order: page.menu.order,
          // Spread, like `silent` below: a page that declares no category
          // produces no key at all, so the payload a pre-category manifest
          // builds is byte-for-byte what it was and the client's map fallback
          // still owns it.
          ...(page.menu.category !== undefined ? { category: page.menu.category } : {}),
        });
      }
    }
    for (const event of manifest.events) {
      events.push({
        pluginId: manifest.id, name: event.name,
        describe: event.describe, invalidates: event.invalidates,
        // Spread rather than assigned, so a declaration that says nothing
        // about silence produces no `silent` key at all. `EventMetaSchema`
        // has it `.optional()` inside a `.strict()` object, and the payload
        // every plugin written before the flag existed builds is byte-for-byte
        // what it was.
        ...(event.silent === true ? { silent: true } : {}),
      });
    }
  }

  if (profile !== "framework") {
    for (const page of FULL_PROFILE_CORE_PAGES) {
      pages.push({
        pluginId: "core", id: page.id, path: `/plugins/${page.id}`,
        view: { kind: "list", items: [] },
      });
      menu.push({ pageId: page.id, path: `/plugins/${page.id}`, label: page.label, order: page.order, category: page.category });
    }
  }

  // Ties break on page id so the order is stable across boots rather than
  // depending on the config's plugin order.
  menu.sort((a, b) => a.order - b.order || a.pageId.localeCompare(b.pageId));
  const installed = manifests.map((m) => m.id).sort();
  return { menu, pages, events, installed };
}

export function registerPluginsEndpoint(app: FastifyInstance, payload: PluginsPayload, coreFilters: CoreFilters): void {
  app.get("/api/plugins", { preHandler: [app.requireAuth] }, async (request) => {
    const applied = await coreFilters.apply(coreMoneyFormat, null, DEFAULT_MONEY_FORMAT);
    // `PluginsPayloadSchema` is `.strict()` and parsed all-or-nothing on the
    // client — a malformed `coreMoneyFormat` return would take down the WHOLE
    // plugin payload (nav, pages, events), the same defect class the casino
    // cluster's `cards`-leaf parity bug fixed at 0.1.6. Fall back to the
    // default rather than let one bad subscriber blank the entire client.
    const parsed = MoneyFormatSchema.safeParse(applied);
    if (!parsed.success) {
      request.log.warn(
        { pointName: coreMoneyFormat.name, value: applied, issues: parsed.error.issues },
        "dropped a malformed core.moneyFormat contribution; falling back to the default",
      );
    }
    return { ...payload, moneyFormat: parsed.success ? parsed.data : DEFAULT_MONEY_FORMAT };
  });
}
