import { and, asc, eq, sql } from "drizzle-orm";
import { bigint, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { EDUCATION_MIGRATIONS } from "./migrations.js";
import { adminPage, educationPage } from "./pages.js";
import { coreHud, definePlugin, isInsufficientFundsError, on, PluginError, route, type PluginTx } from "@gl3/plugin-sdk";
// Re-exported so `apps/server/test/education-page.test.ts` can assert against
// the same page object rather than a hand-copied duplicate of its view tree —
// the houses precedent.
export { adminPage, educationPage } from "./pages.js";

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

type SettledEducation = {
  completedName: string | null;
  active: { courseId: string; name: string; daysRemaining: number } | null;
  catalog: Array<{
    id: string; name: string; description: string; cost: bigint; days: number;
    strengthGain: number; agilityGain: number; guardGain: number; labourGain: number; iqGain: number;
    status: "done" | "available";
  }>;
};

/**
 * The lazy-completion tick plus the full read, shared by `/api/education`
 * and `/api/education/board` — the board is a read too and must ALSO
 * settle an elapsed course, so this is the one place the tick logic lives
 * rather than being duplicated across the two handlers.
 */
async function settleAndRead(tx: PluginTx, playerId: string): Promise<SettledEducation> {
  // The tick is the read: an elapsed course completes here, lazily — no
  // cron anywhere (the rounds-sweeper resolve-on-read shape).
  const completed = await claimCompletion(tx, playerId);
  let completedName: string | null = null;
  if (completed !== null) {
    const [course] = await tx.db.select().from(courses).where(eq(courses.id, completed.courseId));
    if (course) {
      if (course.strengthGain > 0) await tx.attributes.train(playerId, "strength", BigInt(course.strengthGain));
      if (course.agilityGain > 0) await tx.attributes.train(playerId, "agility", BigInt(course.agilityGain));
      if (course.guardGain > 0) await tx.attributes.train(playerId, "guard", BigInt(course.guardGain));
      if (course.labourGain > 0) await tx.attributes.train(playerId, "labour", BigInt(course.labourGain));
      if (course.iqGain > 0) await tx.attributes.train(playerId, "iq", BigInt(course.iqGain));
      await tx.db.insert(done).values({ playerId, courseId: course.id });
      await tx.notify(playerId, `You completed ${course.name}.`);
      completedName = course.name;
    }
  }

  const [activeRow] = await tx.db.select().from(progress).where(eq(progress.playerId, playerId));
  const active = activeRow ?? null;
  const activeCourse = active
    ? (await tx.db.select().from(courses).where(eq(courses.id, active.courseId)))[0] ?? null
    : null;
  const doneRows = await tx.db.select().from(done).where(eq(done.playerId, playerId));
  const doneIds = new Set(doneRows.map((r) => r.courseId));

  const catalog = await tx.db.select().from(courses).orderBy(asc(courses.cost));
  return {
    completedName,
    active: active !== null && activeCourse !== null
      ? {
          courseId: activeCourse.id, name: activeCourse.name,
          // ceil of the remaining time, in whole days — an in-progress
          // course always owes at least its current day.
          daysRemaining: Math.max(1, Math.ceil((active.startedAt.getTime() + activeCourse.days * DAY_MS - Date.now()) / DAY_MS)),
        }
      : null,
    catalog: catalog.map((c) => ({
      id: c.id, name: c.name, description: c.description, cost: c.cost, days: c.days,
      strengthGain: c.strengthGain, agilityGain: c.agilityGain, guardGain: c.guardGain,
      labourGain: c.labourGain, iqGain: c.iqGain,
      status: doneIds.has(c.id) ? "done" as const : "available" as const,
    })),
  };
}

const listRoute = route({
  method: "GET",
  path: "/api/education",
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      await tx.locks.player([player.id]);
      const data = await settleAndRead(tx, player.id);
      return {
        status: 200,
        body: {
          completedNow: data.completedName,
          active: data.active,
          courses: data.catalog.map((c) => ({
            id: c.id, name: c.name, description: c.description,
            cost: c.cost.toString(), days: c.days,
            strengthGain: c.strengthGain, agilityGain: c.agilityGain,
            guardGain: c.guardGain, labourGain: c.labourGain, iqGain: c.iqGain,
            status: c.status,
          })),
        },
      };
    });
  },
});

