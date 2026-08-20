import { randomBytes } from "node:crypto";
import { asc, eq, inArray } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import {
  isInsufficientFundsError, PluginError, route, type PluginCtx, type PluginTx,
} from "@gl3/plugin-sdk";
import {
  escrow, guardGame, NonNegativeIntegerString, parseAction, resolveHouse,
} from "./engine.js";
import { buildTableRegistry, type TableGameDef } from "./games.js";
import { casinoSeats, casinoTables, locations, players, playerStats } from "./schema.js";
import { fromStorableState } from "./state.js";
import {
  readMaxBet, readMinBet, readTableBetSeconds, readTableMaxSeats,
} from "./settings.js";
import {
  advanceTable, applyStep, assertTableCanCover, dealIfReady, lockTable, readTableUnlocked,
  type LockedTable, type SeatRow,
} from "./table-engine.js";

/** The caller's current town, `play`'s idiom: 409 when nowhere. */
async function locationOf(tx: PluginTx, playerId: string): Promise<string> {
  const [stats] = await tx.db.select({ locationId: playerStats.locationId })
    .from(playerStats).where(eq(playerStats.playerId, playerId));
  const locationId = stats?.locationId;
  if (locationId === null || locationId === undefined) throw new PluginError("no_location", 409);
  return locationId;
}

/** The caller's seat + its table, unlocked pre-read. */
async function seatOf(tx: PluginTx, playerId: string): Promise<{ seatId: string; tableId: string; locationId: string } | null> {
  const [row] = await tx.db
    .select({ seatId: casinoSeats.id, tableId: casinoSeats.tableId, locationId: casinoTables.locationId })
    .from(casinoSeats)
    .innerJoin(casinoTables, eq(casinoTables.id, casinoSeats.tableId))
    .where(eq(casinoSeats.playerId, playerId));
  return row ?? null;
}

const sitRoute = route({
  method: "POST",
  path: "/api/casino/table/sit",
  accessInJail: false,
  accessInHospital: true,
  body: z.object({ gameId: z.string().min(1).max(80) }).strict(),
  handler: async (ctx, { body }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    const registry = await buildTableRegistry(ctx, ctx.installedPluginIds);
    const game = registry.get(body.gameId);
    if (game === undefined) throw new PluginError("no_such_game", 404);
    const maxSeats = readTableMaxSeats(ctx.settings);

    return ctx.transaction(async (tx) => {
      // Unlocked pre-read for the clean refusal; the authoritative check is
      // the re-read below under the caller's own player lock (two sits by one
      // player serialize on that row — the solo one-open shape), and the
      // p_casino_seats_one_seat unique index is the backstop.
      if (await seatOf(tx, player.id) !== null) throw new PluginError("already_seated", 409);

      const locationId = await locationOf(tx, player.id);
      await tx.locks.location(locationId);

      // Candidate table BEFORE the player lock? No — lockTable needs the seat
      // set, which is stable only under the location lock we now hold, and the
      // player-lock step needs the owner. Find the table, then lock.
      const tables = await tx.db.select().from(casinoTables)
        .where(eq(casinoTables.locationId, locationId))
        .orderBy(asc(casinoTables.createdAt));
      let target: string | null = null;
      for (const t of tables) {
        if (t.gameId !== body.gameId) continue;
        const seats = await tx.db.select({ id: casinoSeats.id }).from(casinoSeats)
          .where(eq(casinoSeats.tableId, t.id));
        if (seats.length < maxSeats) { target = t.id; break; }
      }

      if (target === null) {
        // A fresh table. The house is frozen NOW (the play-time freeze's
        // sibling): resolveHouse reads unlocked, payOwner re-reads FOR UPDATE.
        const house = await resolveHouse(tx, body.gameId, locationId, readMaxBet(ctx.settings));
        await tx.locks.player(house.ownerId === null || house.ownerId === player.id
          ? [player.id] : [player.id, house.ownerId]);
        if (await seatOf(tx, player.id) !== null) throw new PluginError("already_seated", 409);
        const tableId = uuidv7();
        await tx.db.insert(casinoTables).values({
          id: tableId, gameId: body.gameId, locationId,
          propertyId: house.propertyId, seed: randomBytes(16).toString("hex"),
        });
        await tx.db.insert(casinoSeats).values({
          id: uuidv7(), tableId, playerId: player.id, seatNo: 0,
        });
        return { status: 200, body: { tableId, seat: 0 } };
      }

      const locked = await lockTable(tx, ctx, target, [player.id]);
      if (locked === null) throw new PluginError("no_such_table", 404);
      // THE CLOCK BEFORE THE SEAT ROW EXISTS. A lapsed betting deadline deals
      // to whoever bet and bumps the idle count of whoever did not, and a
      // newcomer who was not at the table when that deadline ran must not be
      // counted among them — today the sweep iterates the snapshot `lockTable`
      // took, so the INSERT would have to move above a re-read before it could
      // do that damage, but the ordering is what makes it true rather than
      // incidental. What it decides OUTRIGHT is the three lines below: the
      // sweep and the settle both free seats, so a table that reads full
      // before the clock runs can have a place at it after, and the seat
      // number handed out has to come from the post-advance seat set.
      const advanced = await advanceTable(tx, ctx, locked, game);
      // The hand it just settled emptied the table, which deleted the row.
      // 404 rather than silently opening a new table: `sit` picked THIS one,
      // and a retry lands on the fresh-table branch above.
      if (advanced === null) throw new PluginError("no_such_table", 404);
      if (await seatOf(tx, player.id) !== null) throw new PluginError("already_seated", 409);
      if (advanced.seats.length >= maxSeats) throw new PluginError("table_full", 409);
      const taken = new Set(advanced.seats.map((s) => s.seatNo));
      let seatNo = 0;
      while (taken.has(seatNo)) seatNo += 1;
      await tx.db.insert(casinoSeats).values({
        id: uuidv7(), tableId: target, playerId: player.id, seatNo,
      });
      return { status: 200, body: { tableId: target, seat: seatNo } };
    });
  },
});

