import { asc, eq, inArray } from "drizzle-orm";
import { PluginError, route } from "@gl3/plugin-sdk";
import { buildTableRegistry } from "./games.js";
import { CASINO_FLOOR } from "./floor.js";
import { casinoSeats, casinoTables, locations, players, playerStats } from "./schema.js";
import { readTableMaxSeats } from "./settings.js";

/**
 * The live binding behind the floor's points (spec 2026-09-20 casino-interior
 * §5.3): one row per declared station, with the table standing there right
 * now, if any. Read-only and lock-free, `readLobby`'s idiom — a client on the
 * floor polls this on entry and every 15 s; the `table` tick reaches seats
 * only. Names ride only in an open town: an underground town's residents are
 * unidentifiable from here exactly as from `/api/online`.
 */
export const floorRoute = route({
  method: "GET",
  path: "/api/casino/floor",
  accessInJail: false,
  accessInHospital: true,
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    const registry = await buildTableRegistry(ctx, ctx.installedPluginIds);
    const maxSeats = readTableMaxSeats(ctx.settings);
    return ctx.transaction(async (tx) => {
      const [stats] = await tx.db.select({ locationId: playerStats.locationId }).from(playerStats).where(eq(playerStats.playerId, player.id));
      const locationId = stats?.locationId ?? null;
      if (locationId === null) throw new PluginError("no_location", 409);
      const [town] = await tx.db.select({ name: locations.name, combatMode: locations.combatMode }).from(locations).where(eq(locations.id, locationId));
      const combatMode = town?.combatMode === "underground" ? "underground" : "open";

      const tables = await tx.db.select().from(casinoTables)
        .where(eq(casinoTables.locationId, locationId)).orderBy(asc(casinoTables.createdAt));
      const seats = tables.length === 0 ? [] : await tx.db.select().from(casinoSeats)
        .where(inArray(casinoSeats.tableId, tables.map((t) => t.id))).orderBy(asc(casinoSeats.seatNo));
      const names = new Map<string, string>();
      if (combatMode === "open" && seats.length > 0) {
        const rows = await tx.db.select({ id: players.id, username: players.username }).from(players)
          .where(inArray(players.id, [...new Set(seats.map((s) => s.playerId))]));
        for (const r of rows) names.set(r.id, r.username);
      }

      const stations = CASINO_FLOOR.points
        .filter((p) => p.binding !== undefined)
        .sort((a, b) => a.binding!.station - b.binding!.station)
        .map((p) => {
          const { gameId, station } = p.binding!;
          // Gated on the game being REGISTERED (spec §5.3): with blackjack
          // uninstalled the station still lists, but with `tableId: null`
          // and `available: false` — and so `phase`, `seatsFilled` and
          // `seats` fall out null/0/[] rather than advertising a table
          // nothing can be played at.
          const table = registry.has(gameId)
            ? (tables.find((t) => t.gameId === gameId && t.station === station) ?? null)
            : null;
          const mine = table === null ? [] : seats.filter((s) => s.tableId === table.id);
          return {
            station, gameId, gameName: registry.get(gameId)?.name ?? gameId, available: registry.has(gameId),
            tableId: table?.id ?? null, phase: table?.phase ?? null,
            seatsFilled: mine.length, maxSeats,
            seats: combatMode === "open"
              ? mine.map((s) => ({ seat: s.seatNo, playerId: s.playerId, username: names.get(s.playerId) ?? "" }))
              : [],
          };
        });
      return { status: 200, body: { locationId, locationName: town?.name ?? "", combatMode, stations } };
    });
  },
});
