import { and, asc, desc, eq, gt, lte } from "drizzle-orm";
import { bigint, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { JOBS_MIGRATIONS } from "./migrations.js";
import { adminPage, jobsPage } from "./pages.js";
import { coreHud, definePlugin, on, PluginError, route, type PluginTx } from "@gl3/plugin-sdk";
// Re-exported so `apps/server/test/jobs-page.test.ts` can assert against the
// same page object rather than a hand-copied duplicate of its view tree —
// the education/houses precedent.
export { adminPage, jobsPage } from "./pages.js";

const jobs = pgTable("p_jobs_jobs", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  firstRankId: uuid("first_rank_id").notNull(),
});

const ranks = pgTable("p_jobs_ranks", {
  id: uuid("id").primaryKey(),
  jobId: uuid("job_id").notNull(),
  name: text("name").notNull(),
  pay: bigint("pay", { mode: "bigint" }).notNull(),
  strengthGain: integer("strength_gain").notNull(),
  labourGain: integer("labour_gain").notNull(),
  iqGain: integer("iq_gain").notNull(),
  strengthReq: integer("strength_req").notNull(),
  labourReq: integer("labour_req").notNull(),
  iqReq: integer("iq_req").notNull(),
});

const employment = pgTable("p_jobs_players", {
  playerId: uuid("player_id").primaryKey(),
  rankId: uuid("rank_id").notNull(),
  lastWageAt: timestamp("last_wage_at", { withTimezone: true }).notNull(),
});

const DAY_MS = 86_400_000;

async function employmentWithRank(tx: PluginTx, playerId: string) {
  const [row] = await tx.db.select({
    rankId: employment.rankId, lastWageAt: employment.lastWageAt,
    jobId: ranks.jobId, rankName: ranks.name, pay: ranks.pay,
    strengthGain: ranks.strengthGain, labourGain: ranks.labourGain, iqGain: ranks.iqGain,
  })
    .from(employment)
    .innerJoin(ranks, eq(ranks.id, employment.rankId))
    .where(eq(employment.playerId, playerId));
  return row ?? null;
}

/**
 * Lazy wages (C spec §4.5): WHOLE elapsed days only, stamp advancing to the
 * cleared deadline so the remainder survives — the settlePool discipline.
 * Per day: `jrPAY` money (ledgered), `jrPAY/20` exp THROUGH THE ECONOMY
 * SEAM (exp routing diverts it to the level ladder automatically on a
 * progression boot — jobs never knows), and the rank's stat gains.
 */
async function settleWages(tx: PluginTx, player: { id: string; username: string }): Promise<number> {
  const playerId = player.id;
  const row = await employmentWithRank(tx, playerId);
  if (row === null) return 0;

  const days = Math.floor((Date.now() - row.lastWageAt.getTime()) / DAY_MS);
  if (days <= 0) return 0;

  const total = row.pay * BigInt(days);
  if (total > 0n) {
    await tx.economy.applyBalanceChange(
      { playerId, amount: total, kind: "cash", reason: "jobs.wage", refId: row.rankId },
    );
    await tx.economy.applyExpAndRankUp(playerId, total / 20n);
    // A lazy payout the player never asked for is invisible without a record
    // — the cash just IS higher. The notification is that record (the
    // properties-seizure precedent: one audience, tx.notify, not an event).
    await tx.notify(
      playerId,
      `Payday: ${days} ${days === 1 ? "day" : "days"}' wages at ${row.rankName} — $${total}.`,
    );
  }
  if (row.strengthGain > 0) await tx.attributes.train(playerId, "strength", BigInt(row.strengthGain * days));
  if (row.labourGain > 0) await tx.attributes.train(playerId, "labour", BigInt(row.labourGain * days));
  if (row.iqGain > 0) await tx.attributes.train(playerId, "iq", BigInt(row.iqGain * days));

  await tx.db.update(employment)
    .set({ lastWageAt: new Date(row.lastWageAt.getTime() + days * DAY_MS) })
    .where(eq(employment.playerId, playerId));
  // The settle runs inside a READ (`/api/jobs/board` is what the plugin page
  // fetches), so no action fires on the client and nothing there invalidates
  // the HUD's "Wages: N day(s) unclaimed" line or the cash stat — they sat
  // stale until a full reload. This silent event is the invalidation carrier;
  // the notification above stays the visible record. Outside the pay guard:
  // a zero-pay rank still moves the stamp `hudWage` reads.
  await tx.events.publish({
    name: "wages",
    actorId: playerId, actorName: player.username,
    audience: { kind: "player", playerId },
    payload: { days, total: total.toString(), rankName: row.rankName },
  });
  return days;
}

