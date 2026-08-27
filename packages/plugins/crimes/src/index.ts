import {
  coreActionCost, coreDashboard, definePlugin, on, PluginError, route,
  type PageSchema, type PluginCtx, type Pool, type RankUpResult,
} from "@gl3/plugin-sdk";
import { benefits as membershipBenefits, isMember } from "@gl3/plugin-membership";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { evaluateSuccessFormula, parseSuccessFormula } from "./formula.js";
import { crimeLog, crimes, playerCrimeSkill, playerStats, players } from "./schema.js";

// The sandboxed formula dialect's public API — apps/migrate imports the same
// parser to validate imported crimePERCFORM expressions (B spec §5): one
// grammar, two consumers, no drift between them.
export {
  parseSuccessFormula, evaluateSuccessFormula,
  FormulaParseError, FormulaEvalError,
  type FormulaContext, type FormulaNode, type FormulaTokenName,
} from "./formula.js";

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

/** V2 crimes.hooks.php: ceil(C_cooldown * 0.75) while the membership timer runs. */
function memberCooldown(base: number, member: boolean): number {
  return member ? Math.ceil(base * 0.75) : base;
}

const POOLS = ["energy", "will", "brave"] as const satisfies readonly Pool[];

/**
 * Positive-amount entries only, in fixed pool order — what's actually worth
 * locking and spending over. `costs` comes back from `core.actionCost` with
 * whatever subscribers chose to add; an empty or all-zero map is what "no
 * attribute plugin installed" (or "installed but this action is unpriced")
 * looks like, and that's the case `priced.length > 0` guards on below.
 */
function pricedEntries(costs: Partial<Record<Pool, number>>): [Pool, number][] {
  return POOLS
    .map((pool) => [pool, costs[pool]] as const)
    .filter((entry): entry is [Pool, number] => typeof entry[1] === "number" && entry[1] > 0);
}

/**
 * Narrows the job data's `costs` field back into `Partial<Record<Pool,
 * number>>`. The route is the only writer of this field (it enqueues exactly
 * what `pricedEntries` returned), but job data crosses a queue as JSON, so
 * this reads it back as `unknown` and validates rather than casting.
 */
function readCosts(value: unknown): Partial<Record<Pool, number>> {
  if (typeof value !== "object" || value === null) return {};
  const record = value as Record<string, unknown>;
  const out: Partial<Record<Pool, number>> = {};
  for (const pool of POOLS) {
    const amount = record[pool];
    if (typeof amount === "number") out[pool] = amount;
  }
  return out;
}

const declareBenefit = on(membershipBenefits, (_ctx, list) => [
  ...list,
  { title: "Getaway Driver", description: "All crime cooldowns are reduced by 25%" },
]);

/**
 * Under per-subscriber binding the ctx handed here is crimes' OWN — so
 * `ctx.cooldown.peek("crime", ...)` reads the exact scope the commit route
 * (`commitRoute` above) arms, not a sibling plugin's namespace.
 */