/**
 * The catalog plus the caller's active enrollment, composed from the same
 * `settleAndRead` tick+read `listRoute` uses, shaped as a `TableRowsResponse`
 * (the houses-board sourced-contract shape) — every field a string, `values`
 * empty while the caller studies nothing.
 */
const boardRoute = route({
  method: "GET",
  path: "/api/education/board",
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      await tx.locks.player([player.id]);
      const data = await settleAndRead(tx, player.id);

      const values: Record<string, string> = {};
      if (data.active !== null) {
        values.activeName = data.active.name;
        values.daysRemaining = String(data.active.daysRemaining);
      }

      return {
        status: 200,
        body: {
          rows: data.catalog.map((c) => ({
            id: c.id, name: c.name, description: c.description,
            cost: c.cost.toString(), days: String(c.days),
            strengthGain: String(c.strengthGain), agilityGain: String(c.agilityGain),
            guardGain: String(c.guardGain), labourGain: String(c.labourGain), iqGain: String(c.iqGain),
            status: c.status,
          })),
          values,
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

// ---------------------------------------------------------------------------
// core.hud (membership's `hudCountdown` shape). Unlike membership's read,
// this one takes NO lock and calls NO tick — it is a plain SELECT pair, since
// the brief is explicit that the HUD path must not write. An elapsed course
// still completes correctly the next time the player visits `/api/education`
// or `/api/education/board`; the HUD is display only.
// ---------------------------------------------------------------------------

const hudCourse = on(coreHud, async (ctx, value) => {
  const player = ctx.player;
  if (player === null) return value;

  const found = await ctx.transaction(async (tx) => {
    const [activeRow] = await tx.db.select().from(progress).where(eq(progress.playerId, player.id));
    if (!activeRow) return null;
    const [course] = await tx.db.select().from(courses).where(eq(courses.id, activeRow.courseId));
    if (!course) return null;
    return { startedAt: activeRow.startedAt, course };
  });
  if (found === null) return value;

  const daysRemaining = Math.max(
    1,
    Math.ceil((found.startedAt.getTime() + found.course.days * DAY_MS - Date.now()) / DAY_MS),
  );
  return [...value, {
    pluginId: ctx.pluginId, label: "Course", value: `${found.course.name}: ${daysRemaining} day(s) left`,
  }];
});

// ---------------------------------------------------------------------------
// Admin routes — the catalog editor. Houses' four-route shape
// (`packages/plugins/houses/src/index.ts`'s admin section): list/create/
// update/delete, `auth: "admin"`, an update that blanks a rename. No FK
// references `p_courses`, so a delete is unconditional, the houses/
// membership shape.
// ---------------------------------------------------------------------------

const AdminMoney = z.string().regex(/^\d+$/, "nonnegative integer string");

/** The blank-normalises-to-undefined convention (houses/theft/membership). */
function blankable<T extends z.ZodTypeAny>(inner: T): z.ZodEffects<z.ZodOptional<T>> {
  return z.preprocess((v) => (v === "" ? undefined : v), inner.optional()) as never;
}

const CourseCreateSchema = z
  .object({
    name: z.string().min(1).max(80),
    description: z.string().min(1),
    cost: AdminMoney,
    days: z.coerce.number().int().positive(),
    strengthGain: z.coerce.number().int().nonnegative(),
    agilityGain: z.coerce.number().int().nonnegative(),
    guardGain: z.coerce.number().int().nonnegative(),
    labourGain: z.coerce.number().int().nonnegative(),
    iqGain: z.coerce.number().int().nonnegative(),
  })
  .strict();

const CourseUpdateSchema = z
  .object({
    id: z.string().uuid(),
    name: blankable(z.string().min(1).max(80)),
    description: blankable(z.string().min(1)),
    cost: AdminMoney,
    days: z.coerce.number().int().positive(),
    strengthGain: z.coerce.number().int().nonnegative(),
    agilityGain: z.coerce.number().int().nonnegative(),
    guardGain: z.coerce.number().int().nonnegative(),
    labourGain: z.coerce.number().int().nonnegative(),
    iqGain: z.coerce.number().int().nonnegative(),
  })
  .strict();

function courseRow(c: typeof courses.$inferSelect) {
  return {
    id: c.id, name: c.name, description: c.description, cost: c.cost.toString(), days: String(c.days),
    strengthGain: String(c.strengthGain), agilityGain: String(c.agilityGain), guardGain: String(c.guardGain),
    labourGain: String(c.labourGain), iqGain: String(c.iqGain),
  };
}

/** The catalog as a `TableRowsResponse`. `id` is the update form's select `valueKey` and is never rendered as a column. */
const adminListRoute = route({
  method: "GET",
  path: "/api/admin/education/list",
  auth: "admin",
  handler: async (ctx) => {
    const rows = await ctx.transaction(async (tx) => tx.db.select().from(courses).orderBy(asc(courses.cost)));
    return { status: 200, body: { rows: rows.map(courseRow) } };
  },
});

const adminCreateRoute = route({
  method: "POST",
  path: "/api/admin/education",
  auth: "admin",
  body: CourseCreateSchema,
  handler: async (ctx, { body }) => {
    const id = uuidv7();
    await ctx.transaction(async (tx) => {
      await tx.db.insert(courses).values({
        id, name: body.name, description: body.description, cost: BigInt(body.cost), days: body.days,
        strengthGain: body.strengthGain, agilityGain: body.agilityGain, guardGain: body.guardGain,
        labourGain: body.labourGain, iqGain: body.iqGain,
      });
    });
    return { status: 201, body: { id } };
  },
});

const adminUpdateRoute = route({
  method: "POST",
  path: "/api/admin/education/update",
  auth: "admin",
  body: CourseUpdateSchema,
  handler: async (ctx, { body }) => {
    const updated = await ctx.transaction(async (tx) => {
      const result = await tx.db
        .update(courses)
        .set({
          cost: BigInt(body.cost), days: body.days,
          strengthGain: body.strengthGain, agilityGain: body.agilityGain, guardGain: body.guardGain,
          labourGain: body.labourGain, iqGain: body.iqGain,
          ...(body.name !== undefined && { name: body.name }),
          ...(body.description !== undefined && { description: body.description }),
        })
        .where(eq(courses.id, body.id))
        .returning({ id: courses.id });
      return result.length > 0;
    });
    if (!updated) throw new PluginError("course_not_found", 404);
    return { status: 204 };
  },
});

const adminDeleteRoute = route({
  method: "DELETE",
  path: "/api/admin/education/:id",
  auth: "admin",
  params: z.object({ id: z.string().uuid() }),
  handler: async (ctx, { params }) => {
    const deleted = await ctx.transaction(async (tx) => {
      const result = await tx.db.delete(courses).where(eq(courses.id, params.id)).returning({ id: courses.id });
      return result.length > 0;
    });
    if (!deleted) throw new PluginError("course_not_found", 404);
    return { status: 204 };
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
  basePaths: ["/api/education", "/api/admin/education"],
  requires: ["mccodes-attributes"],
  migrations: EDUCATION_MIGRATIONS,
  routes: [
    listRoute, boardRoute, startRoute,
    adminListRoute, adminCreateRoute, adminUpdateRoute, adminDeleteRoute,
  ],
  filters: [hudCourse],
  pages: [educationPage],
  adminPages: [adminPage],
});

export { EDUCATION_MIGRATIONS };