const mineRoute = route({
  method: "GET",
  path: "/api/jobs/mine",
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      await tx.locks.player([player.id]);
      const daysSettled = await settleWages(tx, player);
      const row = await employmentWithRank(tx, player.id);
      if (row === null) return { status: 200, body: { job: null, daysSettled } };
      const [job] = await tx.db.select().from(jobs).where(eq(jobs.id, row.jobId));
      return {
        status: 200,
        body: {
          job: {
            jobId: row.jobId, jobName: job?.name ?? "", description: job?.description ?? "",
            rankId: row.rankId, rankName: row.rankName, pay: row.pay.toString(),
            lastWageAt: row.lastWageAt.toISOString(),
          },
          daysSettled,
        },
      };
    });
  },
});

const listRoute = route({
  method: "GET",
  path: "/api/jobs",
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    const attrs = await ctx.transaction(async (tx) => {
      await tx.locks.player([player.id]);
      return tx.attributes.read(player.id);
    });
    const rows = await ctx.transaction(async (tx) =>
      tx.db.select().from(ranks).orderBy(asc(ranks.pay)));
    const firstRankIds = new Set((await ctx.transaction(async (tx) => tx.db.select().from(jobs))).map((j) => j.firstRankId));
    // Show each job's entry rank with its requirements — the interview gate.
    return {
      status: 200,
      body: {
        jobs: rows
          .filter((r) => firstRankIds.has(r.id))
          .map((r) => ({
            rankId: r.id, name: r.name, pay: r.pay.toString(),
            strengthReq: r.strengthReq, labourReq: r.labourReq, iqReq: r.iqReq,
            qualifies: attrs.strength >= BigInt(r.strengthReq)
              && attrs.labour >= BigInt(r.labourReq)
              && attrs.iq >= BigInt(r.iqReq),
          })),
      },
    };
  },
});

/**
 * The catalog of ranks (job-grouped) plus the caller's current employment,
 * composed from the same `settleWages`/`employmentWithRank` `mineRoute`
 * uses — the education/houses board shape, reused rather than duplicated so
 * a board read settles wages exactly like `/api/jobs/mine` does.
 */
const boardRoute = route({
  method: "GET",
  path: "/api/jobs/board",
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      await tx.locks.player([player.id]);
      await settleWages(tx, player);
      const employed = await employmentWithRank(tx, player.id);

      const rankRows = await tx.db.select({
        id: ranks.id, jobId: ranks.jobId, jobName: jobs.name, rankName: ranks.name, pay: ranks.pay,
        strengthReq: ranks.strengthReq, labourReq: ranks.labourReq, iqReq: ranks.iqReq,
      })
        .from(ranks)
        .innerJoin(jobs, eq(jobs.id, ranks.jobId))
        .orderBy(asc(jobs.name), asc(ranks.pay));

      const values: Record<string, string> = {};
      if (employed !== null) {
        const [job] = await tx.db.select().from(jobs).where(eq(jobs.id, employed.jobId));
        values.jobName = job?.name ?? "";
        values.rankName = employed.rankName;
        values.pay = employed.pay.toString();
      }

      return {
        status: 200,
        body: {
          rows: rankRows.map((r) => ({
            id: r.id, jobId: r.jobId, jobName: r.jobName, rankName: r.rankName, pay: r.pay.toString(),
            strengthReq: String(r.strengthReq), labourReq: String(r.labourReq), iqReq: String(r.iqReq),
          })),
          values,
        },
      };
    });
  },
});

