import { randomBytes } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { definePlugin, InsufficientFundsError, PluginError, route } from "@gl3/plugin-sdk";
import { payOwner } from "@gl3/plugin-properties";
import { assertHouseCanCover, escrow, resolveHouse, settleSession } from "./engine.js";
import { buildRegistry, games } from "./games.js";
import { CASINO_MIGRATIONS } from "./migrations.js";
import { casinoSessions, playerStats } from "./schema.js";
import { readMaxBet, readMinBet } from "./settings.js";
import { fromStorableState, toStorableState } from "./state.js";

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

// ---------------------------------------------------------------------------
// POST /api/casino/act — wagerDelta, settle, payout.
// ---------------------------------------------------------------------------

const ActBodySchema = z.object({
  // The envelope only; the game's own `action` schema (`GameDef.action`)
  // validates the payload once the session tells us which game it is — the
  // hub cannot know the shape up front (spec §4.2).
  action: z.unknown(),
}).strict();

const actRoute = route({
  method: "POST",
  path: "/api/casino/act",
  accessInJail: false,
  accessInHospital: true,
  body: ActBodySchema,
  handler: async (ctx, { body }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    // Request-time, same reasoning as `play` — no DB access, costs nothing
    // before the transaction opens.
    const registry = await buildRegistry(ctx, ctx.installedPluginIds);

    return ctx.transaction(async (tx) => {
      // Unlocked pre-read, `resolveHouse`'s idiom: learn which row and which
      // town before taking any lock, so the lock order below never depends on
      // data read under a lock. The CALLER's own most recent session,
      // regardless of status — this is what makes "another player's session"
      // and "no session at all" the same 404, and lets a settled session's
      // row still be found (so it can answer 409 rather than 404).
      const [pre] = await tx.db
        .select({
          id: casinoSessions.id,
          gameId: casinoSessions.gameId,
          locationId: casinoSessions.locationId,
        })
        .from(casinoSessions)
        .where(eq(casinoSessions.playerId, player.id))
        .orderBy(desc(casinoSessions.createdAt))
        .limit(1);
      if (pre === undefined) throw new PluginError("no_session", 404);

      const game = registry.get(pre.gameId);
      if (game === undefined) throw new PluginError("no_such_game", 404);

      // RULE 6: location, then BOTH players in ONE call, then the session row
      // FOR UPDATE — identical order to `play`.
      await tx.locks.location(pre.locationId);

      const house = await resolveHouse(tx, pre.gameId, pre.locationId, readMaxBet(ctx.settings));

      await tx.locks.player(
        house.ownerId === null || house.ownerId === player.id
          ? [player.id]
          : [player.id, house.ownerId],
      );

      const [session] = await tx.db
        .select()
        .from(casinoSessions)
        .where(eq(casinoSessions.id, pre.id))
        .for("update");
      if (session === undefined) throw new PluginError("no_session", 404);
      if (session.status !== "open") throw new PluginError("session_closed", 409);

      const action = game.action.parse(body.action);
      const state = fromStorableState(session.state);
      const step = game.act(state, action);

      let wager = session.wager;
      if (step.wagerDelta !== undefined && step.wagerDelta !== 0n) {
        const newWager = wager + step.wagerDelta;

        let ownerCash: bigint | null = null;
        if (house.ownerId !== null) {
          const [ownerStats] = await tx.db
            .select({ cash: playerStats.cash })
            .from(playerStats)
            .where(eq(playerStats.playerId, house.ownerId));
          ownerCash = ownerStats?.cash ?? 0n;
        }
        // Re-run BEFORE taking the extra money — a raised wager raises the
        // house's exposure, and `payOwner`'s clamp would otherwise silently
        // short-pay a winner (engine.ts's doc comment). Throwing here rolls
        // the whole transaction back: the session stays open and unchanged.
        assertHouseCanCover(newWager, game.maxPayoutMultiplier, ownerCash);

        try {
          await escrow(tx, house, player.id, step.wagerDelta, pre.gameId);
        } catch (error) {
          if (error instanceof InsufficientFundsError) throw new PluginError("insufficient_funds", 409);
          throw error;
        }
        wager = newWager;
      }

      await tx.db.update(casinoSessions)
        .set({ state: toStorableState(step.state), wager })
        .where(eq(casinoSessions.id, pre.id));

      if (step.done) {
        const payout = game.settle(step.state, wager);
        await settleSession(tx, pre.id, player.id, pre.gameId, house, payout);
        return {
          status: 200,
          body: { sessionId: pre.id, view: step.view, done: true, payout: payout.toString() },
        };
      }

      return { status: 200, body: { sessionId: pre.id, view: step.view, done: false } };
    });
  },
});

export default definePlugin({
  id: "casino",
  version: "1.0.0",
  basePaths: ["/api/casino"],
  migrations: CASINO_MIGRATIONS,
  tables: { sessions: "p_casino_sessions" },
  routes: [playRoute, actRoute],
  // Documentation parity with combat's `provides: [killResolved]`: nothing
  // reads `PluginManifest.provides` today, but this is the point a game
  // subscribes to via `on(games, ...)`.
  provides: [games],
});
