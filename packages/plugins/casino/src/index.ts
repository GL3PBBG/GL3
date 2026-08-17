import { randomBytes } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { definePlugin, InsufficientFundsError, PluginError, route, type PluginCtx } from "@gl3/plugin-sdk";
import { payOwner } from "@gl3/plugin-properties";
import { assertHouseCanCover, escrow, resolveHouse, settleSession, type House } from "./engine.js";
import { buildRegistry, games } from "./games.js";
import { CASINO_MIGRATIONS } from "./migrations.js";
import { adminPage } from "./pages.js";
import { casinoSessions, locations, players, playerStats } from "./schema.js";
import { readExpiryMinutes, readMaxBet, readMinBet } from "./settings.js";
import { fromStorableState, toStorableState } from "./state.js";

export { casinoSessions } from "./schema.js";
export { games, buildRegistry, type GameDef, type GameStep } from "./games.js";
// Re-exported so a test can assert against the same page object rather than a
// hand-copied duplicate of its view tree — the properties convention.
export { adminPage } from "./pages.js";

/** When a hand opened at `createdAt` stops being resumable. Shared by the
 *  lobby (which hides an expired hand) and `play` (which forfeits it). */
function expiresAt(createdAt: Date, expiryMinutes: number): Date {
  return new Date(createdAt.getTime() + expiryMinutes * 60_000);
}

// ---------------------------------------------------------------------------
// GET /api/casino — the lobby.
// ---------------------------------------------------------------------------

/**
 * Every installed game with, for the town the player is standing in, its house
 * owner and its maximum bet; plus the player's own open hand if they have one.
 *
 * Read-only and lock-free: `resolveHouse` reads through `ownerAt`, which is
 * unlocked by design, and nothing here moves money or writes a row. That is
 * also why the lazy forfeit is NOT here — it settles a session and so belongs
 * in a route that already holds the locks that write takes (`play`).
 */
const lobbyRoute = route({
  method: "GET",
  path: "/api/casino",
  // Same gates as `play` and `act` (spec §4.2): the lobby is the table's front
  // door, so a cell closes it and a hospital bed does not.
  accessInJail: false,
  accessInHospital: true,
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    // Request-time and per-request, exactly as `play`/`act` build it — there is
    // deliberately no module-level cache (Task 6: a process-level registry
    // outlives a test's plugin set).
    const registry = await buildRegistry(ctx, ctx.installedPluginIds);
    const fallbackMaxBet = readMaxBet(ctx.settings);
    const expiryMinutes = readExpiryMinutes(ctx.settings);

    return ctx.transaction(async (tx) => {
      const [stats] = await tx.db
        .select({ locationId: playerStats.locationId })
        .from(playerStats)
        .where(eq(playerStats.playerId, player.id));
      const locationId = stats?.locationId ?? null;
      // The same answer `play` gives a player who is nowhere, and the shape
      // `GET /api/shop` already uses.
      if (locationId === null) throw new PluginError("no_location", 409);

      const [location] = await tx.db
        .select({ name: locations.name })
        .from(locations)
        .where(eq(locations.id, locationId));

      const houses = new Map<string, House>();
      for (const [gameId] of registry) {
        houses.set(gameId, await resolveHouse(tx, gameId, locationId, fallbackMaxBet));
      }

      // One query for every house owner in town rather than one per game: the
      // registry is small today, but a lobby is the one route whose cost grows
      // with the number of installed games.
      const ownerIds = [...houses.values()]
        .map((house) => house.ownerId)
        .filter((id): id is string => id !== null);
      const ownerNames = new Map<string, string>();
      if (ownerIds.length > 0) {
        const rows = await tx.db
          .select({ id: players.id, username: players.username })
          .from(players)
          .where(inArray(players.id, ownerIds));
        for (const row of rows) ownerNames.set(row.id, row.username);
      }

      const gameRows = [...registry.values()].map((game) => {
        const house = houses.get(game.id);
        const ownerId = house?.ownerId ?? null;
        return {
          gameId: game.id,
          name: game.name,
          // null, not "", so the page decides how to draw an unowned table —
          // the town is then a sink and a faucet bounded by `max_bet`.
          ownerName: ownerId === null ? null : (ownerNames.get(ownerId) ?? null),
          // Money crosses the wire as a decimal string, never a JSON number.
          maxBet: (house?.maxBet ?? fallbackMaxBet).toString(),
        };
      });

      const [open] = await tx.db
        .select({
          id: casinoSessions.id,
          gameId: casinoSessions.gameId,
          wager: casinoSessions.wager,
          state: casinoSessions.state,
          createdAt: casinoSessions.createdAt,
        })
        .from(casinoSessions)
        .where(and(eq(casinoSessions.playerId, player.id), eq(casinoSessions.status, "open")));

      // An EXPIRED hand is reported as no hand at all: the spec's Resume is for
      // an unexpired session (§4.4), and this one is not resumable — the next
      // `play` forfeits it and opens a new one. Reporting it would offer a
      // Resume that `act` answers 409 to.
      const live = open !== undefined && expiresAt(open.createdAt, expiryMinutes) > new Date()
        ? open
        : null;
      const liveGame = live === null ? undefined : registry.get(live.gameId);

      return {
        status: 200,
        body: {
          locationId,
          locationName: location?.name ?? "",
          minBet: readMinBet(ctx.settings).toString(),
          games: gameRows,
          session: live === null ? null : {
            sessionId: live.id,
            gameId: live.gameId,
            gameName: liveGame?.name ?? live.gameId,
            wager: live.wager.toString(),
            // `null` when the game is no longer installed, or installed but
            // declares no `view` — the hand is still resumable through `act`,
            // it just cannot be drawn.
            view: liveGame?.view?.(fromStorableState(live.state)) ?? null,
            expiresAt: expiresAt(live.createdAt, expiryMinutes).toISOString(),
          },
        },
      };
    });
  },
});

