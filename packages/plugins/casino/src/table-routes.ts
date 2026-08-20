import { randomBytes } from "node:crypto";
import { asc, eq, inArray } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { PluginError, route, type PluginCtx, type PluginTx } from "@gl3/plugin-sdk";
import { guardGame, resolveHouse } from "./engine.js";
import { buildTableRegistry, type TableGameDef } from "./games.js";
import { casinoSeats, casinoTables, locations, players, playerStats } from "./schema.js";
import { fromStorableState } from "./state.js";
import { readMaxBet, readMinBet, readTableMaxSeats } from "./settings.js";
import { lockTable, type LockedTable } from "./table-engine.js";

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
      if (await seatOf(tx, player.id) !== null) throw new PluginError("already_seated", 409);
      if (locked.seats.length >= maxSeats) throw new PluginError("table_full", 409);
      const taken = new Set(locked.seats.map((s) => s.seatNo));
      let seatNo = 0;
      while (taken.has(seatNo)) seatNo += 1;
      await tx.db.insert(casinoSeats).values({
        id: uuidv7(), tableId: target, playerId: player.id, seatNo,
      });
      return { status: 200, body: { tableId: target, seat: seatNo } };
    });
  },
});

const leaveRoute = route({
  method: "POST",
  path: "/api/casino/table/leave",
  accessInJail: false,
  accessInHospital: true,
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
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

      if (mine.wager > 0n) {
        // In hand — wager escrowed, whether the deal has fired (acting) or is
        // still pending (betting): the stake stays in play, spec §5's "no
        // money is ever dropped by leaving". Mark leaving; the deal includes
        // this seat, the turn clock auto-stands its turns, and Task 10's
        // settle pays it normally and frees the seat at hand end. The
        // wager-0 test is the spec's in-hand definition — NEVER phase.
        await tx.db.update(casinoSeats).set({ leaving: true }).where(eq(casinoSeats.id, mine.id));
        return { status: 200, body: { left: true, deferred: true } };
      }
      await tx.db.delete(casinoSeats).where(eq(casinoSeats.id, mine.id));
      if (locked.seats.length === 1) {
        await tx.db.delete(casinoTables).where(eq(casinoTables.id, locked.table.id));
      }
      return { status: 200, body: { left: true, deferred: false } };
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
      // Fast path: no lapsed deadline → plain reads, zero locks. Task 11
      // replaces this comment with the advance-then-render slow path.
      await tx.locks.location(seat.locationId);
      const locked = await lockTable(tx, ctx, seat.tableId);
      if (locked === null) return { status: 200, body: { table: null } };
      const game = registry.get(locked.table.gameId);
      if (game === undefined) throw new PluginError("no_such_game", 404);
      return { status: 200, body: { table: await renderTablePayload(tx, ctx, locked, game, player.id) } };
    });
  },
});

export const tableRoutes = [sitRoute, leaveRoute, readRoute];
