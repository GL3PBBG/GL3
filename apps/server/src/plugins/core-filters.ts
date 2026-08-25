import type { FilterPoint, PlayerSnapshot, PluginCtx, PluginManifest } from "@gl3/plugin-sdk";
import { runFilterChain } from "@gl3/plugin-sdk";
import { collectAssetSlots } from "./asset-slots.js";
import { createPluginCtx, type PluginCtxDeps } from "./ctx.js";
import { collectAttributePools } from "./attribute-pools.js";
import { collectPropertyTypes } from "./property-types.js";
import { collectFilters } from "./routes.js";

export interface CoreFilters {
  apply<T>(point: FilterPoint<T>, player: PlayerSnapshot | null, value: T): Promise<T>;
}

/**
 * The core-route-facing counterpart of `registerPluginRoutes`'s per-request
 * ctx build: same option collection (`collectFilters`, `collectPropertyTypes`,
 * `collectAttributePools`, `collectAssetSlots`, `installedPluginIds`), but
 * built once at load time and reused across every `apply` call — there is no
 * per-request boundary here, since core routes (not plugin routes) are the
 * caller.
 *
 * `player` differs per call, so the per-owner ctx built inside one `apply`
 * is memoized only for the lifetime of that call, never across calls — a
 * `Map` allocated fresh on each `apply` invocation rather than closed over
 * at `buildCoreFilters` scope.
 */
export function buildCoreFilters(deps: PluginCtxDeps, manifests: readonly PluginManifest[]): CoreFilters {
  const bound = collectFilters(manifests);
  const propertyTypes = collectPropertyTypes(manifests);
  const attributePools = collectAttributePools(manifests);
  const installedPluginIds = new Set(manifests.map((m) => m.id));
  const assetSlots = collectAssetSlots(manifests);

  return {
    apply<T>(point: FilterPoint<T>, player: PlayerSnapshot | null, value: T): Promise<T> {
      // Fresh per `apply` call — `player` varies call to call, and reusing a
      // ctx built for a different player across calls would leak it.
      const ctxCache = new Map<string, PluginCtx>();
      const ctxFor = (ownerId: string): PluginCtx => {
        let ctx = ctxCache.get(ownerId);
        if (ctx === undefined) {
          ctx = createPluginCtx(deps, {
            pluginId: ownerId,
            player,
            job: null,
            filters: bound,
            propertyTypes,
            attributePools,
            installedPluginIds,
            assetSlots,
          });
          ctxCache.set(ownerId, ctx);
        }
        return ctx;
      };
      return runFilterChain(bound, point, ctxFor, value);
    },
  };
}
