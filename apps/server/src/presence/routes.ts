import { asc, eq, ilike, inArray } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { locations, players, playerStats, ranks } from "../db/schema/index.js";
import { PRESENCE_KEY, PRESENCE_ONLINE_WINDOW_MS, PRESENCE_RECENT_WINDOW_MS } from "./touch.js";

const FIVE_MINUTES_MS = PRESENCE_ONLINE_WINDOW_MS;
const ONE_HOUR_MS = PRESENCE_RECENT_WINDOW_MS;

const SEARCH_LIMIT = 20;

const SearchQuerySchema = z.object({
  q: z.string().trim().min(2).max(30),
});

/**
 * Neutralises LIKE metacharacters so a searched `%` matches a literal `%`
 * rather than every row. The backslash goes first — escaping it after `%`
 * and `_` would re-escape the escapes this very function just inserted.
 *
 * Postgres LIKE takes `\` as its escape character by default, so the pattern
 * needs no explicit ESCAPE clause; it travels as a bind parameter, where
 * `standard_conforming_strings` has no say.
 */
function escapeLikePattern(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export function registerPresenceRoutes(
  app: FastifyInstance, db: Db, redis: Redis,
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
): void {
  app.get("/api/online", { preHandler: requireAuth }, async (_request, reply) => {
    const now = Date.now();
    // Lazy trim — no cron, mirrors ensureCurrentRound's settle-at-read shape.
    await redis.zremrangebyscore(PRESENCE_KEY, "-inf", now - ONE_HOUR_MS);
    const flat = await redis.zrangebyscore(PRESENCE_KEY, now - ONE_HOUR_MS, "+inf", "WITHSCORES");

    const scores = new Map<string, number>();
    for (let i = 0; i < flat.length; i += 2) scores.set(flat[i]!, Number(flat[i + 1]));
    const ids = [...scores.keys()];
    if (ids.length === 0) return reply.send({ onlineNow: [], lastHour: [] });

    // `locationId` lives on player_stats, not players (identity.ts) — the
    // same 1:1 split the profile route joins through.
    const rows = await db.select({
      id: players.id, username: players.username,
      locationName: locations.name, combatMode: locations.combatMode,
    }).from(players)
      .innerJoin(playerStats, eq(playerStats.playerId, players.id))
      .leftJoin(locations, eq(playerStats.locationId, locations.id))
      .where(inArray(players.id, ids));

    const entries = rows.map((row) => ({
      playerId: row.id, username: row.username,
      // Underground towns conceal residents (combat-modes spec); name and
      // recency still list — the town is what disappears.
      locationName: row.combatMode === "underground" ? null : row.locationName,
      lastActiveAt: new Date(scores.get(row.id)!).toISOString(),
    })).sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));

    return reply.send({
      onlineNow: entries.filter((e) => scores.get(e.playerId)! >= now - FIVE_MINUTES_MS),
      lastHour: entries.filter((e) => scores.get(e.playerId)! < now - FIVE_MINUTES_MS),
    });
  });

  // Find a player by name. Deliberately narrower than /api/online: username
  // and rank only, no location — an underground town's residents are
  // concealed by every other read (online.ts above, combat targets), and a
  // name search must not become the seam that leaks them.
  app.get("/api/players/search", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = SearchQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });

    const rows = await db.select({
      id: players.id, username: players.username, rankName: ranks.name,
    }).from(players)
      .innerJoin(playerStats, eq(playerStats.playerId, players.id))
      .leftJoin(ranks, eq(ranks.id, playerStats.rankId))
      .where(ilike(players.username, `%${escapeLikePattern(parsed.data.q)}%`))
      .orderBy(asc(players.username))
      .limit(SEARCH_LIMIT);

    return reply.send({
      players: rows.map((row) => ({
        playerId: row.id, username: row.username, rankName: row.rankName,
      })),
    });
  });
}
