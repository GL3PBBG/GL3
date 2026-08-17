import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { definePlugin, InsufficientFundsError, PluginError, route } from "@gl3/plugin-sdk";
import { payOwner } from "@gl3/plugin-properties";
import { assertHouseCanCover, escrow, resolveHouse } from "./engine.js";
import { buildRegistry, games } from "./games.js";
import { CASINO_MIGRATIONS } from "./migrations.js";
import { casinoSessions, playerStats } from "./schema.js";
import { readMaxBet, readMinBet } from "./settings.js";
import { toStorableState } from "./state.js";

export { casinoSessions } from "./schema.js";
export { games, buildRegistry, type GameDef, type GameStep } from "./games.js";

// ---------------------------------------------------------------------------
// POST /api/casino/play — escrow, house resolution, exposure check.
// ---------------------------------------------------------------------------

/** A bigint-safe amount on the wire: digits only, never a JSON number
 *  (money is decimal-string, rule: zod every external boundary). */
const NonNegativeIntegerString = z.string().regex(/^\d+$/, "nonnegative integer string");

const PlayBodySchema = z.object({
  gameId: z.string().min(1).max(80),
  wager: NonNegativeIntegerString,
}).strict();

const playRoute = route({
  method: "POST",
  path: "/api/casino/play",
  // An action, so it gates on jail. A hospital bed does not stop you
  // gambling; a cell does (spec §4.2).
  accessInJail: false,
  accessInHospital: true,
  body: PlayBodySchema,
  handler: async (ctx, { body }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    const wager = BigInt(body.wager);

    // Request-time, not boot-time: a GameDef arrives inside a filter
    // subscription rather than a manifest field, so `definePlugin` cannot
    // check it the way it checks `providesProperties` (spec §3's validation
    // gap, risk 2). No DB access here, so it costs nothing to do before the
    // transaction opens.
    const registry = await buildRegistry(ctx, ctx.installedPluginIds);
    const game = registry.get(body.gameId);
    if (game === undefined) throw new PluginError("no_such_game", 404);

    return ctx.transaction(async (tx) => {
      // One open hand per player across all games (the partial unique index).
      // Checked with a plain read; the index is the backstop against a race
      // this read cannot see (Task 8 proves the concurrency case).
      const [openSession] = await tx.db
        .select({ id: casinoSessions.id })
        .from(casinoSessions)
        .where(and(eq(casinoSessions.playerId, player.id), eq(casinoSessions.status, "open")));
      if (openSession !== undefined) throw new PluginError("session_open", 409);

      // The town is where the player IS, never a body parameter.
      const [statsPre] = await tx.db
        .select({ locationId: playerStats.locationId })
        .from(playerStats)
        .where(eq(playerStats.playerId, player.id));
      const locationId = statsPre?.locationId;
      if (locationId === null || locationId === undefined) throw new PluginError("no_location", 409);

      // RULE 6: location first, then BOTH players in ONE call below. Locking
      // the player first and letting payOwner take the owner second is an
      // ABBA cycle — properties/src/api.ts:51-58 documents the hazard, and
      // properties-consumer-lock-order.test.ts is the proof this shape closes
      // it. `resolveHouse` reads unlocked; `payOwner` re-reads the row
      // FOR UPDATE itself, so a transfer racing this read cannot pay the
      // wrong player.
      await tx.locks.location(locationId);

      const house = await resolveHouse(tx, body.gameId, locationId, readMaxBet(ctx.settings));

      const minBet = readMinBet(ctx.settings);
      if (wager < minBet) throw new PluginError("wager_below_min", 400);
      if (wager > house.maxBet) throw new PluginError("wager_above_max", 400);

      // ONE sorted, deduped call for both players — what makes owner-plays-
      // at-own-table safe against a second player at the same table.
      await tx.locks.player(
        house.ownerId === null || house.ownerId === player.id
          ? [player.id]
          : [player.id, house.ownerId],
      );

      let ownerCash: bigint | null = null;
      if (house.ownerId !== null) {
        const [ownerStats] = await tx.db
          .select({ cash: playerStats.cash })
          .from(playerStats)
          .where(eq(playerStats.playerId, house.ownerId));
        ownerCash = ownerStats?.cash ?? 0n;
      }
      // Without this, `payOwner`'s clamp would silently short-pay a winner
      // whose payout exceeds what the house holds (engine.ts's doc comment).
      assertHouseCanCover(wager, game.maxPayoutMultiplier, ownerCash);

      try {
        await escrow(tx, house, player.id, wager, body.gameId);
      } catch (error) {
        if (error instanceof InsufficientFundsError) throw new PluginError("insufficient_funds", 409);
        throw error;
      }

      // The seed comes from node:crypto, never Math.random (SPEC §7).
      const seed = randomBytes(16).toString("hex");
      const step = game.start({ wager, seed });
      const sessionId = uuidv7();

      if (step.done) {
        // A one-shot game (or blackjack dealing a natural) settles inside
        // `play` and never opens a session — this row is written straight to
        // `settled`. V2 blackjack.inc.php:406 is the payout debit.
        const payout = game.settle(step.state, wager);
        if (payout > 0n) {
          if (house.propertyId !== null) {
            await payOwner(tx, house.propertyId, -payout, `casino.${body.gameId}.payout`);
          }
          await tx.economy.applyBalanceChange({
            playerId: player.id, amount: payout, kind: "cash", reason: `casino.${body.gameId}.payout`,
          });
        }
        await tx.db.insert(casinoSessions).values({
          id: sessionId,
          playerId: player.id,
          gameId: body.gameId,
          locationId,
          propertyId: house.propertyId,
          wager,
          state: toStorableState(step.state),
          status: "settled",
          seed,
          settledAt: new Date(),
        });
        return {
          status: 200,
          body: { sessionId, view: step.view, done: true, payout: payout.toString() },
        };
      }

      await tx.db.insert(casinoSessions).values({
        id: sessionId,
        playerId: player.id,
        gameId: body.gameId,
        locationId,
        propertyId: house.propertyId,
        wager,
        state: toStorableState(step.state),
        status: "open",
        seed,
      });
      return { status: 200, body: { sessionId, view: step.view, done: false } };
    });
  },
});

export default definePlugin({
  id: "casino",
  version: "1.0.0",
  basePaths: ["/api/casino"],
  migrations: CASINO_MIGRATIONS,
  tables: { sessions: "p_casino_sessions" },
  routes: [playRoute],
  // Documentation parity with combat's `provides: [killResolved]`: nothing
  // reads `PluginManifest.provides` today, but this is the point a game
  // subscribes to via `on(games, ...)`.
  provides: [games],
});