/**
 * Jobs, one row per job (not per rank) — the interview form's `jobId`
 * select needs options keyed by job, unlike `boardRoute`'s rank-keyed rows.
 */
const jobsListRoute = route({
  method: "GET",
  path: "/api/jobs/list",
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    const rows = await ctx.transaction(async (tx) =>
      tx.db.select({ id: jobs.id, name: jobs.name }).from(jobs).orderBy(asc(jobs.name)));
    return { status: 200, body: { rows } };
  },
});

const InterviewSchema = z.object({ jobId: z.string().uuid() }).strict();

const interviewRoute = route({
  method: "POST",
  path: "/api/jobs/interview",
  body: InterviewSchema,
  handler: async (ctx, { body }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      await tx.locks.player([player.id]);

      const [existing] = await tx.db.select().from(employment).where(eq(employment.playerId, player.id));
      if (existing) throw new PluginError("already_employed", 409);

      const [job] = await tx.db.select().from(jobs).where(eq(jobs.id, body.jobId));
      if (!job) throw new PluginError("job_not_found", 404);
      const [first] = await tx.db.select().from(ranks).where(eq(ranks.id, job.firstRankId));
      if (!first) throw new PluginError("job_not_found", 404);

      // The interview IS the first rank's stat requirements (job.php:41-46).
      const attrs = await tx.attributes.read(player.id);
      if (attrs.strength < BigInt(first.strengthReq)
        || attrs.labour < BigInt(first.labourReq)
        || attrs.iq < BigInt(first.iqReq)) {
        throw new PluginError("requirements_not_met", 409);
      }

      await tx.db.insert(employment)
        .values({ playerId: player.id, rankId: first.id, lastWageAt: new Date() });
      return { status: 200, body: { jobId: job.id, rankId: first.id, rankName: first.name } };
    });
  },
});

const promoteRoute = route({
  method: "POST",
  path: "/api/jobs/promote",
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      await tx.locks.player([player.id]);
      await settleWages(tx, player);

      const row = await employmentWithRank(tx, player.id);
      if (row === null) throw new PluginError("not_employed", 409);

      // Highest-paying rank in the same job whose requirements are met
      // (job.php:196-205) — promotion is player-initiated, any time.
      const attrs = await tx.attributes.read(player.id);
      const [next] = await tx.db.select().from(ranks)
        .where(and(
          eq(ranks.jobId, row.jobId),
          gt(ranks.pay, row.pay),
          lte(ranks.strengthReq, Number(attrs.strength)),
          lte(ranks.labourReq, Number(attrs.labour)),
          lte(ranks.iqReq, Number(attrs.iq)),
        ))
        .orderBy(desc(ranks.pay))
        .limit(1);
      if (!next) throw new PluginError("no_promotion", 409);

      await tx.db.update(employment)
        .set({ rankId: next.id })
        .where(eq(employment.playerId, player.id));
      return { status: 200, body: { rankId: next.id, rankName: next.name, pay: next.pay.toString() } };
    });
  },
});

const quitRoute = route({
  method: "POST",
  path: "/api/jobs/quit",
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      await tx.locks.player([player.id]);
      await settleWages(tx, player); // a fair exit: owed days pay out
      const deleted = await tx.db.delete(employment)
        .where(eq(employment.playerId, player.id))
        .returning({ playerId: employment.playerId });
      if (deleted.length === 0) throw new PluginError("not_employed", 409);
      return { status: 200, body: { quit: true } };
    });
  },
});

