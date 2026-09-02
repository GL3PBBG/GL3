import { LeaderboardKindSchema } from "@gl3/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { ensureCurrentRound } from "../rounds/service.js";
import type { OutboxDelivery } from "../../bus/outbox.js";
import { roundStandings } from "../rounds/standings.js";
import { DEFAULT_LEADERBOARD_PREFIX, topN } from "./service.js";

const ParamsSchema = z.object({ kind: LeaderboardKindSchema });
/**
 * The default is "all", not "round": every caller that sends no querystring —
 * the web client included — must keep getting the all-time ZSET board, and on
 * an install with no rounds a "round" default would silently answer empty.
 */
const QuerySchema = z.object({ scope: z.enum(["round", "all"]).default("all") }).strict();

export function registerLeaderboardRoutes(
  app: FastifyInstance, db: Db, deliver: OutboxDelivery, redis: Redis,
  settings: Record<string, string>,
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
  leaderboardPrefix = DEFAULT_LEADERBOARD_PREFIX,
  routed = false,
): void {
  app.get("/api/leaderboard/:kind", { preHandler: requireAuth }, async (request, reply) => {
    // Unconditional, before the params parse: branching on the query param to
    // skip it would let the all-time board observe a round that ended an hour
    // ago as still active, for no saving beyond one indexed SELECT.
    const active = await ensureCurrentRound(db, deliver, settings);

    const params = ParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_kind" });
    const query = QuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "invalid_scope" });

    // "level" only for the exp kind on a routed boot; absent (raw exp)
    // otherwise — cash/bank never carry this field, and it applies the same
    // way to both scopes below, since round deltas are deltas of whatever
    // score the ZSET holds (composite when routed).
    const mode = params.data.kind === "exp" && routed ? "level" as const : undefined;

    if (query.data.scope === "round") {
      // No active round is an empty board, not a 404: an empty board is the
      // honest answer for "this season's standings" on a game with no season.
      const entries = active === null
        ? []
        : await roundStandings(db, active.id, params.data.kind, 10, false);
      return reply.send({ kind: params.data.kind, entries, ...(mode !== undefined ? { mode } : {}) });
    }

    const entries = await topN(db, redis, params.data.kind, 10, leaderboardPrefix);
    return reply.send({ kind: params.data.kind, entries, ...(mode !== undefined ? { mode } : {}) });
  });
}
