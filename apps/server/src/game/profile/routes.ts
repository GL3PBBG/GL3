import { desc, eq, lte } from "drizzle-orm";
import { coreProfileView } from "@gl3/plugin-sdk";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import { IdSchema, ProfileExtraSchema, UpdateProfileRequestSchema } from "@gl3/shared";
import { z } from "zod";
import { DEFAULT_RATE_LIMIT_PREFIX, tokenBucket } from "../../auth/rate-limit.js";
import type { Db } from "../../db/client.js";
import { gangs, moneyRanks, players, playerStats, ranks } from "../../db/schema/index.js";
import type { CoreFilters } from "../../plugins/core-filters.js";

const ProfileParamsSchema = z.object({ playerId: IdSchema });

export function registerProfileRoutes(
  app: FastifyInstance, db: Db, redis: Redis,
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
  coreFilters: CoreFilters,
  rateLimitPrefix = DEFAULT_RATE_LIMIT_PREFIX,
): void {
  // Public — no requireAuth. The response is a public surface: only the
  // explicit columns selected below ever leave this handler. `players`
  // carries passwordHash/legacy password columns, and `player_stats` carries
  // cash/bank/points. The rule is that a wealth BRACKET is public and a
  // wealth FIGURE is not: `cash` and `bank` are selected here solely to
  // resolve the `money_ranks` label, and neither is ever returned. This
  // never selects a whole row and spreads it into the response.
  app.get("/api/players/:playerId/profile", {
    preHandler: tokenBucket(redis, { name: "profile", limit: 60, windowSeconds: 60 }, rateLimitPrefix),
  }, async (request, reply) => {
    const params = ProfileParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_request" });

    const [row] = await db.select({
      playerId: players.id, username: players.username, createdAt: players.createdAt,
      bio: playerStats.bio, avatarUrl: playerStats.avatarUrl, exp: playerStats.exp,
      gangId: playerStats.gangId, gangName: gangs.name, rankName: ranks.name,
      cash: playerStats.cash, bank: playerStats.bank, backfire: playerStats.backfire,
      lastSeenAt: players.lastSeenAt,
    })
      .from(players)
      .innerJoin(playerStats, eq(playerStats.playerId, players.id))
      .leftJoin(gangs, eq(gangs.id, playerStats.gangId))
      .leftJoin(ranks, eq(ranks.id, playerStats.rankId))
      .where(eq(players.id, params.data.playerId));

    if (!row) return reply.code(404).send({ error: "player_not_found" });

    // Highest bracket at or below the player's wealth; inclusive at the
    // threshold. A separate query rather than a join: a correlated
    // "greatest row below" join is harder to read than two statements, and
    // this route is not hot.
    const [bracket] = await db.select({ label: moneyRanks.label })
      .from(moneyRanks)
      .where(lte(moneyRanks.threshold, row.cash + row.bank))
      .orderBy(desc(moneyRanks.threshold))
      .limit(1);

    // Public route — no authenticated caller, so subscribers get `player:
    // null` and key off `value.targetId` instead.
    const applied = await coreFilters.apply(coreProfileView, null, {
      targetId: row.playerId, extras: [],
    });

    // Per-entry validation, not a whole-array parse: a subscriber's malformed
    // extra (a `PLUGIN_PACKAGES`-loaded plugin is never typechecked against
    // `ProfileExtraSchema`) must lose only its own contribution, the same way
    // a throwing subscriber already loses only its own under collect policy —
    // never fail the whole public profile page for every viewer.
    const extras = applied.extras.filter((extra) => {
      const parsed = ProfileExtraSchema.safeParse(extra);
      if (!parsed.success) {
        request.log.warn({ pointName: coreProfileView.name, extra, issues: parsed.error.issues }, "dropped a malformed extension contribution");
      }
      return parsed.success;
    });

    return reply.send({
      playerId: row.playerId, username: row.username, bio: row.bio, avatarUrl: row.avatarUrl,
      gangId: row.gangId, gangName: row.gangName, exp: row.exp.toString(), rankName: row.rankName,
      moneyRankLabel: bracket?.label ?? null,
      backfire: row.backfire,
      createdAt: row.createdAt.toISOString(),
      lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
      extras,
    });
  });

  app.put("/api/profile", { preHandler: requireAuth }, async (request, reply) => {
    const playerId = request.playerId;
    if (!playerId) return reply.code(401).send({ error: "unauthorized" });

    const parsed = UpdateProfileRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });

    await db.update(playerStats).set({
      ...(parsed.data.bio !== undefined ? { bio: parsed.data.bio } : {}),
      ...(parsed.data.avatarUrl !== undefined ? { avatarUrl: parsed.data.avatarUrl } : {}),
    }).where(eq(playerStats.playerId, playerId));

    return reply.code(200).send({ ok: true });
  });
}