// ---------------------------------------------------------------------------
// core.hud (education's `hudCourse` shape). Unlike `settleWages`, this is a
// PLAIN read — no lock, no write, no stat/cash grant — since the brief is
// explicit the HUD path must not settle. An unclaimed day still settles
// correctly the next time the player visits `/api/jobs/mine` or
// `/api/jobs/board`; the HUD is display only.
// ---------------------------------------------------------------------------

const hudWage = on(coreHud, async (ctx, value) => {
  const player = ctx.player;
  if (player === null) return value;

  const claimableDays = await ctx.transaction(async (tx) => {
    const [row] = await tx.db.select({ lastWageAt: employment.lastWageAt })
      .from(employment)
      .where(eq(employment.playerId, player.id));
    if (!row) return 0;
    return Math.floor((Date.now() - row.lastWageAt.getTime()) / DAY_MS);
  });
  if (claimableDays < 1) return value;

  return [...value, {
    pluginId: ctx.pluginId, label: "Wages", value: `${claimableDays} day(s) unclaimed`,
  }];
});

// ---------------------------------------------------------------------------
// Admin routes — the two-catalog editor (theft's cars+tiers shape). No FK
// references either `p_jobs_jobs` or `p_jobs_ranks` (rule 6 discipline — these
// tables carry no foreign keys at all, per `migrations.ts`), so both deletes
// are unconditional, the houses/education shape. `job_id`/`first_rank_id`
// cross-reference each other with no FK to enforce it, which is what makes
// the bootstrap order possible: a fresh job is created first with a
// placeholder `firstRankId` (any uuid — nothing validates it exists yet),
// its ranks are added afterward through the "Add rank" form (whose `jobId`
// select already lists the new job), and the job's `firstRankId` is then
// repointed at the real entry rank via the update form — the same order
// `apps/server/src/db/seed.ts`'s jobs seed uses with hand-chosen uuids,
// minus the ability to choose the uuid up front.
// ---------------------------------------------------------------------------

const AdminMoney = z.string().regex(/^\d+$/, "nonnegative integer string");

/** The blank-normalises-to-undefined convention (houses/education/theft/membership). */
function blankable<T extends z.ZodTypeAny>(inner: T): z.ZodEffects<z.ZodOptional<T>> {
  return z.preprocess((v) => (v === "" ? undefined : v), inner.optional()) as never;
}

const JobCreateSchema = z
  .object({
    name: z.string().min(1).max(80),
    description: z.string().min(1),
    firstRankId: z.string().uuid(),
  })
  .strict();

const JobUpdateSchema = z
  .object({
    id: z.string().uuid(),
    name: blankable(z.string().min(1).max(80)),
    description: blankable(z.string().min(1)),
    firstRankId: z.string().uuid(),
  })
  .strict();

const RankCreateSchema = z
  .object({
    jobId: z.string().uuid(),
    name: z.string().min(1).max(80),
    pay: AdminMoney,
    strengthGain: z.coerce.number().int().nonnegative(),
    labourGain: z.coerce.number().int().nonnegative(),
    iqGain: z.coerce.number().int().nonnegative(),
    strengthReq: z.coerce.number().int().nonnegative(),
    labourReq: z.coerce.number().int().nonnegative(),
    iqReq: z.coerce.number().int().nonnegative(),
  })
  .strict();

const RankUpdateSchema = z
  .object({
    id: z.string().uuid(),
    jobId: z.string().uuid(),
    name: blankable(z.string().min(1).max(80)),
    pay: AdminMoney,
    strengthGain: z.coerce.number().int().nonnegative(),
    labourGain: z.coerce.number().int().nonnegative(),
    iqGain: z.coerce.number().int().nonnegative(),
    strengthReq: z.coerce.number().int().nonnegative(),
    labourReq: z.coerce.number().int().nonnegative(),
    iqReq: z.coerce.number().int().nonnegative(),
  })
  .strict();

function jobRow(j: typeof jobs.$inferSelect) {
  return { id: j.id, name: j.name, description: j.description, firstRankId: j.firstRankId };
}