/**
 * Frees a seat that holds no stake, and the table with it when it was the
 * last one. Both of `leave`'s non-deferred exits end here, so "an emptied
 * table is deleted" is stated once.
 */
async function freeSeat(
  tx: PluginTx, locked: LockedTable, mine: SeatRow,
): Promise<{ status: 200; body: { left: boolean; deferred: boolean } }> {
  await tx.db.delete(casinoSeats).where(eq(casinoSeats.id, mine.id));
  if (locked.seats.length === 1) {
    await tx.db.delete(casinoTables).where(eq(casinoTables.id, locked.table.id));
  }
  return { status: 200, body: { left: true, deferred: false } };
}

const leaveRoute = route({
  method: "POST",
  path: "/api/casino/table/leave",
  accessInJail: false,
  accessInHospital: true,
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    // Built where `bet` and `act` build it — outside the transaction, so no
    // filter chain ever runs while this request holds a lock (`properties`'
    // `leverSet` splits a route in two for that reason). It is CONSULTED only
    // on the in-hand path below.
    const registry = await buildTableRegistry(ctx, ctx.installedPluginIds);
    return ctx.transaction(async (tx) => {
      const seat = await seatOf(tx, player.id);
      if (seat === null) throw new PluginError("not_seated", 404);
      // The SEAT'S table's town, not the caller's — leave works from anywhere
      // (spec: travelling away is resolved by leaving, never by a
      // two-location transaction).
      await tx.locks.location(seat.locationId);
      const locked = await lockTable(tx, ctx, seat.tableId);
      if (locked === null) throw new PluginError("not_seated", 404);
      const mine = locked.seats.find((s) => s.playerId === player.id);
      if (mine === undefined) throw new PluginError("not_seated", 404);

      if (mine.wager === 0n) {
        // THE WAGER-0 FAST EXIT, and it is a safety property rather than an
        // optimisation. `leave` is the ONLY way out of a seat and
        // `p_casino_seats`' UNIQUE(player_id) is game-wide, so a leave that
        // cannot complete strands the player at every table in the game.
        // Consulting the game would make that outcome reachable three ways —
        // the plugin uninstalled (404 `no_such_game`), an `autoAct` that
        // throws (400 `game_error`), one that never advances the turn (500
        // `invalid_turn`) — and a seat with no stake needs none of it: it
        // holds no money, it is in no hand, and the only thing the clock could
        // ever do to it is idle-kick it, which deletes the row this branch is
        // about to delete anyway. So: no registry lookup, no `advanceTable`.
        return freeSeat(tx, locked, mine);
      }

      const game = registry.get(locked.table.gameId);
      if (game === undefined) throw new PluginError("no_such_game", 404);
      // The clock FIRST, so a leaver is deferred only by a hand that is
      // genuinely still live. A table everybody walked away from settles here
      // and frees the seat in this same request — without it, leaving a hand
      // whose deadlines all lapsed would set `leaving` and wait for a read
      // that may never come.
      const advanced = await advanceTable(tx, ctx, locked, game);
      // The settle emptied the table and deleted it, taking the seat with it:
      // the caller is, accurately, no longer seated anywhere.
      if (advanced === null) throw new PluginError("not_seated", 404);
      const post = advanced.seats.find((s) => s.playerId === player.id);
      if (post === undefined) throw new PluginError("not_seated", 404);

      if (post.wager > 0n) {
        // Still in hand — wager escrowed, whether the deal has fired (acting)
        // or is still pending (betting): the stake stays in play, spec §5's
        // "no money is ever dropped by leaving". Mark leaving; the deal
        // includes this seat, the turn clock auto-stands its turns, and the
        // settle pays it normally and frees the seat at hand end. The wager-0
        // test is the spec's in-hand definition — NEVER phase.
        await tx.db.update(casinoSeats).set({ leaving: true }).where(eq(casinoSeats.id, post.id));
        return { status: 200, body: { left: true, deferred: true } };
      }
      // The clock settled the hand on the way through, so the stake is paid
      // out and the seat frees NOW rather than at some later read.
      return freeSeat(tx, advanced, post);
    });
  },
});