// ---------------------------------------------------------------------------
// POST /api/casino/play — escrow, house resolution, exposure check.
// ---------------------------------------------------------------------------

/** A bigint-safe amount on the wire: digits only, never a JSON number
 *  (money is decimal-string, rule: zod every external boundary). */
const NonNegativeIntegerString = z.string().regex(/^\d+$/, "nonnegative integer string");

/** The house a forfeit settles against: none. See the call site — a forfeit
 *  pays nothing, and `settleSession` reaches `payOwner` only for a payout. */
const NO_HOUSE: House = { propertyId: null, ownerId: null, maxBet: 0n };

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

    const expiryMinutes = readExpiryMinutes(ctx.settings);

    return ctx.transaction(async (tx) => {
      // One open hand per player across all games (the partial unique index).
      // Unlocked pre-read, so a live hand is refused before this route takes a
      // single lock; the authoritative check is the FOR UPDATE re-read below,
      // under the player lock, which is also where a STALE hand is forfeited.
      const [openSession] = await tx.db
        .select({ id: casinoSessions.id, createdAt: casinoSessions.createdAt })
        .from(casinoSessions)
        .where(and(eq(casinoSessions.playerId, player.id), eq(casinoSessions.status, "open")));
      if (openSession !== undefined && expiresAt(openSession.createdAt, expiryMinutes) > new Date()) {
        throw new PluginError("session_open", 409);
      }

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

      // THE LAZY FORFEIT (spec §4.4), and the authoritative one-open-hand
      // check. Third and last step of the lock order: the session row FOR
      // UPDATE, after the location and both players. It cannot move earlier —
      // the pre-read above takes no lock, and writing there would put a
      // session-row lock in front of `tx.locks.location`, inverting the order
      // `casino-lock-order.test.ts` pins.
      //
      // Re-read rather than trusting the pre-read: this transaction now holds
      // the player lock, and READ COMMITTED gives each statement a fresh
      // snapshot, so a concurrent `play` by the same player that committed
      // while this one queued is visible here. That is what turns the old race
      // — two plays both seeing no open hand, the second dying on the partial
      // unique index with a 500 — into a clean 409.
      const [live] = await tx.db
        .select({ id: casinoSessions.id, gameId: casinoSessions.gameId, createdAt: casinoSessions.createdAt })
        .from(casinoSessions)
        .where(and(eq(casinoSessions.playerId, player.id), eq(casinoSessions.status, "open")))
        .for("update");
      if (live !== undefined) {
        if (expiresAt(live.createdAt, expiryMinutes) > new Date()) {
          throw new PluginError("session_open", 409);
        }
        // Forfeit: payout 0n, so `settleSession` moves NO money and only
        // stamps `status`/`settled_at`. The wager left the player at the `play`
        // that opened this hand and is already the house's — a forfeit is the
        // house keeping what it was paid, not a new transfer.
        //
        // NO_HOUSE, not the hand's own house: with payout 0n `settleSession`
        // never reaches `payOwner`, and resolving the STALE session's house
        // would mean a second `tx.locks.location` on a possibly different town,
        // unsorted against the one already held — an ABBA pair with any play in
        // the reverse town order.
        await settleSession(tx, live.id, player.id, live.gameId, NO_HOUSE, 0n);
      }

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
            // Return value DISCARDED — see `escrow`/`settleSession` in
            // `engine.ts` for why (a house seized mid-hand answers 0n).
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

// ---------------------------------------------------------------------------
// Admin routes — both read-only. `pages.ts` says why there is no form.
// ---------------------------------------------------------------------------

/**
 * One row per setting: the value the RUNNING PROCESS is using, and where it
 * came from. `source` is not decoration — the readers in `settings.ts` fall
 * back on a malformed value as well as on a missing one, so a row that says
 * `10.00` silently does nothing, and "ignored" is the only place an admin
 * could ever see that.
 */
function settingRow(
  ctx: PluginCtx, key: string, label: string, effective: string,
): { key: string; label: string; value: string; source: string } {
  const raw = ctx.settings.get(key);
  const source = raw === null ? "default" : raw === effective ? "configured" : `ignored (${raw})`;
  return { key, label, value: effective, source };
}

const adminSettingsRoute = route({
  method: "GET",
  path: "/api/admin/casino/settings",
  auth: "admin",
  handler: async (ctx) => {
    return {
      status: 200,
      body: {
        rows: [
          settingRow(ctx, "min_bet", "Minimum bet", readMinBet(ctx.settings).toString()),
          settingRow(ctx, "max_bet", "Maximum bet (no house lever)", readMaxBet(ctx.settings).toString()),
          settingRow(ctx, "session_expiry_minutes", "Hand expiry (minutes)", String(readExpiryMinutes(ctx.settings))),
        ],
      },
    };
  },
});

/**
 * Every hand currently open, newest first. Read-only: nothing here settles or
 * cancels one — an abandoned hand is forfeited by its own player's next `play`
 * (spec §4.4), which is the only path that holds the locks that write needs.
 * `stale` is that forfeit already earned, shown before it is collected.
 */
const adminSessionsRoute = route({
  method: "GET",
  path: "/api/admin/casino",
  auth: "admin",
  handler: async (ctx) => {
    const registry = await buildRegistry(ctx, ctx.installedPluginIds);
    const cutoff = new Date(Date.now() - readExpiryMinutes(ctx.settings) * 60_000);

    return ctx.transaction(async (tx) => {
      const rows = await tx.db
        .select({
          gameId: casinoSessions.gameId,
          wager: casinoSessions.wager,
          createdAt: casinoSessions.createdAt,
          playerName: players.username,
          locationName: locations.name,
        })
        .from(casinoSessions)
        .leftJoin(players, eq(players.id, casinoSessions.playerId))
        .leftJoin(locations, eq(locations.id, casinoSessions.locationId))
        .where(eq(casinoSessions.status, "open"))
        .orderBy(desc(casinoSessions.createdAt))
        // A cap rather than a pager: open hands are bounded by one per player
        // and expire, so a page of them is a diagnostic, not a ledger.
        .limit(100);

      return {
        status: 200,
        body: {
          rows: rows.map((row) => ({
            // The display name when the game is installed, its raw id when it
            // is not — properties' `decl?.name ?? row.pluginId` idiom.
            game: registry.get(row.gameId)?.name ?? row.gameId,
            player: row.playerName ?? "",
            town: row.locationName ?? "",
            wager: row.wager.toString(),
            openedAt: row.createdAt.toISOString(),
            stale: row.createdAt < cutoff ? "yes" : "no",
          })),
        },
      };
    });
  },
});

export default definePlugin({
  id: "casino",
  version: "1.0.0",
  basePaths: ["/api/casino", "/api/admin/casino"],
  migrations: CASINO_MIGRATIONS,
  tables: { sessions: "p_casino_sessions" },
  routes: [lobbyRoute, playRoute, actRoute, adminSettingsRoute, adminSessionsRoute],
  adminPages: [adminPage],
  // Documentation parity with combat's `provides: [killResolved]`: nothing
  // reads `PluginManifest.provides` today, but this is the point a game
  // subscribes to via `on(games, ...)`.
  provides: [games],
});
