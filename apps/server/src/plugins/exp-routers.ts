import type { ExpApplier, PluginManifest } from "@gl3/plugin-sdk";

/**
 * The boot-static exp-routing registry (C spec §1.2, amending audit §7
 * item 8's wording): a plugin claims ALL exp application by carrying
 * `applyExp` on its manifest, and `tx.economy.applyExpAndRankUp` diverts to
 * the claimant inside the caller's transaction — the rank ladder receives
 * nothing, which is the economy guard that keeps GL3's seeded,
 * reward-bearing rank ladder from becoming an unintended faucet on an
 * MCCodes-profile game.
 *
 * Exactly one claimant or none — never two. Two different level ladders for
 * one exp stream is not a situation with a right answer, and catching it at
 * boot matches the loader's trust model (the same reasoning as
 * `collectAttributePools`' duplicate-pool failure next door).
 */
export function collectExpRouters(manifests: readonly PluginManifest[]): ExpApplier | null {
  const claimants = manifests
    .filter((m) => m.applyExp !== null)
    .map((m) => ({ id: m.id, applyExp: m.applyExp as ExpApplier }));
  if (claimants.length > 1) {
    const ids = claimants.map((c) => `"${c.id}"`).join(", ");
    throw new Error(
      `plugin validation failed — exp routing is claimed by more than one plugin: ${ids}`,
    );
  }
  return claimants[0]?.applyExp ?? null;
}