/** The catalog as a `TableRowsResponse`. `id` is the update/select `valueKey` and is never rendered as a column. */
const adminJobsListRoute = route({
  method: "GET",
  path: "/api/admin/jobs/list",
  auth: "admin",
  handler: async (ctx) => {
    const rows = await ctx.transaction(async (tx) => tx.db.select().from(jobs).orderBy(asc(jobs.name)));
    return { status: 200, body: { rows: rows.map(jobRow) } };
  },
});

const adminJobCreateRoute = route({
  method: "POST",
  path: "/api/admin/jobs",
  auth: "admin",
  body: JobCreateSchema,
  handler: async (ctx, { body }) => {
    const id = uuidv7();
    await ctx.transaction(async (tx) => {
      await tx.db.insert(jobs).values({
        id, name: body.name, description: body.description, firstRankId: body.firstRankId,
      });
    });
    return { status: 201, body: { id } };
  },
});

const adminJobUpdateRoute = route({
  method: "POST",
  path: "/api/admin/jobs/update",
  auth: "admin",
  body: JobUpdateSchema,
  handler: async (ctx, { body }) => {
    const updated = await ctx.transaction(async (tx) => {
      const result = await tx.db
        .update(jobs)
        .set({
          firstRankId: body.firstRankId,
          ...(body.name !== undefined && { name: body.name }),
          ...(body.description !== undefined && { description: body.description }),
        })
        .where(eq(jobs.id, body.id))
        .returning({ id: jobs.id });
      return result.length > 0;
    });
    if (!updated) throw new PluginError("job_not_found", 404);
    return { status: 204 };
  },
});

const adminJobDeleteRoute = route({
  method: "DELETE",
  path: "/api/admin/jobs/:id",
  auth: "admin",
  params: z.object({ id: z.string().uuid() }),
  handler: async (ctx, { params }) => {
    const deleted = await ctx.transaction(async (tx) => {
      const result = await tx.db.delete(jobs).where(eq(jobs.id, params.id)).returning({ id: jobs.id });
      return result.length > 0;
    });
    if (!deleted) throw new PluginError("job_not_found", 404);
    return { status: 204 };
  },
});

/** Job-joined so the rank select (job's `firstRankId`, and the rank's own update select) can label itself `"Job · Rank"`. */
const adminRanksListRoute = route({
  method: "GET",
  path: "/api/admin/jobs/ranks/list",
  auth: "admin",
  handler: async (ctx) => {
    const rows = await ctx.transaction(async (tx) =>
      tx.db.select({
        id: ranks.id, jobId: ranks.jobId, jobName: jobs.name, name: ranks.name, pay: ranks.pay,
        strengthGain: ranks.strengthGain, labourGain: ranks.labourGain, iqGain: ranks.iqGain,
        strengthReq: ranks.strengthReq, labourReq: ranks.labourReq, iqReq: ranks.iqReq,
      })
        .from(ranks)
        .leftJoin(jobs, eq(jobs.id, ranks.jobId))
        .orderBy(asc(ranks.name)));
    return {
      status: 200,
      body: {
        rows: rows.map((r) => ({
          id: r.id, jobId: r.jobId, jobName: r.jobName ?? "", rankLabel: `${r.jobName ?? "?"} · ${r.name}`,
          name: r.name, pay: r.pay.toString(),
          strengthGain: String(r.strengthGain), labourGain: String(r.labourGain), iqGain: String(r.iqGain),
          strengthReq: String(r.strengthReq), labourReq: String(r.labourReq), iqReq: String(r.iqReq),
        })),
      },
    };
  },
});