/** The view payload GET, bet and act all answer with (Task 12's DTO). */
export async function renderTablePayload(
  tx: PluginTx, ctx: PluginCtx, locked: LockedTable, game: TableGameDef, viewerId: string,
): Promise<Record<string, unknown>> {
  const { table, seats, house } = locked;
  const [loc] = await tx.db.select({ name: locations.name })
    .from(locations).where(eq(locations.id, table.locationId));
  const ids = seats.map((s) => s.playerId);
  const names = new Map<string, string>();
  if (ids.length > 0) {
    const rows = await tx.db.select({ id: players.id, username: players.username })
      .from(players).where(inArray(players.id, ids));
    for (const row of rows) names.set(row.id, row.username);
  }
  const mine = seats.find((s) => s.playerId === viewerId);
  const viewerSeat = mine === undefined ? null : mine.seatNo;
  const inHand = mine !== undefined && mine.wager > 0n;
  return {
    tableId: table.id,
    gameId: table.gameId,
    gameName: game.name,
    locationId: table.locationId,
    locationName: loc?.name ?? "",
    phase: table.phase,
    handNo: table.handNo,
    deadlineAt: table.deadlineAt === null ? null : table.deadlineAt.toISOString(),
    turnSeat: table.turnSeat,
    mySeat: viewerSeat,
    minBet: readMinBet(ctx.settings).toString(),
    maxBet: house.maxBet.toString(),
    seats: seats.map((s) => ({
      seat: s.seatNo,
      username: names.get(s.playerId) ?? "",
      wager: s.wager.toString(),
      leaving: s.leaving,
      idleHands: s.idleHands,
    })),
    view: table.state === null
      ? null
      : guardGame(table.gameId, "view", () =>
          game.view(fromStorableState(table.state), inHand ? viewerSeat : null)),
  };
}

