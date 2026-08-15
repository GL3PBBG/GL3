import { desc, eq, lte } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { IdSchema, UpdateProfileRequestSchema } from "@gl3/shared";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { gangs, moneyRanks, players, playerStats, ranks } from "../../db/schema/index.js";

const ProfileParamsSchema = z.object({ playerId: IdSchema });

export function registerProfileRoutes(
  app: FastifyInstance, db: Db,
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
): void {
  // Public — no requireAuth. The response is a public surface: only the
  // explicit columns selected below ever leave this handler. `players`
  // carries passwordHash/legacy password columns, and `player_stats` carries
  // cash/bank/points. The rule is that a wealth BRACKET is public and a
  // wealth FIGURE is not: `cash` and `bank` are selected here solely to
  // resolve the `money_ranks` label, and neither is ever returned. This
  // never selects a whole row and spreads it into the response.
  app.get("/api/players/:playerId/profile", async (request, reply) => {
    const params = ProfileParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_request" });

    const [row] = await db.select({
      playerId: players.id, username: players.username, createdAt: players.createdAt,
      bio: playerStats.bio, avatarUrl: playerStats.avatarUrl, exp: playerStats.exp,
      gangId: playerStats.gangId, gangName: gangs.name, rankName: ranks.name,
      cash: playerStats.cash, bank: playerStats.bank, backfire: playerStats.backfire,
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

    return reply.send({
      playerId: row.playerId, username: row.username, bio: row.bio, avatarUrl: row.avatarUrl,
      gangId: row.gangId, gangName: row.gangName, exp: row.exp.toString(), rankName: row.rankName,
      moneyRankLabel: bracket?.label ?? null,
      backfire: row.backfire,
      createdAt: row.createdAt.toISOString(),
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
