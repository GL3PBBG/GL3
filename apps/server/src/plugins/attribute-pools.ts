import type { AttributePoolDecl, PluginManifest, Pool } from "@gl3/plugin-sdk";

/**
 * Every declared pool, keyed by pool name. Pure — recomputed at each call
 * site rather than cached, exactly like `collectPropertyTypes` next door.
 *
 * Two plugins declaring the same pool is a hard boot failure rather than a
 * last-writer-wins: two different regen rates for one column is not a
 * situation with a right answer, and catching it at install time matches the
 * loader's trust model (a plugin is trusted once installed, not audited at
 * request time).
 */
export function collectAttributePools(
  manifests: readonly PluginManifest[],
): Map<Pool, AttributePoolDecl> {
  const registry = new Map<Pool, AttributePoolDecl>();
  for (const manifest of manifests) {
    for (const decl of manifest.providesAttributes) {
      if (registry.has(decl.pool)) {
        throw new Error(
          `plugin validation failed — attribute pool "${decl.pool}" is declared by more than one plugin`,
        );
      }
      registry.set(decl.pool, decl);
    }
  }
  return registry;
}

/**
 * Membership-scaled regen (C spec §1.3), as one shared decision so the
 * authoritative settle (ctx.ts's settleAll, under the player lock) and the
 * display settle (/api/auth/me) can never disagree: a member must not SEE
 * less regen than they get. Pure — callers read the membership timer
 * themselves and pass the liveness boolean.
 */
export function memberRegenMultiplier(
  decl: { memberMultiplier?: number | undefined } | null,
  memberLive: boolean,
): number {
  return memberLive && decl?.memberMultiplier !== undefined ? decl.memberMultiplier : 1;
}
