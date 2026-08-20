import { coreDashboard, coreHud, coreMenuBadges } from "@gl3/plugin-sdk";
import type { FastifyInstance } from "fastify";
import type { PluginCtxDeps } from "./ctx.js";
import type { CoreFilters } from "./core-filters.js";
import { loadSnapshot } from "./routes.js";

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
    return { entries: await coreFilters.apply(coreHud, snapshot, []) };
  });

  app.get("/api/menu/badges", { preHandler: [app.requireAuth] }, async (request, reply) => {
    if (request.playerId === undefined) return reply.code(401).send({ error: "unauthorized" });
    const snapshot = await loadSnapshot(deps, request.playerId);
    return { badges: await coreFilters.apply(coreMenuBadges, snapshot, []) };
  });

  app.get("/api/dashboard/widgets", { preHandler: [app.requireAuth] }, async (request, reply) => {
    if (request.playerId === undefined) return reply.code(401).send({ error: "unauthorized" });
    const snapshot = await loadSnapshot(deps, request.playerId);
    return { widgets: await coreFilters.apply(coreDashboard, snapshot, []) };
  });
}
