import { coreDashboard, coreHud, coreMenuBadges } from "@gl3/plugin-sdk";
import { DashboardWidgetSchema, HudEntrySchema, MenuBadgeSchema } from "@gl3/shared";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { z } from "zod";
import type { PluginCtxDeps } from "./ctx.js";
import type { CoreFilters } from "./core-filters.js";
import { loadSnapshot } from "./routes.js";

/**
 * Per-contribution server-side validation, applied after each collect-policy
 * filter chain returns. `coreFilters.apply` trusts subscribers to shape their
 * return value correctly, but a `PLUGIN_PACKAGES`-loaded plugin is never
 * typechecked against the shared schemas — only a `.strict()` client-side
 * parse would catch a malformed entry, and that parse is all-or-nothing
 * (`HudExtrasResponseSchema` etc.), so one bad entry would fail the whole
 * seam for every caller. Drop-and-log mirrors collect policy's own "one
 * subscriber's failure costs its own contribution" semantics, moved from the
 * subscriber-throws case (already handled by `runFilterChain`) to the
 * subscriber-returns-garbage case.
 */
function validateEach<T>(
  schema: z.ZodType<T>, entries: readonly unknown[], pointName: string, log: FastifyBaseLogger,
): T[] {
  const valid: T[] = [];
  for (const entry of entries) {
    const parsed = schema.safeParse(entry);
    if (parsed.success) {
      valid.push(parsed.data);
    } else {
      log.warn({ pointName, entry, issues: parsed.error.issues }, "dropped a malformed extension contribution");
    }
  }
  return valid;
}

/**
 * Core-owned reads over the three collect-policy extension points that have
 * no other route to live on (`core.profileView` and `core.moneyFormat`
 * already ride the profile route and `/api/plugins` respectively — see
 * `core-profile-extras.test.ts`). Each applies its filter chain against the
 * CALLER's own `PlayerSnapshot`, loaded fresh per request the same way
 * `registerPluginRoutes` does for a plugin route — there is no caching, so a
 * subscriber always sees the caller's current cash/gang/jail state.
 */
export function registerExtensionRoutes(app: FastifyInstance, deps: PluginCtxDeps, coreFilters: CoreFilters): void {
  app.get("/api/hud/extras", { preHandler: [app.requireAuth] }, async (request, reply) => {
    if (request.playerId === undefined) return reply.code(401).send({ error: "unauthorized" });
    const snapshot = await loadSnapshot(deps, request.playerId);
    const entries = await coreFilters.apply(coreHud, snapshot, []);
    return { entries: validateEach(HudEntrySchema, entries, coreHud.name, request.log) };
  });

  app.get("/api/menu/badges", { preHandler: [app.requireAuth] }, async (request, reply) => {
    if (request.playerId === undefined) return reply.code(401).send({ error: "unauthorized" });
    const snapshot = await loadSnapshot(deps, request.playerId);
    const badges = await coreFilters.apply(coreMenuBadges, snapshot, []);
    return { badges: validateEach(MenuBadgeSchema, badges, coreMenuBadges.name, request.log) };
  });

  app.get("/api/dashboard/widgets", { preHandler: [app.requireAuth] }, async (request, reply) => {
    if (request.playerId === undefined) return reply.code(401).send({ error: "unauthorized" });
    const snapshot = await loadSnapshot(deps, request.playerId);
    const widgets = await coreFilters.apply(coreDashboard, snapshot, []);
    return { widgets: validateEach(DashboardWidgetSchema, widgets, coreDashboard.name, request.log) };
  });
}
