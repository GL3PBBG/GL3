import { and, asc, desc, eq, gt, lte } from "drizzle-orm";
import { bigint, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { z } from "zod";
import { JOBS_MIGRATIONS } from "./migrations.js";
import { definePlugin, PluginError, route, type PluginTx } from "@gl3/plugin-sdk";

const jobs = pgTable("p_jobs", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  firstRankId: uuid("first_rank_id").notNull(),
});

const ranks = pgTable("p_job_ranks", {
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

const employment = pgTable("p_player_jobs", {
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
async function settleWages(tx: PluginTx, playerId: string): Promise<number> {
  const row = await employmentWithRank(tx, playerId);
  if (row === null) return 0;

  const days = Math.floor((Date.now() - row.lastWageAt.getTime()) / DAY_MS);
  if (days <= 0) return 0;

  if (row.pay > 0n) {
    await tx.economy.applyBalanceChange(
      { playerId, amount: row.pay * BigInt(days), kind: "cash", reason: "jobs.wage", refId: row.rankId },
    );
    await tx.economy.applyExpAndRankUp(playerId, (row.pay * BigInt(days)) / 20n);
  }
  if (row.strengthGain > 0) await tx.attributes.train(playerId, "strength", BigInt(row.strengthGain * days));
  if (row.labourGain > 0) await tx.attributes.train(playerId, "labour", BigInt(row.labourGain * days));
  if (row.iqGain > 0) await tx.attributes.train(playerId, "iq", BigInt(row.iqGain * days));

  await tx.db.update(employment)
    .set({ lastWageAt: new Date(row.lastWageAt.getTime() + days * DAY_MS) })
    .where(eq(employment.playerId, playerId));
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
      const daysSettled = await settleWages(tx, player.id);
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
      await settleWages(tx, player.id);

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
      await settleWages(tx, player.id); // a fair exit: owed days pay out
      const deleted = await tx.db.delete(employment)
        .where(eq(employment.playerId, player.id))
        .returning({ playerId: employment.playerId });
      if (deleted.length === 0) throw new PluginError("not_employed", 409);
      return { status: 200, body: { quit: true } };
    });
  },
});

/**
 * Jobs (C spec §4.5): passive daily income with NO cron — wages settle
 * lazily, whole days at a time, wherever employment is read or changed.
 * Interview/promotion are stat gates against the trained stats.
 */
export default definePlugin({
  id: "jobs",
  version: "1.0.0",
  basePaths: ["/api/jobs"],
  requires: ["mccodes-attributes"],
  migrations: JOBS_MIGRATIONS,
  routes: [mineRoute, listRoute, interviewRoute, promoteRoute, quitRoute],
});

export { JOBS_MIGRATIONS };
