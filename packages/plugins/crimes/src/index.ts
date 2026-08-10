import {
  definePlugin, InsufficientFundsError, PluginError, route,
  type PluginCtx, type RankUpResult,
} from "@gl3/plugin-sdk";
import { asc, eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { crimeLog, crimes, playerCrimeSkill, playerStats, players } from "./schema.js";

/**
 * Ported from `apps/server/src/game/crimes/routes.ts` and `worker.ts`. Paths,
 * status codes, error strings and response bodies are unchanged. The
 * idempotency guard moves from `crime_log.job_id` to `plugin_job_runs`
 * (structural in ctx.transaction), and one behaviour changes on a retried
 * already-committed job: it emits zero events where core republished
 * `crime.resolved` (spec §2 — accepted deviation).
 *
 * `@gl3/shared` is off-limits to a plugin package, so `IdSchema` is restated.
 */
const IdSchema = z.string().uuid();
const CommitCrimeParamsSchema = z.object({ crimeId: IdSchema });

/** V2 shipped a default ladder starting at 35% (spec §1.2 US_crimes default). */
const DEFAULT_CRIME_CHANCE = "35.00";

// ---------------------------------------------------------------------------
// GET /api/crimes — port of routes.ts:26-47
// ---------------------------------------------------------------------------

const listRoute = route({
  method: "GET",
  path: "/api/crimes",
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    const cooldownRemaining = await ctx.cooldown.peek("crime", player.id);

    return ctx.transaction(async (tx) => {
      const rows = await tx.db.select().from(crimes).orderBy(asc(crimes.sort));
      const skills = await tx.db.select().from(playerCrimeSkill)
        .where(eq(playerCrimeSkill.playerId, player.id));
      const skillByCrime = new Map(skills.map((s) => [s.crimeId, s.chance]));

      return {
        status: 200,
        body: {
          crimes: rows.map((crime) => ({
            id: crime.id,
            name: crime.name,
            description: crime.description,
            cooldownSeconds: crime.cooldownSeconds,
            minPayout: crime.minPayout.toString(),
            maxPayout: crime.maxPayout.toString(),
            chance: skillByCrime.get(crime.id) ?? DEFAULT_CRIME_CHANCE,
            cooldownRemaining,
          })),
        },
      };
    });
  },
});

// ---------------------------------------------------------------------------
// POST /api/crimes/:crimeId/commit — port of routes.ts:49-93
// ---------------------------------------------------------------------------

const commitRoute = route({
  method: "POST",
  path: "/api/crimes/:crimeId/commit",
  accessInJail: false,
  params: CommitCrimeParamsSchema,
  handler: async (ctx, { params }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    const { crimeId } = params;

    // Look the crime up BEFORE claiming the cooldown so a typo costs nothing.
    const crime = await ctx.transaction(async (tx) => {
      const [row] = await tx.db.select().from(crimes).where(eq(crimes.id, crimeId));
      return row ?? null;
    });
    if (crime === null) throw new PluginError("crime_not_found", 404);

    const won = await ctx.cooldown.acquire("crime", player.id, crime.cooldownSeconds);
    if (!won) {
      const retryAfter = await ctx.cooldown.peek("crime", player.id);
      throw new PluginError(
        "on_cooldown",
        429,
        { retryAfter },
        { "retry-after": String(Math.max(retryAfter, 1)) },
      );
    }

    try {
      const jobId = await ctx.jobs.enqueue("commit", { playerId: player.id, crimeId });
      return { status: 202, body: { jobId, accepted: true } };
    } catch (error) {
      try {
        await ctx.cooldown.release("crime", player.id);
      } catch (releaseError) {
        ctx.log.error("failed to release crime cooldown after enqueue failure", {
          err: String(releaseError), playerId: player.id, crimeId,
        });
      }
      throw error;
    }
  },
});

// ---------------------------------------------------------------------------
// Commit job — port of worker.ts processCrimeJob (spec §4)
// ---------------------------------------------------------------------------

