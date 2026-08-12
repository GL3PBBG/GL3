import { definePlugin, InsufficientFundsError, PluginError, route, type PluginCtx } from "@gl3/plugin-sdk";
import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { detectiveSearches, players } from "./schema.js";

/**
 * V2's detectives module, GL3-shaped: the cross-location hunting layer.
 * Spec: the offline design note.
 * Uses core's `detective_searches` table (no plugin migrations); no combat
 * coupling; no events, menu or pages (plugin-manifest-endpoint.test.ts pins
 * the no-arg boot payload).
 */

// ---------------------------------------------------------------------------
// Settings, read at boot (restart to retune — system-wide limitation).
// Plugin-side keys are bare; the ctx prepends "detectives." (ctx.ts:289).
// Spec deviation recorded there: V2's shipped detectiveDuration default of
// `1` second is treated as a bug — GL3 defaults to a real hour.
// ---------------------------------------------------------------------------

const DEFAULT_COST = 125_000n;
const DEFAULT_DURATION_SECONDS = 3600;
const DEFAULT_EXPIRE_SECONDS = 600;

type Settings = { get(key: string): string | null };

function readCost(settings: Settings): bigint {
  const raw = settings.get("cost");
  if (raw === null) return DEFAULT_COST;
  return /^\d+$/.test(raw) ? BigInt(raw) : DEFAULT_COST;
}

function readSeconds(settings: Settings, key: string, fallback: number): number {
  const raw = settings.get(key);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const HireBodySchema = z.object({
  targetUsername: z.string().min(1).max(30),
  detectives: z.number().int().min(1).max(5),
  hours: z.number().int().min(1).max(5),
});

const hireRoute = route({
  method: "POST",
  path: "/api/detectives",
  // Explicit, though it is the SDK default: hiring from jail is allowed —
  // V2 gated only on login (spec §4).
  accessInJail: true,
  body: HireBodySchema,
  handler: async (ctx, { body }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    const cost = readCost(ctx.settings) * BigInt(body.detectives) * BigInt(body.hours);
    const durationSeconds = readSeconds(ctx.settings, "duration", DEFAULT_DURATION_SECONDS);

    const result = await ctx.transaction(async (tx) => {
      // Plain SELECT, no lock: the username -> id mapping is immutable.
      const [target] = await tx.db
        .select({ id: players.id })
        .from(players)
        .where(eq(players.username, body.targetUsername));
      // 400s, not bounties' 404: the spec (§4) pins hire-input problems to 400.
      if (!target) throw new PluginError("target_not_found", 400);
      if (target.id === player.id) throw new PluginError("cannot_search_self", 400);

      // No pair lock, deliberately (spec §2 Locks): this debit locks only the
      // hirer's own player_stats row, and the INSERT's FKs take KEY SHARE on
      // `players` rows, which nothing in the codebase locks FOR UPDATE.
      let cash: bigint;
      try {
        cash = await tx.economy.applyBalanceChange({
          playerId: player.id, amount: -cost, kind: "cash", reason: "detectives.hire",
        });
      } catch (err) {
        if (err instanceof InsufficientFundsError) throw new PluginError("insufficient_funds", 409);
        throw err;
      }

      const id = uuidv7();
      const endsAt = new Date(Date.now() + durationSeconds * body.hours * 1000);
      await tx.db.insert(detectiveSearches).values({
        id, playerId: player.id, targetPlayerId: target.id,
        detectives: body.detectives, endsAt,
      });
      return { id, cash };
    });

    // Enqueue AFTER commit: inside the transaction a fast worker could claim
    // the job, find no row, and burn the idempotency slot before the commit
    // lands. If the enqueue itself fails the money stays gambled — the read
    // path treats NULL past ends_at as failed, so the row can never hang as
    // pending forever (spec §2).
    try {
      await ctx.jobs.enqueue("resolve", {
        searchId: result.id, detectives: body.detectives, hours: body.hours,
      });
    } catch (error) {
      ctx.log.error("failed to enqueue detectives resolve; search resolves as failed at ends_at", {
        err: String(error), searchId: result.id,
      });
    }

    return { status: 201, body: { searchId: result.id, cash: result.cash.toString() } };
  },
});

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
  routes: [hireRoute],
  jobs: { resolve: resolveJob },
});
