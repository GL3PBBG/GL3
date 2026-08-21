import { randomBytes } from "node:crypto";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import {
  definePlugin, InsufficientFundsError, PluginError, route,
  type PluginCtx, type PluginTx, type ViewNode,
} from "@gl3/plugin-sdk";
import {
  assertHouseCanCover, escrow, frozenHouse, guardGame, notifyTakeover, NonNegativeIntegerString,
  parseAction, readOwnerCash, resolveHouse, resolvePayout, settleSession,
  type House,
} from "./engine.js";
import {
  buildRegistry,
  buildTableRegistry,
  games,
  tableGames,
  type GameDef,
  type TableGameDef,
} from "./games.js";
import { CASINO_MIGRATIONS } from "./migrations.js";
import { adminPage } from "./pages.js";
import { casinoSeats, casinoSessions, casinoTables, locations, players, playerStats } from "./schema.js";
import {
  readExpiryMinutes, readMaxBet, readMinBet, readTableBetSeconds, readTableTurnSeconds,
  readTableIdleKickHands, readTableMaxSeats,
} from "./settings.js";
import { fromStorableState, toStorableState } from "./state.js";
import { tableTickEvent } from "./table-engine.js";
import { tableRoutes } from "./table-routes.js";

export { casinoSeats, casinoSessions, casinoTables } from "./schema.js";
// Lives in `engine.ts` (with `notifyTakeover`, its only caller besides the
// table path) and is re-exported here so the plugin's public surface is
// unchanged by that move.
export { HOUSE_SEIZED_MESSAGE } from "./engine.js";
// `publishTableTick` is deliberately NOT exported. It reads `ctx.player` for
// the actor and publishes under the CALLING plugin's ctx, so another plugin
// invoking it would stamp its own id on a `casino.table` event — the same
// mislabelling trap `properties`' seizure subscriber documents for
// `tx.events.publish` inside a filter chain. The declaration is exported
// (it is inert data a test can assert against); the publisher stays internal.
export { lockTable, tableTickEvent } from "./table-engine.js";
export {
  games,
  buildRegistry,
  tableGames,
  buildTableRegistry,
  type GameDef,
  type GameStep,
  type TableGameDef,
  type TableStep,
  type TableSeatInput,
} from "./games.js";
// The readers are exported for the same reason `@gl3/plugin-theft` exports
// `readTheftSettings`: they are pure, and their contract (defaults, the digits
// guard, the expiry ceiling) is worth pinning in a DB-free unit test.
export {
  MAX_SESSION_EXPIRY_MINUTES, MAX_TABLE_SEATS, readExpiryMinutes, readMaxBet, readMinBet,
  readTableBetSeconds, readTableIdleKickHands, readTableMaxSeats, readTableTurnSeconds,
} from "./settings.js";
// Re-exported so a test can assert against the same page object rather than a
// hand-copied duplicate of its view tree — the properties convention.
export { adminPage } from "./pages.js";

/** When a hand opened at `createdAt` stops being resumable. Shared by the
 *  lobby (which hides an expired hand), `play` (which forfeits it) and `act`
 *  (which refuses it). */
function expiresAt(createdAt: Date, expiryMinutes: number): Date {
  return new Date(createdAt.getTime() + expiryMinutes * 60_000);
}

/**
 * Step two of the lock order, identical in `play` and `act` (spec §5): BOTH
 * players in ONE sorted, deduped call, after `tx.locks.location` and before
 * the session row.
 *
 * One function rather than the same three lines twice, because this is the
 * line that makes owner-plays-at-own-table safe against a second player at
 * the same table — locking the player alone and letting `payOwner` take the
 * owner in its own later statement is the ABBA cycle
 * `properties/src/api.ts:51-58` documents and
 * `properties-consumer-lock-order.test.ts` proves.
 */
