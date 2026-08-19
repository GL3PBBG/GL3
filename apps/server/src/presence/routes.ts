import { eq, inArray } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import type { Db } from "../db/client.js";
import { locations, players, playerStats } from "../db/schema/index.js";
import { PRESENCE_KEY } from "./touch.js";

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

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
}