async function commitJob(ctx: PluginCtx, data: Record<string, unknown>): Promise<void> {
  const playerId = String(data["playerId"]);
  const crimeId = String(data["crimeId"]);
  const rng = ctx.job?.rng;
  if (rng === undefined) throw new Error("commit job ran without a seeded rng");

  // Pre-tx reads (spec §4.1) — ctx.player is null inside a job.
  const crime = await ctx.transaction(async (tx) => {
    const [row] = await tx.db.select().from(crimes).where(eq(crimes.id, crimeId));
    return row ?? null;
  });
  if (crime === null) return; // crime deleted between enqueue and resolve

  const actorName = await ctx.transaction(async (tx) => {
    const [row] = await tx.db.select({ username: players.username })
      .from(players).where(eq(players.id, playerId));
    return row?.username ?? null;
  });
  if (actorName === null) return; // player deleted

  const skillChance = await ctx.transaction(async (tx) => {
    const [row] = await tx.db.select({ chance: playerCrimeSkill.chance })
      .from(playerCrimeSkill).where(eq(playerCrimeSkill.playerId, playerId));
    return row?.chance ?? null;
  });
  const chance = Number(skillChance ?? DEFAULT_CRIME_CHANCE);

  // The roll (spec §4.2) — seeded, identical draws to core.
  const roll = rng.int(0, 10_000);
  const success = roll < Math.round(chance * 100);
  const payout = success ? rng.bigint(crime.minPayout, crime.maxPayout) : 0n;
  const bullets = success ? BigInt(rng.int(crime.minBullets, crime.maxBullets + 1)) : 0n;
  const exp = success ? crime.expReward : 0n;
  const jailRoll = !success && crime.jailChancePercent > 0 ? rng.int(0, 100) : 100;
  const jailed = jailRoll < crime.jailChancePercent;

  // The one transaction (spec §4.3). plugin_job_runs insert is already first
  // (structural in ctx.transaction); a retry throws JobAlreadyAppliedError
  // before this closure body runs.
  let promotion: RankUpResult | null = null;
  await ctx.transaction(async (tx) => {
    await tx.db.insert(crimeLog).values({
      id: uuidv7(), playerId, crimeId, success, payout, jobId: ctx.job!.id,
    });
    if (payout > 0n) {
      await tx.economy.applyBalanceChange(
        { playerId, amount: payout, kind: "cash", reason: "crime.payout", refId: crimeId });
    }
    if (exp > 0n) promotion = await tx.economy.applyExpAndRankUp(playerId, exp);
    if (jailed) await tx.jail.sendToJail(playerId, crime.jailSeconds);

    // In-tx read for effectiveJailedUntil (spec §4.4) — same connection sees
    // its own write; the value crime.resolved reports on the fresh path.
    const [fresh] = await tx.db.select({ jailedUntil: playerStats.jailedUntil })
      .from(playerStats).where(eq(playerStats.playerId, playerId));
    const effectiveJailedUntil = fresh?.jailedUntil ?? null;

    // Buffered events, flushed after commit in this order (spec §4.3 step 6).
    // crime.resolved first, then player.jailed, then player.rankedUp.
    await tx.events.publishCore({
      type: "crime.resolved",
      actorId: playerId,
      actorName,
      audience: { kind: "player", playerId },
      crimeId,
      crimeName: crime.name,
      success,
      payout: payout.toString(),
      bullets: bullets.toString(),
      exp: exp.toString(),
      jailedUntil: effectiveJailedUntil ? effectiveJailedUntil.toISOString() : null,
    });
    if (jailed) {
      await tx.events.publishCore({
        type: "player.jailed",
        actorId: playerId,
        actorName,
        audience: { kind: "player", playerId },
        until: effectiveJailedUntil!.toISOString(),
        reason: "crime.failed",
      });
    }
    if (promotion) {
      await tx.events.publishCore({
        type: "player.rankedUp",
        actorId: playerId,
        actorName,
        audience: { kind: "player", playerId },
        rankId: promotion.rankId,
        rankName: promotion.rankName,
        cashReward: promotion.cashReward.toString(),
        bulletReward: promotion.bulletReward.toString(),
        maxHealth: promotion.maxHealth,
      });
    }
  });
  // No post-commit work: leaderboard scores and events are flushed by the ctx.
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export default definePlugin({
  id: "crimes",
  version: "1.0.0",
  basePaths: ["/api/crimes"],
  routes: [listRoute, commitRoute],
  jobs: { commit: commitJob },
  // No menu, pages or events: plugin-manifest-endpoint.test.ts asserts a
  // no-arg boot answers GET /api/plugins with exactly
  // { menu: [], pages: [], events: [] }.
});
