import { definePlugin, type PluginCtx } from "@gl3/plugin-sdk";
import { eq } from "drizzle-orm";
import { detectiveSearches } from "./schema.js";

/**
 * V2's detectives module, GL3-shaped: the cross-location hunting layer.
 * Spec: docs/superpowers/specs/2026-08-12-detectives-design.md.
 * Uses core's `detective_searches` table (no plugin migrations); no combat
 * coupling; no events, menu or pages (plugin-manifest-endpoint.test.ts pins
 * the no-arg boot payload).
 */

// ---------------------------------------------------------------------------
// Resolve job — the roll happens HERE, seeded, not at hire time (spec §2):
// a BullMQ retry replays the same seed and the plugin_job_runs claim aborts
// it anyway. The outcome sits hidden in the row until ends_at (time-gated
// reveal) — no delayed job needed.
// ---------------------------------------------------------------------------

async function resolveJob(ctx: PluginCtx, data: Record<string, unknown>): Promise<void> {
  const searchId = String(data["searchId"]);
  const detectives = Number(data["detectives"]);
  const hours = Number(data["hours"]);
  const rng = ctx.job?.rng;
  if (rng === undefined) throw new Error("resolve job ran without a seeded rng");

  // One ctx.transaction per handler: the plugin_job_runs claim is structural
  // (first insert inside it), so a retry throws JobAlreadyAppliedError before
  // this callback runs.
  await ctx.transaction(async (tx) => {
    const [row] = await tx.db.select({ id: detectiveSearches.id })
      .from(detectiveSearches).where(eq(detectiveSearches.id, searchId));
    if (!row) return; // removed between enqueue and resolve

    // V2's formula: dets × 4 × hours percent (1–5 × 1–5 → 4%..100%).
    // rng.int is max-exclusive, so a draw of 0..99 against 100 always wins.
    const chancePercent = detectives * 4 * hours;
    const succeeded = rng.int(0, 100) < chancePercent;
    await tx.db.update(detectiveSearches).set({ succeeded })
      .where(eq(detectiveSearches.id, searchId));
  });
}

export default definePlugin({
  id: "detectives",
  version: "1.0.0",
  basePaths: ["/api/detectives"],
  routes: [],
  jobs: { resolve: resolveJob },
});
