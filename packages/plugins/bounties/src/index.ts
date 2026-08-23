import { coreProfileView, definePlugin, InsufficientFundsError, on, PluginError, route } from "@gl3/plugin-sdk";
import { killResolved } from "@gl3/plugin-combat";
import { and, eq, isNull, desc } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { BOUNTIES_MIGRATIONS } from "./migrations.js";
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
          targetPlayerId: bounties.target,
          placerPlayerId: bounties.placedBy,
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
            targetPlayerId: r.targetPlayerId,
            placerPlayerId: r.placerPlayerId,
          })),
        },
      };
    });
  },
});

/**
 * The V2 `userKilled` hook, GL3-shaped: combat applies `killResolved` after
 * its kill transaction commits; this subscriber sweeps every open bounty on
 * the victim to the killer in its OWN transaction. Idempotent by shape —
 * `WHERE claimed_by IS NULL` claims each row exactly once — and crash-safe
 * without a queue: if this never runs, the rows stay open and the next kill
 * of the same target sweeps them (spec §3).
 */
const claimOnKill = on(killResolved, async (ctx, value) => {
  await ctx.transaction(async (tx) => {
    // Killer's row is about to take a balance write and a FOR KEY SHARE from
    // the claimed_by FK; same first-statement lock rule as everywhere else.
    await tx.locks.player([value.killerId]);

    const claimed = await tx.db
      .update(bounties)
      .set({ claimedBy: value.killerId })
      .where(and(eq(bounties.target, value.victimId), isNull(bounties.claimedBy)))
      .returning({ id: bounties.id, amount: bounties.amount, placedBy: bounties.placedBy });
    if (claimed.length === 0) return;

    const total = claimed.reduce((sum, row) => sum + row.amount, 0n);
    await tx.economy.applyBalanceChange({
      playerId: value.killerId,
      amount: total,
      kind: "cash",
      reason: "bounties.claimed",
    });

    const [killer] = await tx.db
      .select({ username: players.username }).from(players)
      .where(eq(players.id, value.killerId));
    const [victim] = await tx.db
      .select({ username: players.username }).from(players)
      .where(eq(players.id, value.victimId));
    const killerName = killer?.username ?? "unknown";
    const victimName = victim?.username ?? "unknown";

    // Killer and that row's placer, per row — AudienceSchema has no
    // two-player kind (same reasoning as combat's player.attacked pair).
    for (const row of claimed) {
      for (const audienceId of [value.killerId, row.placedBy]) {
        await tx.events.publishCore({
          type: "bounty.claimed",
          actorId: value.killerId,
          actorName: killerName,
          audience: { kind: "player", playerId: audienceId },
          bountyId: row.id,
          targetId: value.victimId,
          targetName: victimName,
          amount: row.amount.toString(),
        });
      }
    }

    for (const placerId of [...new Set(claimed.map((row) => row.placedBy))]) {
      await tx.notify(placerId, `Your bounty on ${victimName} was claimed by ${killerName}.`);
    }
  });
  return value;
});

/**
 * core.profileView (spec §2): a plain SELECT, no lock — this runs on a public
 * read path, same shape as `listRoute` above. The link is always contributed
 * so any profile has a way in to place a bounty; the stat only appears when
 * there is something open to report (`total > 0n`).
 */
const profileExtras = on(coreProfileView, async (ctx, value) => {
  const rows = await ctx.transaction(async (tx) => tx.db
    .select({ amount: bounties.amount })
    .from(bounties)
    .where(and(eq(bounties.target, value.targetId), isNull(bounties.claimedBy))));
  const total = rows.reduce((sum, r) => sum + r.amount, 0n);

  const extras = [...value.extras,
    { kind: "link" as const, pluginId: ctx.pluginId, label: "Place bounty", to: `/plugins/bounties.index?target=${value.targetId}` }];
  if (total > 0n) {
    extras.unshift({ kind: "stat" as const, pluginId: ctx.pluginId, label: "Open bounty", value: `$${total.toString()}` });
  }
  return { ...value, extras };
});

export default definePlugin({
  id: "bounties",
  version: "1.0.0",
  basePaths: ["/api/bounties"],
  // Real import dependencies (see this package's package.json) —
  // enforced against the final boot set by plugins/validate.ts.
  requires: ["combat"],
  pages: [{
    id: "bounties.index",
    path: "/bounties",
    menu: { label: "Bounties", order: 14, category: "crimes" },
    // Stub view: the client renders a hand-written override (apps/web
    // PAGE_OVERRIDES) for this id; the schema view exists because a
    // page declaration requires one.
    view: { kind: "list", items: [] },
  }],
  migrations: BOUNTIES_MIGRATIONS,
  routes: [placeRoute, listRoute],
  filters: [claimOnKill, profileExtras],
});