async function lockBothPlayers(tx: PluginTx, playerId: string, ownerId: string | null): Promise<void> {
  await tx.locks.player(ownerId === null || ownerId === playerId ? [playerId] : [playerId, ownerId]);
}

/**
 * The lobby's resume view, or `null`.
 *
 * `null` for a game that declares no `view` (spec §3: it resumes viewless
 * rather than failing to install) AND for one whose `view` throws — a hand
 * that cannot draw itself must not take down the lobby's whole response,
 * including every other game's row and the player's own town. This is the one
 * of the four game handlers that degrades instead of refusing, because it is
 * the only one called for a hand the caller did not just act on.
 */
function safeView(game: GameDef, state: unknown): ViewNode | null {
  if (game.view === undefined) return null;
  try {
    return game.view(state);
  } catch {
    return null;
  }
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
    // outlives a test's plugin set). The TABLE registry (Task 12) is built the
    // same way, alongside the solo one.
    const registry = await buildRegistry(ctx, ctx.installedPluginIds);
    const tableRegistry = await buildTableRegistry(ctx, ctx.installedPluginIds);
    const fallbackMaxBet = readMaxBet(ctx.settings);
    const expiryMinutes = readExpiryMinutes(ctx.settings);
    const maxSeats = readTableMaxSeats(ctx.settings);

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

      // SEQUENTIAL ON PURPOSE — do not "fix" this into `Promise.all`. Every
      // query here runs on the ONE connection this `ctx.transaction` holds, so
      // firing them concurrently would interleave statements on a single
      // session rather than parallelise anything.
      const houses = new Map<string, House>();
      for (const [gameId] of registry) {
        houses.set(gameId, await resolveHouse(tx, gameId, locationId, fallbackMaxBet));
      }
      // The TABLE registry's houses, same idiom — one `resolveHouse` per
      // registered table game, sequential on the same connection.
      const tableHouses = new Map<string, House>();
      for (const [gameId] of tableRegistry) {
        tableHouses.set(gameId, await resolveHouse(tx, gameId, locationId, fallbackMaxBet));
      }

      // One query for every house owner in town rather than one per game: the
      // registry is small today, but a lobby is the one route whose cost grows
      // with the number of installed games. Covers BOTH registries' houses —
      // a solo game and a table game can be owned by different players in the
      // same town, and this is the one place either owner's name is looked up.
      const ownerIds = [...houses.values(), ...tableHouses.values()]
        .map((house) => house.ownerId)
        .filter((id): id is string => id !== null);
      const ownerNames = new Map<string, string>();
      if (ownerIds.length > 0) {
        const rows = await tx.db
          .select({ id: players.id, username: players.username })
          .from(players)
          .where(inArray(players.id, [...new Set(ownerIds)]));
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

      // LOCAL tables: every live table in the caller's town, with its seat
      // count. One grouped query rather than one per game — the `remote`
      // query below is the same shape for every OTHER town.
      const localTableRows = await tx.db
        .select({
          tableId: casinoTables.id,
          gameId: casinoTables.gameId,
          phase: casinoTables.phase,
          seatsFilled: sql<number>`count(${casinoSeats.id})::int`,
        })
        .from(casinoTables)
        .leftJoin(casinoSeats, eq(casinoSeats.tableId, casinoTables.id))
        .where(eq(casinoTables.locationId, locationId))
        .groupBy(casinoTables.id, casinoTables.gameId, casinoTables.phase);

      const tablesByGame = new Map<string, { tableId: string; seatsFilled: number; maxSeats: number; phase: string }[]>();
      for (const row of localTableRows) {
        const list = tablesByGame.get(row.gameId) ?? [];
        list.push({ tableId: row.tableId, seatsFilled: row.seatsFilled, maxSeats, phase: row.phase });
        tablesByGame.set(row.gameId, list);
      }

      // EVERY registered table game, with-or-without a live table — a game
      // that has none still needs to be offered (`tables: []`, spec's "sit
      // opens a fresh table").
      const tableGameRows = [...tableRegistry.values()].map((game) => {
        const house = tableHouses.get(game.id);
        const ownerId = house?.ownerId ?? null;
        return {
          gameId: game.id,
          name: game.name,
          ownerName: ownerId === null ? null : (ownerNames.get(ownerId) ?? null),
          maxBet: (house?.maxBet ?? fallbackMaxBet).toString(),
          maxSeats,
          tables: tablesByGame.get(game.id) ?? [],
        };
      });

      // REMOTE: every OTHER town with at least one seated player at a
      // REGISTERED table game — counts only, never a username, so an
      // underground town's residents stay unidentifiable from here the same
      // way they already are everywhere else (combat, travel, `/api/online`).
      const remoteRows = await tx.db
        .select({
          locationId: casinoTables.locationId,
          locationName: locations.name,
          gameId: casinoTables.gameId,
          seated: sql<number>`count(*)::int`,
        })
        .from(casinoSeats)
        .innerJoin(casinoTables, eq(casinoTables.id, casinoSeats.tableId))
        .innerJoin(locations, eq(locations.id, casinoTables.locationId))
        .where(ne(casinoTables.locationId, locationId))
        .groupBy(casinoTables.locationId, locations.name, casinoTables.gameId);

      const remote = remoteRows
        .filter((row) => tableRegistry.has(row.gameId))
        .map((row) => ({
          locationId: row.locationId,
          locationName: row.locationName,
          gameId: row.gameId,
          gameName: tableRegistry.get(row.gameId)?.name ?? row.gameId,
          seated: row.seated,
        }));

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
      // `play` forfeits it and opens a new one, and `act` refuses it with 409
      // `session_expired`. Reporting it here would offer a Resume that leads
      // straight to that refusal.
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
          tableGames: tableGameRows,
          remote,
          session: live === null ? null : {
            sessionId: live.id,
            gameId: live.gameId,
            gameName: liveGame?.name ?? live.gameId,
            wager: live.wager.toString(),
            // `null` when the game is no longer installed, when it declares
            // no `view`, or when its `view` throws — the hand is still
            // resumable through `act`, it just cannot be drawn.
            view: liveGame === undefined ? null : safeView(liveGame, fromStorableState(live.state)),
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

      await lockBothPlayers(tx, player.id, house.ownerId);

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

      // Without this, `payOwner`'s clamp would silently short-pay a winner
      // whose payout exceeds what the house holds (engine.ts's doc comment).
      assertHouseCanCover(wager, game.maxPayoutMultiplier, await readOwnerCash(tx, house.ownerId));

      try {
        await escrow(tx, house, player.id, wager, body.gameId);
      } catch (error) {
        if (error instanceof InsufficientFundsError) throw new PluginError("insufficient_funds", 409);
        throw error;
      }

      // The seed comes from node:crypto, never Math.random (SPEC §7).
      const seed = randomBytes(16).toString("hex");
      const step = guardGame(body.gameId, "start", () => game.start({ wager, seed }));
      const sessionId = uuidv7();

      // ONE insert for both branches. A one-shot game (or blackjack dealing a
      // natural) settles inside `play` and never reaches the lobby, but its
      // row is written first and closed by `settleSession` rather than being
      // written straight to `settled` with the money moved by hand: that
      // hand-rolled copy of the payout leg was a second place the bounds in
      // `resolvePayout` would have had to be added, and the first place they
      // would have been forgotten. The intermediate `open` status lives
      // entirely inside this transaction.
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

      if (step.done) {
        // V2 blackjack.inc.php:406 is the payout debit.
        const payout = resolvePayout(game, step.state, wager);
        const seized = await settleSession(tx, sessionId, player.id, body.gameId, house, payout);
        if (seized) await notifyTakeover(tx, house, player, game.name);
        return {
          status: 200,
          body: {
            sessionId, view: step.view, done: true,
            wager: wager.toString(), payout: payout.toString(), houseSeized: seized,
          },
        };
      }

      // `wager` here is NOT the information gap `act`'s is — the caller sent
      // this figure and `play` never changes it. It is on both routes so that
      // the two share one response shape and the field can be REQUIRED rather
      // than optional: a stake the page reads from the response on every step
      // has no branch where it falls back to the string the player typed, and
      // an untestable fallback is worse than an echoed field. It is also
      // canonical where the request need not be — `BigInt("007").toString()`
      // is `"7"`.
      return {
        status: 200,
        body: { sessionId, view: step.view, done: false, wager: wager.toString() },
      };
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
          // The house this hand was dealt against, stamped at `play` and
          // never updated — spec §4.1 freezes it for the hand.
          propertyId: casinoSessions.propertyId,
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

      // The FROZEN house (spec §4.1/§4.3), not a fresh `resolveHouse`: this
      // hand's wager went to whoever owned the table when it was dealt, so a
      // table bought or dropped since must not take the payout. See
      // `frozenHouse` for what that does and does not guard.
      const house = await frozenHouse(tx, pre.propertyId, readMaxBet(ctx.settings));

      await lockBothPlayers(tx, player.id, house.ownerId);

      const [session] = await tx.db
        .select()
        .from(casinoSessions)
        .where(eq(casinoSessions.id, pre.id))
        .for("update");
      if (session === undefined) throw new PluginError("no_session", 404);
      if (session.status !== "open") throw new PluginError("session_closed", 409);
      // An EXPIRED hand is not playable. The lobby hides it and `play`
      // forfeits it; `act` used to carry on dealing to it indefinitely, so a
      // hand could be abandoned past its expiry and then resumed anyway. It is
      // NOT forfeited here — the forfeit belongs to `play`, which is where the
      // player's next hand replaces it, and settling one on a refused action
      // would take the wager inside the very call that refuses to act.
      if (expiresAt(session.createdAt, readExpiryMinutes(ctx.settings)) <= new Date()) {
        throw new PluginError("session_expired", 409);
      }

      // The game's OWN schema, and a failure here is the caller's fault, not
      // the server's: `body.action` is an unvalidated `z.unknown()` envelope
      // (the hub cannot know a game's action shape up front), so an
      // unparseable action reaching a raw `ZodError` answered 500 where the
      // repo's rule is a clean 400.
      const action = parseAction(game.action, body.action);
      const state = fromStorableState(session.state);
      const step = guardGame(pre.gameId, "act", () => game.act(state, action));

      let wager = session.wager;
      if (step.wagerDelta !== undefined && step.wagerDelta !== 0n) {
        // A NEGATIVE delta would turn `escrow` into a credit to the player and
        // drive the stored wager below zero — a game raising the stake by a
        // negative amount is misdeclared, not merely unlucky. 500, like the
        // other two `GameDef` bounds: nothing the caller sent is at fault.
        if (step.wagerDelta < 0n) throw new PluginError("invalid_wager_delta", 500);
        const newWager = wager + step.wagerDelta;

        // Re-run BEFORE taking the extra money — a raised wager raises the
        // house's exposure, and `payOwner`'s clamp would otherwise silently
        // short-pay a winner (engine.ts's doc comment). Throwing here rolls
        // the whole transaction back: the session stays open and unchanged.
        assertHouseCanCover(newWager, game.maxPayoutMultiplier, await readOwnerCash(tx, house.ownerId));

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
        const payout = resolvePayout(game, step.state, wager);
        const seized = await settleSession(tx, pre.id, player.id, pre.gameId, house, payout);
        if (seized) await notifyTakeover(tx, house, player, game.name);
        return {
          status: 200,
          body: {
            sessionId: pre.id, view: step.view, done: true,
            wager: wager.toString(), payout: payout.toString(), houseSeized: seized,
          },
        };
      }

      // `wager` on BOTH branches, and it is the local above rather than
      // `session.wager`: a `wagerDelta` (blackjack's double) has already
      // raised it, and this response is the ONLY place the caller can learn
      // the new figure — the session row goes away when the hand settles, and
      // a raise that settles in the same call never reaches the lobby at all.
      return {
        status: 200,
        body: { sessionId: pre.id, view: step.view, done: false, wager: wager.toString() },
      };
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
/**
 * Two digit strings compared BY VALUE, so `"010000"` matches `"10000"`.
 *
 * TOTAL — it answers false where `BigInt()` would throw, and that is the whole
 * point. `settings.value` is unbounded `text`, and an earlier version compared
 * `BigInt(raw) === BigInt(effective)` with only `raw` guarded: a 22-digit
 * expiry made `effective` `"1e+21"` (see `renderMinutes`) and `BigInt("1e+21")`
 * is a `SyntaxError`, so the admin page 500'd instead of rendering the row.
 * Both sides are guarded here, so an unreadable value degrades to `ignored`.
 */
function sameNumber(a: string, b: string): boolean {
  if (!/^\d+$/.test(a) || !/^\d+$/.test(b)) return false;
  return BigInt(a) === BigInt(b);
}

/**
 * SECOND line of defence, kept deliberately. `MAX_SESSION_EXPIRY_MINUTES` now
 * clamps the reader, so `effective` can no longer reach the 1e21 magnitude at
 * which `String` switches to exponential notation — but this function is what
 * made that case render instead of throwing, and a future ceiling change
 * should not silently re-open it. `BigInt` renders the digits in full and is
 * safe because a digits-only row can only produce an integer; the non-integer
 * tail (`Infinity`, now unreachable through the clamp) falls back to `String`,
 * fails `sameNumber`, and reads `ignored`.
 */
function renderMinutes(minutes: number): string {
  return Number.isInteger(minutes) ? BigInt(minutes).toString() : String(minutes);
}

function settingRow(
  ctx: PluginCtx, key: string, label: string, effective: string,
): { key: string; label: string; value: string; source: string } {
  const raw = ctx.settings.get(key);
  if (raw === null) return { key, label, value: effective, source: "default" };
  // NUMERIC comparison, not string. `effective` is canonical — the readers
  // return `BigInt(raw).toString()` / the `renderMinutes` above — while the
  // stored row need not be: `"010000"` passes `readBigint`'s digits test and IS
  // in force as 10000. Comparing the strings rendered `ignored (010000)`,
  // telling an admin their live value was being ignored. So `ignored` now
  // means the value really did fail to survive the reader — a malformed
  // `"10.00"`, a `session_expiry_minutes` of `"0"` that `readExpiryMinutes`
  // rejects for being non-positive, or a magnitude that came back as something
  // other than the digits that were typed.
  const inForce = sameNumber(raw, effective);
  return { key, label, value: effective, source: inForce ? "configured" : `ignored (${raw})` };
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
          settingRow(ctx, "session_expiry_minutes", "Hand expiry (minutes)", renderMinutes(readExpiryMinutes(ctx.settings))),
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
  tables: { sessions: "p_casino_sessions", tables: "p_casino_tables", seats: "p_casino_seats" },
  routes: [lobbyRoute, playRoute, actRoute, adminSettingsRoute, adminSessionsRoute, ...tableRoutes],
  // The hub's only event, and a SILENT one: a table tick is a state signal
  // for the seats at that table, never a line in anybody's feed. Solo
  // `play`/`act` publish nothing at all — a solo hand has exactly one
  // interested client and it is the one holding the response.
  events: [tableTickEvent],
  adminPages: [adminPage],
  // Documentation parity with combat's `provides: [killResolved]`: nothing
  // reads `PluginManifest.provides` today, but this is the point a game
  // subscribes to via `on(games, ...)` or `on(tableGames, ...)`.
  provides: [games, tableGames],
});