const readRoute = route({
  method: "GET",
  path: "/api/casino/table",
  accessInJail: false,
  accessInHospital: true,
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    const registry = await buildTableRegistry(ctx, ctx.installedPluginIds);
    return ctx.transaction(async (tx) => {
      const seat = await seatOf(tx, player.id);
      if (seat === null) return { status: 200, body: { table: null } };

      // THE FAST PATH. Every seated player polls this route every 2.5 seconds
      // (spec §8) and almost every one of those reads owes the table nothing,
      // so a table whose clock has not lapsed is rendered from plain SELECTs
      // with ZERO locks taken — no location lock, no player locks, no `FOR
      // UPDATE` on the table row. Making a poll queue behind the player who is
      // acting would be a self-inflicted lock convoy at exactly the moment the
      // table is busiest.
      //
      // The price, stated plainly: these are three SEPARATE statements under
      // READ COMMITTED, so they are not one consistent snapshot — a hand that
      // commits between them can be rendered with the new table row and the
      // old seat wagers. Nothing is decided from it (every write re-reads
      // under `lockTable`), it is a view a player looks at for 2.5 seconds,
      // and the next poll corrects it. A `REPEATABLE READ` transaction would
      // close the window at the cost of serialization failures on a route
      // that must never fail.
      const unlocked = await readTableUnlocked(tx, ctx, seat.tableId);
      if (unlocked === null) return { status: 200, body: { table: null } };
      const game = registry.get(unlocked.table.gameId);
      if (game === undefined) throw new PluginError("no_such_game", 404);
      const deadline = unlocked.table.deadlineAt;
      if (deadline === null || deadline.getTime() > Date.now()) {
        return {
          status: 200,
          body: { table: await renderTablePayload(tx, ctx, unlocked, game, player.id) },
        };
      }

      // THE SLOW PATH: this read owes the table a deal, an auto-stand or a
      // settle, so it takes the full lock order and pays it. The unlocked read
      // above is discarded — it is a snapshot of a table that is about to
      // move, and `advanceTable` returns the authoritative one.
      await tx.locks.location(seat.locationId);
      const locked = await lockTable(tx, ctx, seat.tableId);
      if (locked === null) return { status: 200, body: { table: null } };
      const advanced = await advanceTable(tx, ctx, locked, game);
      if (advanced === null) return { status: 200, body: { table: null } };
      return {
        status: 200,
        body: { table: await renderTablePayload(tx, ctx, advanced, game, player.id) },
      };
    });
  },
});

/**
 * What `bet` and `act` answer with: the table as it stands AFTER the write,
 * read back under the locks this transaction already holds.
 *
 * A fresh `lockTable` rather than the pre-write snapshot, because a settle can
 * delete the caller's `leaving` seat or the whole table — the same envelope
 * GET uses, so one client schema parses all three routes, and a table that is
 * gone answers `{ table: null }` rather than a snapshot of something that no
 * longer exists.
 */
async function renderAfter(
  tx: PluginTx, ctx: PluginCtx, tableId: string, game: TableGameDef, viewerId: string,
): Promise<{ status: 200; body: { table: Record<string, unknown> | null } }> {
  const after = await lockTable(tx, ctx, tableId);
  if (after === null) return { status: 200, body: { table: null } };
  return { status: 200, body: { table: await renderTablePayload(tx, ctx, after, game, viewerId) } };
}

/**
 * The caller's seat and its table, under the full lock order, with the phase
 * the route requires already checked. Shared by `bet` and `act` because the
 * two open identically — and because the `wrong_location` refusal has to
 * happen on the UNLOCKED pre-read (`play`'s idiom): a player who travelled
 * away must be refused before this transaction takes a single lock, and the
 * town it would lock is the table's, never theirs.
 */
async function lockedSeat(
  tx: PluginTx, ctx: PluginCtx, playerId: string, registry: Map<string, TableGameDef>,
  phase: "betting" | "acting",
): Promise<{ locked: LockedTable; game: TableGameDef; mine: SeatRow }> {
  const seat = await seatOf(tx, playerId);
  if (seat === null) throw new PluginError("not_seated", 404);
  if (await locationOf(tx, playerId) !== seat.locationId) {
    throw new PluginError("wrong_location", 409);
  }

  await tx.locks.location(seat.locationId);
  const locked = await lockTable(tx, ctx, seat.tableId);
  if (locked === null) throw new PluginError("not_seated", 404);
  const game = registry.get(locked.table.gameId);
  if (game === undefined) throw new PluginError("no_such_game", 404);
  // THE CLOCK, before a single check below reads the table. A deadline can
  // lapse while the request queues on the location lock, and everything the
  // two routes decide — phase, whose turn it is, whether the caller still has
  // a seat — has to be decided against the table the clock leaves behind.
  // The refusals it produces are the right ones: a bet arriving after the
  // betting deadline dealt without the caller gets `wrong_phase`, an act
  // arriving after the caller's turn was auto-stood gets `not_your_turn`, and
  // a swept-or-settled seat gets `not_seated`.
  const advanced = await advanceTable(tx, ctx, locked, game);
  if (advanced === null) throw new PluginError("not_seated", 404);
  const mine = advanced.seats.find((s) => s.playerId === playerId);
  if (mine === undefined) throw new PluginError("not_seated", 404);
  if (advanced.table.phase !== phase) throw new PluginError("wrong_phase", 409);
  return { locked: advanced, game, mine };
}