const adminRankCreateRoute = route({
  method: "POST",
  path: "/api/admin/jobs/ranks",
  auth: "admin",
  body: RankCreateSchema,
  handler: async (ctx, { body }) => {
    const id = uuidv7();
    await ctx.transaction(async (tx) => {
      await tx.db.insert(ranks).values({
        id, jobId: body.jobId, name: body.name, pay: BigInt(body.pay),
        strengthGain: body.strengthGain, labourGain: body.labourGain, iqGain: body.iqGain,
        strengthReq: body.strengthReq, labourReq: body.labourReq, iqReq: body.iqReq,
      });
    });
    return { status: 201, body: { id } };
  },
});

const adminRankUpdateRoute = route({
  method: "POST",
  path: "/api/admin/jobs/ranks/update",
  auth: "admin",
  body: RankUpdateSchema,
  handler: async (ctx, { body }) => {
    const updated = await ctx.transaction(async (tx) => {
      const result = await tx.db
        .update(ranks)
        .set({
          jobId: body.jobId, pay: BigInt(body.pay),
          strengthGain: body.strengthGain, labourGain: body.labourGain, iqGain: body.iqGain,
          strengthReq: body.strengthReq, labourReq: body.labourReq, iqReq: body.iqReq,
          ...(body.name !== undefined && { name: body.name }),
        })
        .where(eq(ranks.id, body.id))
        .returning({ id: ranks.id });
      return result.length > 0;
    });
    if (!updated) throw new PluginError("rank_not_found", 404);
    return { status: 204 };
  },
});

const adminRankDeleteRoute = route({
  method: "DELETE",
  path: "/api/admin/jobs/ranks/:id",
  auth: "admin",
  params: z.object({ id: z.string().uuid() }),
  handler: async (ctx, { params }) => {
    const deleted = await ctx.transaction(async (tx) => {
      const result = await tx.db.delete(ranks).where(eq(ranks.id, params.id)).returning({ id: ranks.id });
      return result.length > 0;
    });
    if (!deleted) throw new PluginError("rank_not_found", 404);
    return { status: 204 };
  },
});

/**
 * Jobs (C spec §4.5): passive daily income with NO cron — wages settle
 * lazily, whole days at a time, wherever employment is read or changed.
 * Interview/promotion are stat gates against the trained stats.
 */
/**
 * Silent (the casino table-tick shape): the payday notification is already
 * the player-visible record, so a feed line would say it twice. What the
 * event is FOR is `invalidates` — the HUD's `hudWage` entry and the Shell's
 * cash stat (`me`) both read state this settle just changed.
 */
const wagesEvent = {
  name: "wages",
  payload: z.object({ days: z.number().int().positive(), total: z.string(), rankName: z.string() }),
  describe: "{actorName} collected {days} day(s) of wages",
  invalidates: ["hudExtras", "me"],
  silent: true,
};

export default definePlugin({
  id: "jobs",
  version: "1.0.0",
  apiVersion: 1,
  basePaths: ["/api/jobs", "/api/admin/jobs"],
  requires: ["mccodes-attributes"],
  migrations: JOBS_MIGRATIONS,
  routes: [
    mineRoute, listRoute, boardRoute, jobsListRoute, interviewRoute, promoteRoute, quitRoute,
    adminJobsListRoute, adminJobCreateRoute, adminJobUpdateRoute, adminJobDeleteRoute,
    adminRanksListRoute, adminRankCreateRoute, adminRankUpdateRoute, adminRankDeleteRoute,
  ],
  events: [wagesEvent],
  filters: [hudWage],
  // The page renders at /plugins/<pageId>, out of reach of the Shell's
  // route→slot banner map, so the banner is this plugin's own singleton drawn
  // by a `slotImage` node in the page view (the theft precedent).
  providesAssets: [
    // Per-row art with its own picker, bound from core's central art section
    // (the theft cars precedent).
    { slot: "job", label: "Jobs", entitySource: "GET /api/admin/jobs/list", entityLabelKey: "name" },
    { slot: "page-jobs", label: "Jobs page banner", singleton: true },
  ],
  pages: [jobsPage],
  adminPages: [adminPage],
});

export { JOBS_MIGRATIONS };
