import { definePlugin, InsufficientFundsError, PluginError, route } from "@gl3/plugin-sdk";
import { eq, isNull, desc } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { bounties, players, playerStats, ranks } from "./schema.js";

/**
 * `@gl3/shared` is off-limits to a plugin package, so `MoneySchema`'s regex is
 * restated here (the pattern bank/src/index.ts:22 documents).
 */
const PlaceBodySchema = z.object({
  targetUsername: z.string().min(1).max(30),
  amount: z.string().regex(/^-?\d+$/, "must be an integer string"),
});

const DEFAULT_MIN_AMOUNT = 1000n;

function readMinAmount(settings: { get(key: string): string | null }): bigint {
  const raw = settings.get("minAmount");
  if (raw === null) return DEFAULT_MIN_AMOUNT;
  return /^\d+$/.test(raw) ? BigInt(raw) : DEFAULT_MIN_AMOUNT;
}

const placeRoute = route({
  method: "POST",
  path: "/api/bounties",
  body: PlaceBodySchema,
  handler: async (ctx, { body }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    const amount = BigInt(body.amount);
    if (amount <= 0n) throw new PluginError("amount_must_be_positive", 400);
    if (amount < readMinAmount(ctx.settings)) {
      throw new PluginError("below_minimum", 409);
    }

    return ctx.transaction(async (tx) => {
      // Resolve BEFORE locking: a plain SELECT takes no row lock, and the
      // username -> id mapping is immutable, so there is nothing to re-check.
      const [target] = await tx.db
        .select({ id: players.id, username: players.username })
        .from(players)
        .where(eq(players.username, body.targetUsername));
      if (!target) throw new PluginError("target_not_found", 404);
      if (target.id === player.id) throw new PluginError("self_bounty", 409);

      // FIRST lock, both players, sorted, one statement — the row INSERT
      // below takes FOR KEY SHARE on BOTH via its FKs, and combat locks the
      // same pair sorted. Debit-then-insert without this is an ABBA deadlock
      // against a fight the placer is in (spec §3, NOTES.md rule 6).
      await tx.locks.player([player.id, target.id]);

      const [mine] = await tx.db
        .select({ gangId: playerStats.gangId })
        .from(playerStats)
        .where(eq(playerStats.playerId, player.id));
      const [theirs] = await tx.db
        .select({ gangId: playerStats.gangId })
        .from(playerStats)
        .where(eq(playerStats.playerId, target.id));
      if (mine?.gangId != null && mine.gangId === theirs?.gangId) {
        throw new PluginError("same_gang", 409);
      }

      let cash: bigint;
      try {
        cash = await tx.economy.applyBalanceChange({
          playerId: player.id,
          amount: -amount,
          kind: "cash",
          reason: "bounties.placed",
        });
      } catch (err) {
        if (err instanceof InsufficientFundsError) throw new PluginError("insufficient_funds", 409);
        throw err;
      }

      const id = uuidv7();
      await tx.db.insert(bounties).values({ id, placedBy: player.id, target: target.id, amount });

      // Global audience: the open list is public (spec §3). Reveals that the
      // target is hunted, not where they are.
      await tx.events.publishCore({
        type: "bounty.placed",
        actorId: player.id,
        actorName: player.username,
        audience: { kind: "global" },
        bountyId: id,
        targetId: target.id,
        targetName: target.username,
        amount: amount.toString(),
      });

      return { status: 201, body: { bountyId: id, cash: cash.toString() } };
    });
  },
});

/**
 * Open bounties, public to any logged-in player (spec §2: public placer).
 * Bounded at 100 and NOT paginated — the same deliberate limitation
 * GET /api/combat/log has; the list self-prunes on every claim.
 */
const listRoute = route({
  method: "GET",
  path: "/api/bounties",
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      const targetPlayers = alias(players, "target_players");
      const placerPlayers = alias(players, "placer_players");
      const rows = await tx.db
        .select({
          id: bounties.id,
          amount: bounties.amount,
          createdAt: bounties.createdAt,
          targetId: bounties.target,
          targetUsername: targetPlayers.username,
          targetRank: ranks.name,
          placerUsername: placerPlayers.username,
        })
        .from(bounties)
        .innerJoin(targetPlayers, eq(targetPlayers.id, bounties.target))
        .innerJoin(placerPlayers, eq(placerPlayers.id, bounties.placedBy))
        .leftJoin(playerStats, eq(playerStats.playerId, bounties.target))
        .leftJoin(ranks, eq(ranks.id, playerStats.rankId))
        .where(isNull(bounties.claimedBy))
        .orderBy(desc(bounties.createdAt), desc(bounties.id))
        .limit(100);

      return {
        status: 200,
        body: {
          bounties: rows.map((r) => ({
            id: r.id,
            amount: r.amount.toString(),
            createdAt: r.createdAt.toISOString(),
            targetId: r.targetId,
            targetUsername: r.targetUsername,
            targetRank: r.targetRank,
            placerUsername: r.placerUsername,
          })),
        },
      };
    });
  },
});

export default definePlugin({
  id: "bounties",
  version: "1.0.0",
  basePaths: ["/api/bounties"],
  routes: [placeRoute, listRoute],
});