const dashboardWidget = on(coreDashboard, async (ctx, value) => {
  const player = ctx.player;
  if (player === null) return value;
  const remaining = await ctx.cooldown.peek("crime", player.id);
  return [...value, {
    pluginId: ctx.pluginId,
    title: "Crimes",
    view: {
      kind: "panel" as const, title: "Crimes",
      children: [
        {
          kind: "text" as const,
          value: remaining > 0 ? `Next crime ready in ${remaining}s` : "A crime is ready.",
        },
        { kind: "link" as const, label: "Go to crimes", to: "/plugins/crimes.index" },
      ],
    },
  }];
});

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
      const member = await isMember(tx, player.id);
      // `crimes` is a CORE table, so its art is core-scoped even though this
      // plugin renders it — the same cross-scope read inventory, travel and
      // ranks all make.
      const art = await ctx.assets.resolve("core", rows.map((c) => c.id), "crime");

      return {
        status: 200,
        body: {
          crimes: rows.map((crime) => ({
            id: crime.id,
            name: crime.name,
            description: crime.description,
            cooldownSeconds: memberCooldown(crime.cooldownSeconds, member),
            minPayout: crime.minPayout.toString(),
            maxPayout: crime.maxPayout.toString(),
            // null = a formula crime: the chance is computed per attempt from
            // the player's stats (the success_formula dialect), so no static
            // per-player number exists to list.
            chance: crime.successFormula === null
              ? (skillByCrime.get(crime.id) ?? DEFAULT_CRIME_CHANCE)
              : null,
            cooldownRemaining,
            ...(art.has(crime.id) ? { imageUrl: art.get(crime.id) as string } : {}),
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
    const pre = await ctx.transaction(async (tx) => {
      const [row] = await tx.db.select().from(crimes).where(eq(crimes.id, crimeId));
      return { crime: row ?? null, member: await isMember(tx, player.id) };
    });
    const crime = pre.crime;
    if (crime === null) throw new PluginError("crime_not_found", 404);

    // Order: crime lookup, then what this attempt costs, then the cooldown
    // claim — a player who cannot pay is refused before the cooldown burns
    // (matching the typo/unknown-crime checks above, which already cost
    // nothing), and a player who can pay is charged exactly once,
    // authoritatively, in the job below rather than here.
    const resolvedCost = await ctx.filters.apply(coreActionCost, { action: "crimes.commit", costs: {} });
    // Per-crime brave pricing (audit §7 item 13; C spec §1.1): the amount is
    // content, so it comes from the crime's own brave_cost column rather
    // than a filter subscriber — the actionCost value carries no per-crime
    // context. Priced iff the brave pool is declared by an installed plugin;
    // undeclared or 0 means this crime never costs brave, on every
    // GL3-native game forever.
    if (ctx.attributePools.get("brave") !== null && crime.braveCost > 0) {
      resolvedCost.costs.brave = crime.braveCost;
    }
    const priced = pricedEntries(resolvedCost.costs);

    if (priced.length > 0) {
      // tx.attributes.read SETTLES (lazily regenerates and writes back), so
      // the caller must already hold the row — same contract every other
      // tx.attributes caller follows. The funds check itself runs AFTER this
      // transaction commits, not inside it: the settle is real bookkeeping
      // about the player's pool, independent of whether this particular
      // attempt can afford to run, and rolling it back on a 409 would mean
      // an always-broke player's pool never gets seeded until some other
      // route happens to touch it.
      const attrs = await ctx.transaction(async (tx) => {
        await tx.locks.player([player.id]);
        return tx.attributes.read(player.id);
      });
      for (const [pool, amount] of priced) {
        if (attrs[pool] < amount) throw new PluginError(`insufficient_${pool}`, 409);
      }
    }

    const won = await ctx.cooldown.acquire("crime", player.id, memberCooldown(crime.cooldownSeconds, pre.member));
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
      // The job cannot re-resolve this itself: a job's `ctx.filters` only
      // ever sees its OWN plugin's subscriptions (apps/server/src/plugins/
      // jobs.ts builds it from the single job-owning manifest), never a
      // sibling attribute plugin's — so the figure resolved above travels
      // through as job data, the same way playerId/crimeId already do.
      const jobId = await ctx.jobs.enqueue("commit", {
        playerId: player.id, crimeId, costs: Object.fromEntries(priced),
      });
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
  const priced = pricedEntries(readCosts(data["costs"]));
  const rng = ctx.job?.rng;
  if (rng === undefined) throw new Error("commit job ran without a seeded rng");

  // All reads and writes in one transaction (spec §4.3). plugin_job_runs
  // insert is structural (first in ctx.transaction); a retry throws
  // JobAlreadyAppliedError before any handler code runs. Pre-tx reads
  // (spec §4.1) live inside this same transaction — ctx only exposes
  // `transaction` for DB access, and each call would re-claim the job.
  await ctx.transaction(async (tx) => {
    let promotion: RankUpResult | null = null;

    // Pre-tx reads (spec §4.1) — ctx.player is null inside a job.
    const [crime] = await tx.db.select().from(crimes).where(eq(crimes.id, crimeId));
    if (!crime) return; // crime deleted between enqueue and resolve

    const [actor] = await tx.db.select({ username: players.username })
      .from(players).where(eq(players.id, playerId));
    if (!actor) return; // player deleted
    const actorName = actor.username;

    // Per-crime chance — two mutually exclusive models per crime (audit §7
    // item 5; B0, spec 2026-08-26-mccodes-migrator-design §2.2).
    //
    // success_formula present: the sandboxed five-token dialect, evaluated
    // against THIS player's stats. player_crime_skill is V2's shape and has
    // no MCCodes meaning — a formula crime never reads or writes it. An
    // eval-time fault (division by zero against a live player's stats, which
    // parse-time validation cannot foresee) resolves as 0%: the attempt
    // fails, the job never crashes, and the fault is logged for the admin.
    //
    // NULL: V2's per-player skill chance, byte-identical to the pre-B0 path
    // — player_crime_skill is one row per (player, crime); core queried by
    // playerId only and took [0], grabbing an arbitrary row's chance. This
    // port scopes it to the committed crimeId (documented deviation;
    // security-review-confirmed) and falls back to the default when the
    // player has no row for this crime yet.
    let chance: number;
    if (crime.successFormula !== null) {
      const [stats] = await tx.db.select({
        level: playerStats.level, crimeExp: playerStats.crimeExp,
        exp: playerStats.exp, will: playerStats.will, iq: playerStats.iq,
      })
        .from(playerStats).where(eq(playerStats.playerId, playerId));
      if (!stats) return; // player deleted between enqueue and resolve
      try {
        chance = evaluateSuccessFormula(parseSuccessFormula(crime.successFormula), {
          LEVEL: stats.level,
          CRIMEXP: Number(stats.crimeExp), // exact below 2^53 (formula.ts header)
          EXP: Number(stats.exp),
          WILL: stats.will,
          IQ: Number(stats.iq),
        });
      } catch (error) {
        ctx.log.warn("crime success formula failed to evaluate; resolving as 0%", {
          err: String(error), playerId, crimeId,
        });
        chance = 0;
      }
    } else {
      const [skillRow] = await tx.db.select({ chance: playerCrimeSkill.chance })
        .from(playerCrimeSkill)
        .where(and(eq(playerCrimeSkill.playerId, playerId), eq(playerCrimeSkill.crimeId, crimeId)));
      chance = Number(skillRow?.chance ?? DEFAULT_CRIME_CHANCE);
    }

    // The roll (spec §4.2) — seeded, identical draws to core.
    const roll = rng.int(0, 10_000);
    const success = roll < Math.round(chance * 100);
    const payout = success ? rng.bigint(crime.minPayout, crime.maxPayout) : 0n;
    const bullets = success ? BigInt(rng.int(crime.minBullets, crime.maxBullets + 1)) : 0n;
    const exp = success ? crime.expReward : 0n;
    const jailRoll = !success && crime.jailChancePercent > 0 ? rng.int(0, 100) : 100;
    const jailed = jailRoll < crime.jailChancePercent;

    // Authoritative spend (core.actionCost) — inside the same transaction as
    // the idempotency claim above, so a BullMQ redelivery never double-charges
    // (rule 1). The route already pre-checked funds; this is what actually
    // moves them, regardless of success/failure below (spending energy on an
    // attempt, not a result, matches the pool's meaning). Skipped entirely
    // when nothing is priced — that single guard is what keeps an install
    // with no attribute plugin from taking a lock or touching a regen clock
    // this job never used to touch.
    //
    // The handoff gap (STATUS.md, closed by C1): the route's pre-check is
    // advisory, and a concurrent action can drain the pool between the 202
    // and this spend. A shortfall resolves as a FAILED attempt — event
    // published, nothing spent, no roll, no jail, no skill — inside this
    // same transaction, so the idempotency claim COMMITS, BullMQ acks once,
    // and a client polling for an outcome always gets one instead of
    // watching retries exhaust into silence. The funds check runs under the
    // lock already held, against the settled read, and precedes every spend
    // so the batch is all-or-nothing: no pool pays for an attempt another
    // pool cannot cover.
    if (priced.length > 0) {
      await tx.locks.player([playerId]);
      const attrs = await tx.attributes.read(playerId);
      const shortfall = priced.find(([pool, amount]) => attrs[pool] < amount);
      if (shortfall !== undefined) {
        await tx.db.insert(crimeLog).values({
          id: uuidv7(), playerId, crimeId, success: false, payout: 0n, jobId: ctx.job!.id,
        });
        await tx.events.publishCore({
          type: "crime.resolved",
          actorId: playerId,
          actorName,
          audience: { kind: "player", playerId },
          crimeId,
          crimeName: crime.name,
          success: false,
          cause: "insufficient_pool",
          payout: "0",
          bullets: "0",
          exp: "0",
          jailedUntil: null,
        });
        return;
      }
      for (const [pool, amount] of priced) {
        await tx.attributes.spend(playerId, pool, amount);
      }
    }

    await tx.db.insert(crimeLog).values({
      id: uuidv7(), playerId, crimeId, success, payout, jobId: ctx.job!.id,
    });
    if (payout > 0n) {
      await tx.economy.applyBalanceChange(
        { playerId, amount: payout, kind: "cash", reason: "crime.payout", refId: crimeId });
    }
    if (exp > 0n) promotion = await tx.economy.applyExpAndRankUp(playerId, exp);
    // crime_exp_reward (audit §7 item 4, migration 0019): the counter's main
    // producer — MCCodes' per-crime crimeXP. Default 0 writes nothing, so
    // GL3-native crimes are byte-identical.
    if (success && crime.crimeExpReward > 0n) {
      await tx.db.update(playerStats)
        .set({ crimeExp: sql`${playerStats.crimeExp} + ${crime.crimeExpReward}` })
        .where(eq(playerStats.playerId, playerId));
    }
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
// Admin routes
// ---------------------------------------------------------------------------

const AdminMoney = z.string().regex(/^\d+$/, "nonnegative integer string");
/** Optional: absent leaves the column alone (update) or writes the default
 *  (create, where "0"/NULL are the byte-identical values); a present string
 *  must survive the sandboxed-dialect parser — invalid formulas 400 here,
 *  at authoring time, rather than silently at resolve time (audit §7 item 5:
 *  validate-every-input applies to game content too). */
const AdminFormula = z.string().max(500).nullable();
const CrimeUpdateSchema = z.object({
  id: z.string().uuid(),
  cooldownSeconds: z.coerce.number().int().nonnegative(),
  minPayout: AdminMoney,
  maxPayout: AdminMoney,
  expReward: AdminMoney,
  crimeExpReward: AdminMoney.optional(),
  successFormula: AdminFormula.optional(),
  jailChancePercent: z.coerce.number().int().nonnegative(),
  jailSeconds: z.coerce.number().int().nonnegative(),
}).strict().refine((b) => BigInt(b.maxPayout) >= BigInt(b.minPayout), {
  message: "maxPayout must be >= minPayout",
});

/**
 * Create carries four columns update does not: `name` and `description` are
 * NOT NULL with no sensible edit path once set, and `minBullets`/`maxBullets`
 * gate the crime's cost. `sort` is deliberately absent — the handler derives
 * it, since asking an admin for a manual ordering integer is how two crimes
 * end up sharing one.
 */
const CrimeCreateSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500),
  cooldownSeconds: z.coerce.number().int().nonnegative(),
  minPayout: AdminMoney,
  maxPayout: AdminMoney,
  minBullets: z.coerce.number().int().nonnegative(),
  maxBullets: z.coerce.number().int().nonnegative(),
  expReward: AdminMoney,
  crimeExpReward: AdminMoney.optional(),
  successFormula: AdminFormula.optional(),
  jailChancePercent: z.coerce.number().int().nonnegative().max(100),
  jailSeconds: z.coerce.number().int().nonnegative(),
}).strict()
  .refine((b) => BigInt(b.maxPayout) >= BigInt(b.minPayout), {
    message: "maxPayout must be >= minPayout",
  })
  .refine((b) => b.maxBullets >= b.minBullets, {
    message: "maxBullets must be >= minBullets",
  });

/** Parse-or-400 the formula (the AdminFormula doc comment's contract). Trim:
 *  the stored expression is what the resolve job will parse per attempt, and
 *  what an MCCodes import would have imported verbatim. */
function validatedFormula(formula: string | null | undefined): string | null | undefined {
  if (formula === undefined || formula === null) return formula;
  const trimmed = formula.trim();
  if (trimmed === "") return null;
  try {
    parseSuccessFormula(trimmed);
    return trimmed;
  } catch (error) {
    throw new PluginError("invalid_formula", 400, {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

const adminCrimesListRoute = route({
  method: "GET", path: "/api/admin/crimes/list", auth: "admin",
  handler: async (ctx) => {
    const rows = await ctx.transaction(async (tx) =>
      tx.db.select().from(crimes).orderBy(asc(crimes.sort)),
    );
    return {
      status: 200,
      body: {
        rows: rows.map((c) => ({
          id: c.id, name: c.name,
          cooldownSeconds: String(c.cooldownSeconds),
          minPayout: c.minPayout.toString(),
          maxPayout: c.maxPayout.toString(),
          expReward: c.expReward.toString(),
          crimeExpReward: c.crimeExpReward.toString(),
          // "" not null: the table renderer parses rows with
          // z.record(z.string()), and one null cell kills the whole table.
          // The update route already reads "" back as NULL (blank = skill
          // chance), so the round-trip is lossless.
          successFormula: c.successFormula ?? "",
          jailChancePercent: String(c.jailChancePercent),
          jailSeconds: String(c.jailSeconds),
        })),
      },
    };
  },
});

const adminCrimesCreateRoute = route({
  method: "POST", path: "/api/admin/crimes", auth: "admin",
  body: CrimeCreateSchema,
  handler: async (ctx, { body }) => {
    const formula = validatedFormula(body.successFormula);
    const id = uuidv7();
    await ctx.transaction(async (tx) => {
      // Read the current max inside the same transaction as the insert: two
      // concurrent creates that both read the old max would otherwise both
      // claim the same `sort`, and the player list orders by it.
      const [top] = await tx.db.select({ sort: crimes.sort })
        .from(crimes).orderBy(desc(crimes.sort)).limit(1);
      await tx.db.insert(crimes).values({
        id, name: body.name, description: body.description,
        cooldownSeconds: body.cooldownSeconds,
        minPayout: BigInt(body.minPayout),
        maxPayout: BigInt(body.maxPayout),
        minBullets: body.minBullets,
        maxBullets: body.maxBullets,
        expReward: BigInt(body.expReward),
        crimeExpReward: BigInt(body.crimeExpReward ?? "0"),
        successFormula: formula ?? null,
        jailChancePercent: body.jailChancePercent,
        jailSeconds: body.jailSeconds,
        sort: (top?.sort ?? 0) + 1,
      });
    });
    return { status: 201, body: { id } };
  },
});

const adminCrimesUpdateRoute = route({
  method: "POST", path: "/api/admin/crimes/update", auth: "admin",
  body: CrimeUpdateSchema,
  handler: async (ctx, { body }) => {
    const formula = validatedFormula(body.successFormula);
    const updated = await ctx.transaction(async (tx) => {
      // Absent keys stay untouched (drizzle omits undefined from SET) — an
      // update that omits successFormula leaves the formula alone; sending
      // null clears it back to the skill-chance path.
      const result = await tx.db.update(crimes)
        .set({
          cooldownSeconds: body.cooldownSeconds,
          minPayout: BigInt(body.minPayout),
          maxPayout: BigInt(body.maxPayout),
          expReward: BigInt(body.expReward),
          ...(body.crimeExpReward !== undefined ? { crimeExpReward: BigInt(body.crimeExpReward) } : {}),
          ...(formula !== undefined ? { successFormula: formula } : {}),
          jailChancePercent: body.jailChancePercent,
          jailSeconds: body.jailSeconds,
        })
        .where(eq(crimes.id, body.id))
        .returning({ id: crimes.id });
      return result.length > 0;
    });
    if (!updated) throw new PluginError("crime_not_found", 404);
    return { status: 204 };
  },
});

const adminCrimesDeleteRoute = route({
  method: "DELETE", path: "/api/admin/crimes/:id", auth: "admin",
  params: z.object({ id: z.string().uuid() }),
  handler: async (ctx, { params }) => {
    const deleted = await ctx.transaction(async (tx) => {
      // `crime_log.crime_id` and `player_crime_skill.crime_id` both cascade —
      // a crime's attempt history and per-player skill are ABOUT the crime
      // and go with it, unlike an item in someone's inventory. A worker still
      // holding a queued attempt at it fails its insert on the missing FK,
      // which is the at-least-once path failing closed (rule 1).
      const result = await tx.db.delete(crimes)
        .where(eq(crimes.id, params.id)).returning({ id: crimes.id });
      return result.length > 0;
    });
    if (!deleted) throw new PluginError("crime_not_found", 404);
    return { status: 204 };
  },
});

const adminCrimesPage: PageSchema = {
  id: "crimes-admin",
  path: "/admin/crimes",
  view: {
    kind: "panel", title: "Crimes",
    children: [
      { kind: "table", source: "GET /api/admin/crimes/list", columns: [
        { key: "name", label: "Name" },
        { key: "cooldownSeconds", label: "Cooldown (s)" },
        { key: "minPayout", label: "Min payout" },
        { key: "maxPayout", label: "Max payout" },
        { key: "expReward", label: "Exp" },
        { key: "jailChancePercent", label: "Jail %" },
        { key: "jailSeconds", label: "Jail (s)" },
      ], rowActions: [
        { label: "Delete", action: "DELETE /api/admin/crimes/:id", confirm: "Delete this crime? Its attempt history and player skill go with it." },
      ] },
      { kind: "form", action: "POST /api/admin/crimes", submitLabel: "Add crime", fields: [
        { name: "name", label: "Name", type: "text" },
        { name: "description", label: "Description", type: "text" },
        { name: "cooldownSeconds", label: "Cooldown seconds", type: "number" },
        { name: "minPayout", label: "Min payout", type: "money" },
        { name: "maxPayout", label: "Max payout", type: "money" },
        { name: "minBullets", label: "Min bullets", type: "number" },
        { name: "maxBullets", label: "Max bullets", type: "number" },
        { name: "expReward", label: "Exp reward", type: "money" },
        { name: "crimeExpReward", label: "Crime exp reward", type: "money" },
        { name: "successFormula", label: "Success formula (LEVEL/CRIMEXP/EXP/WILL/IQ; blank = skill chance)", type: "text" },
        { name: "jailChancePercent", label: "Jail chance %", type: "number" },
        { name: "jailSeconds", label: "Jail seconds", type: "number" },
      ] },
      { kind: "form", action: "POST /api/admin/crimes/update", submitLabel: "Update crime", fields: [
        { name: "id", label: "Crime", type: "select", optionsSource: "GET /api/admin/crimes/list", valueKey: "id", labelKey: "name" },
        { name: "cooldownSeconds", label: "Cooldown seconds", type: "number" },
        { name: "minPayout", label: "Min payout", type: "money" },
        { name: "maxPayout", label: "Max payout", type: "money" },
        { name: "expReward", label: "Exp reward", type: "money" },
        { name: "crimeExpReward", label: "Crime exp reward", type: "money" },
        { name: "successFormula", label: "Success formula (empty = back to skill chance)", type: "text" },
        { name: "jailChancePercent", label: "Jail chance %", type: "number" },
        { name: "jailSeconds", label: "Jail seconds", type: "number" },
      ] },
    ],
  },
};

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export default definePlugin({
  id: "crimes",
  version: "1.0.0",
  basePaths: ["/api/crimes", "/api/admin/crimes"],
  // Real import dependencies (see this package's package.json) —
  // enforced against the final boot set by plugins/validate.ts.
  requires: ["membership"],
  pages: [{
    id: "crimes.index",
    path: "/crimes",
    menu: { label: "Crimes", order: 10, category: "crimes" },
    // Stub view: the client renders a hand-written override (apps/web
    // PAGE_OVERRIDES) for this id; the schema view exists because a
    // page declaration requires one.
    view: { kind: "list", items: [] },
  }],
  routes: [listRoute, commitRoute, adminCrimesListRoute, adminCrimesCreateRoute, adminCrimesUpdateRoute, adminCrimesDeleteRoute],
  adminPages: [adminCrimesPage],
  jobs: { commit: commitJob },
  filters: [declareBenefit, dashboardWidget],
  // No menu, pages or events: plugin-manifest-endpoint.test.ts asserts a
  // no-arg boot answers GET /api/plugins with exactly
  // { menu: [], pages: [], events: [] }.
});
