import { and, asc, eq, sql } from "drizzle-orm";
import { bigint, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { z } from "zod";
import { EDUCATION_MIGRATIONS } from "./migrations.js";
import { definePlugin, isInsufficientFundsError, PluginError, route, type PluginTx } from "@gl3/plugin-sdk";

const courses = pgTable("p_courses", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  cost: bigint("cost", { mode: "bigint" }).notNull(),
  days: integer("days").notNull(),
  strengthGain: integer("strength_gain").notNull(),
  agilityGain: integer("agility_gain").notNull(),
  guardGain: integer("guard_gain").notNull(),
  labourGain: integer("labour_gain").notNull(),
  iqGain: integer("iq_gain").notNull(),
});

const progress = pgTable("p_education_progress", {
  playerId: uuid("player_id").primaryKey(),
  courseId: uuid("course_id").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
});

const done = pgTable("p_courses_done", {
  playerId: uuid("player_id").notNull(),
  courseId: uuid("course_id").notNull(),
});

const DAY_MS = 86_400_000;

/**
 * Resolve a completed enrollment, exactly once: the DELETE's WHERE clause
 * carries the deadline, so of N concurrent readers exactly one's DELETE
 * matches a row and returns it — the membership-expiry claim shape. The
 * caller that deleted is the caller that grants. Returns the course whose
 * stats are owed, or null when nothing was due.
 */
async function claimCompletion(
  tx: PluginTx,
  playerId: string,
): Promise<{ courseId: string } | null> {
  // The DELETE's WHERE carries the deadline, so of N concurrent readers
  // exactly one's DELETE matches a row and returns it — the membership-
  // expiry claim shape. The caller that deleted is the caller that grants.
  const claimed = await tx.db.delete(progress)
    .where(and(
      eq(progress.playerId, playerId),
      sql`${progress.startedAt} <= (
        SELECT now() - make_interval(days => c.days)
        FROM p_courses c WHERE c.id = ${progress.courseId}
      )`,
    ))
    .returning({ courseId: progress.courseId });
  return claimed[0] ?? null;
}

const listRoute = route({
  method: "GET",
  path: "/api/education",
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      await tx.locks.player([player.id]);

      // The tick is the read: an elapsed course completes here, lazily —
      // no cron anywhere (the rounds-sweeper resolve-on-read shape).
      const completed = await claimCompletion(tx, player.id);
      let completedName: string | null = null;
      if (completed !== null) {
        const [course] = await tx.db.select().from(courses).where(eq(courses.id, completed.courseId));
        if (course) {
          if (course.strengthGain > 0) await tx.attributes.train(player.id, "strength", BigInt(course.strengthGain));
          if (course.agilityGain > 0) await tx.attributes.train(player.id, "agility", BigInt(course.agilityGain));
          if (course.guardGain > 0) await tx.attributes.train(player.id, "guard", BigInt(course.guardGain));
          if (course.labourGain > 0) await tx.attributes.train(player.id, "labour", BigInt(course.labourGain));
          if (course.iqGain > 0) await tx.attributes.train(player.id, "iq", BigInt(course.iqGain));
          await tx.db.insert(done).values({ playerId: player.id, courseId: course.id });
          await tx.notify(player.id, `You completed ${course.name}.`);
          completedName = course.name;
        }
      }

      const [activeRow] = await tx.db.select().from(progress).where(eq(progress.playerId, player.id));
      const active = activeRow ?? null;
      const activeCourse = active
        ? (await tx.db.select().from(courses).where(eq(courses.id, active.courseId)))[0] ?? null
        : null;
      const doneRows = await tx.db.select().from(done).where(eq(done.playerId, player.id));
      const doneIds = new Set(doneRows.map((r) => r.courseId));

      const catalog = await tx.db.select().from(courses).orderBy(asc(courses.cost));
      return {
        status: 200,
        body: {
          completedNow: completedName,
          active: active !== null && activeCourse !== null
            ? {
                courseId: activeCourse.id, name: activeCourse.name,
                // ceil of the remaining time, in whole days — an in-progress
                // course always owes at least its current day.
                daysRemaining: Math.max(1, Math.ceil((active.startedAt.getTime() + activeCourse.days * DAY_MS - Date.now()) / DAY_MS)),
              }
            : null,
          courses: catalog.map((c) => ({
            id: c.id, name: c.name, description: c.description,
            cost: c.cost.toString(), days: c.days,
            strengthGain: c.strengthGain, agilityGain: c.agilityGain,
            guardGain: c.guardGain, labourGain: c.labourGain, iqGain: c.iqGain,
            status: doneIds.has(c.id) ? "done" : "available",
          })),
        },
      };
    });
  },
});

const StartSchema = z.object({ courseId: z.string().uuid() }).strict();

const startRoute = route({
  method: "POST",
  path: "/api/education/start",
  body: StartSchema,
  handler: async (ctx, { body }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      await tx.locks.player([player.id]);

      const [course] = await tx.db.select().from(courses).where(eq(courses.id, body.courseId));
      if (!course) throw new PluginError("course_not_found", 404);

      const [active] = await tx.db.select().from(progress).where(eq(progress.playerId, player.id));
      if (active) throw new PluginError("already_studying", 409);

      const [already] = await tx.db.select().from(done)
        .where(and(eq(done.playerId, player.id), eq(done.courseId, course.id)));
      if (already) throw new PluginError("already_completed", 409);

      try {
        await tx.economy.applyBalanceChange(
          { playerId: player.id, amount: -course.cost, kind: "cash", reason: "education.start", refId: course.id },
        );
      } catch (error) {
        if (isInsufficientFundsError(error)) throw new PluginError("insufficient_funds", 409);
        throw error;
      }

      await tx.db.insert(progress).values({ playerId: player.id, courseId: course.id, startedAt: new Date() });
      return { status: 200, body: { courseId: course.id, days: course.days } };
    });
  },
});

/**
 * Education (C spec §4.4): one course at a time, money cost only, no
 * repeats, no cancel — MCCodes parity. Completion is FLAT stat grants
 * (MCCodes has no multipliers), resolved lazily at read with the DELETE
 * as the once-only claim.
 */
export default definePlugin({
  id: "education",
  version: "1.0.0",
  basePaths: ["/api/education"],
  requires: ["mccodes-attributes"],
  migrations: EDUCATION_MIGRATIONS,
  routes: [listRoute, startRoute],
});

export { EDUCATION_MIGRATIONS };
