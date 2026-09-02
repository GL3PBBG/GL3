import { LeaderboardKindSchema, IdSchema } from "@gl3/shared";
import { desc, eq, isNotNull, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { OutboxDelivery } from "../../bus/outbox.js";
import type { Db } from "../../db/client.js";
import { rounds } from "../../db/schema/index.js";
import { ensureCurrentRound } from "./service.js";
import { roundStandings } from "./standings.js";

const ParamsSchema = z.object({ id: IdSchema });
const QuerySchema = z.object({ kind: LeaderboardKindSchema.default("exp") }).strict();

/** Same count the all-time board uses, so the boards agree on length. */
const BOARD_SIZE = 10;

interface RoundRow {
  id: string; name: string;
  startsAt: Date | null; endsAt: Date | null; finalizedAt: Date | null;
}

/**
 * Sent as a countdown rather than only `endsAt` so the client's clock skew
 * cannot make a round look already-over on one machine and live on another.
 */
function secondsRemaining(endsAt: Date | null): number | null {
  if (endsAt === null) return null;
  return Math.max(0, Math.floor((endsAt.getTime() - Date.now()) / 1000));
}

const toDto = (row: RoundRow) => ({
  id: row.id,
  name: row.name,
  startsAt: row.startsAt?.toISOString() ?? null,
  endsAt: row.endsAt?.toISOString() ?? null,
  secondsRemaining: secondsRemaining(row.endsAt),
  finalizedAt: row.finalizedAt?.toISOString() ?? null,
});

export function registerRoundsRoutes(
  app: FastifyInstance, db: Db, deliver: OutboxDelivery,
  settings: Record<string, string>,
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
  routed = false,
): void {
  app.get("/api/rounds", { preHandler: requireAuth }, async (_request, reply) => {
    // First, so visiting the Rounds page is one of the things that can trigger
    // a rollover.
    const active = await ensureCurrentRound(db, deliver, settings);

    // ends_at is nullable and Postgres sorts NULLs FIRST under DESC, so a
    // finalized open-ended round — exactly what the V2 migrator brings over —
    // would head the hall of fame instead of tailing it. id DESC gives a total
    // order; ids are uuidv7, so descending id is descending creation time.
    const finishedRows = await db.select().from(rounds)
      .where(isNotNull(rounds.finalizedAt))
      .orderBy(sql`${rounds.endsAt} desc nulls last`, desc(rounds.id));

    const activeRow = active === null
      ? null
      : (await db.select().from(rounds).where(eq(rounds.id, active.id)))[0] ?? null;

    return reply.send({
      active: activeRow === null ? null : toDto(activeRow),
      finished: finishedRows.map(toDto),
    });
  });

  app.get("/api/rounds/:id/standings", { preHandler: requireAuth }, async (request, reply) => {
    // An ended-but-unsettled round must settle before it is read, or this same
    // request would report a live board for a round that is over.
    await ensureCurrentRound(db, deliver, settings);

    const params = ParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_request" });
    const query = QuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "invalid_kind" });

    const [round] = await db.select().from(rounds).where(eq(rounds.id, params.data.id));
    if (!round) return reply.code(404).send({ error: "round_not_found" });

    const finalized = round.finalizedAt !== null;
    const entries = await roundStandings(db, round.id, query.data.kind, BOARD_SIZE, finalized);
    // Same rule as the leaderboard route: "level" only for the exp kind on a
    // routed boot, cash/bank never carry it.
    const mode = query.data.kind === "exp" && routed ? "level" as const : undefined;
    return reply.send({
      roundId: round.id, roundName: round.name, kind: query.data.kind, finalized, entries,
      ...(mode !== undefined ? { mode } : {}),
    });
  });
}