const betRoute = route({
  method: "POST",
  path: "/api/casino/table/bet",
  accessInJail: false,
  accessInHospital: true,
  body: z.object({ wager: NonNegativeIntegerString }).strict(),
  handler: async (ctx, { body }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    const wager = BigInt(body.wager);
    const registry = await buildTableRegistry(ctx, ctx.installedPluginIds);

    return ctx.transaction(async (tx) => {
      const { locked, game, mine } = await lockedSeat(tx, ctx, player.id, registry, "betting");
      // One stake per seat per hand. Raising it is the game's business
      // (`wagerDelta`, mid-hand and bounded), never a second bet.
      if (mine.wager > 0n) throw new PluginError("already_bet", 409);

      const minBet = readMinBet(ctx.settings);
      if (wager < minBet) throw new PluginError("wager_below_min", 400);
      // The FROZEN house's lever (`lockTable` resolved it from the table's own
      // `property_id`), so a table sold mid-hand keeps the bounds it was
      // dealt under.
      if (wager > locked.house.maxBet) throw new PluginError("wager_above_max", 400);

      await assertTableCanCover(
        tx, locked.house, locked.seats, game.maxPayoutMultiplier,
        { seat: mine.seatNo, amount: wager },
      );
      try {
        await escrow(tx, locked.house, player.id, wager, locked.table.gameId);
      } catch (error) {
        // The GUARD, never `instanceof` — see `applyStep`'s twin.
        if (isInsufficientFundsError(error)) throw new PluginError("insufficient_funds", 409);
        throw error;
      }
      // `idle_hands` measures CONSECUTIVE deals sat out (spec §3), so betting
      // clears it whether or not this bet is the one that deals.
      await tx.db.update(casinoSeats).set({ wager, idleHands: 0 })
        .where(eq(casinoSeats.id, mine.id));
      mine.wager = wager;
      mine.idleHands = 0;

      // The FIRST bet at a table starts the betting clock; later ones do not
      // restart it, so one seat cannot hold the table open indefinitely.
      if (locked.table.deadlineAt === null) {
        const deadlineAt = new Date(Date.now() + readTableBetSeconds(ctx.settings) * 1000);
        await tx.db.update(casinoTables).set({ deadlineAt })
          .where(eq(casinoTables.id, locked.table.id));
        locked.table.deadlineAt = deadlineAt;
      }

      // Not forced: this deals only if every non-leaving seat has now bet.
      // The lapsed-deadline deal is the clock's (Task 11).
      await dealIfReady(tx, ctx, locked, game, false);

      return renderAfter(tx, ctx, locked.table.id, game, player.id);
    });
  },
});

const actRoute = route({
  method: "POST",
  path: "/api/casino/table/act",
  accessInJail: false,
  accessInHospital: true,
  // The envelope only; the game's own `action` schema validates the payload
  // once the table tells us which game it is (spec §4.2).
  body: z.object({ action: z.unknown() }).strict(),
  handler: async (ctx, { body }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    const registry = await buildTableRegistry(ctx, ctx.installedPluginIds);

    return ctx.transaction(async (tx) => {
      const { locked, game, mine } = await lockedSeat(tx, ctx, player.id, registry, "acting");
      if (locked.table.turnSeat !== mine.seatNo) throw new PluginError("not_your_turn", 409);
      // Unreachable while `phase` and `state` move together (`applyStep` writes
      // both, `settleHand` clears both), but the column is nullable and a game
      // cannot be handed `null` as its state.
      if (locked.table.state === null) throw new PluginError("wrong_phase", 409);

      const action = parseAction(game.action, body.action);
      const step = guardGame(locked.table.gameId, "act", () =>
        game.act(fromStorableState(locked.table.state), mine.seatNo, action));
      // The acting seat, so a `wagerDelta` from THIS seat (a double) is
      // allowed and one naming any other seat is refused.
      await applyStep(tx, ctx, locked, game, step, mine.seatNo);

      return renderAfter(tx, ctx, locked.table.id, game, player.id);
    });
  },
});

export const tableRoutes = [sitRoute, leaveRoute, readRoute, betRoute, actRoute];
