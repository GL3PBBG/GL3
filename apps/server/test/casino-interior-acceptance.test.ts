import type { AddressInfo } from "node:net";
import type { ServerFrame } from "@gl3/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type WebSocket from "ws";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { dealTable } from "@gl3/plugin-blackjack";
import { CasinoFloorResponseSchema, CasinoSitResponseSchema, CasinoTableResponseSchema } from "@gl3/shared";
import { locations, playerStats } from "../src/db/schema/index.js";
import { seedLocations } from "../src/db/seed.js";
import { resetDb, testDb } from "./helpers/db.js";
import { casinoTables } from "./helpers/plugin-tables.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";
import { frameOfKind, mintTicket, nextFrame, openSocket, sendFrame } from "./helpers/ws.js";

/**
 * The cluster's stated acceptance target (spec 2026-09-20 casino-interior
 * §9): two real sockets walk from the street into the casino, sit at station
 * 0, play a blackjack hand through the EXISTING table routes, one of them
 * loses its socket mid-hand and reconnects straight into the interior, the
 * hand finishes, both leave and walk out. No mocks anywhere.
 *
 * The socket harness below is `presence-interior.test.ts`'s (itself
 * `presence-rooms.test.ts`'s); the inject helpers are
 * `casino-floor.test.ts`'s and `casino-table-money.test.ts`'s.
 */
const { db, sql: conn } = testDb();

let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;
let baseUrl: string;
let chicago: string;
const opened: WebSocket[] = [];

beforeAll(async () => {
  ({ app, close: closeServer, redis } = await bootTestServer());
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  baseUrl = `ws://127.0.0.1:${port}/ws`;
});
beforeEach(async () => {
  for (const s of opened.splice(0)) s.close();
  await resetDb(db);
  await seedLocations(db);
  const rows = await db.select({ id: locations.id, name: locations.name }).from(locations);
  chicago = rows.find((r) => r.name === "Chicago")!.id;
});
afterAll(async () => { for (const s of opened) s.close(); await closeServer(); await conn.end(); });

/** A verified player standing in `locationId`, with an open socket past `ready`. */
async function playerIn(locationId: string, username: string) {
  const p = await registerVerifiedPlayer({ app, redis }, { username });
  await db.update(playerStats).set({ locationId }).where(eq(playerStats.playerId, p.playerId));
  const socket = await openSocket(`${baseUrl}?ticket=${await mintTicket(app, p.token)}`);
  opened.push(socket);
  expect((await nextFrame(socket)).kind).toBe("ready");
  return { ...p, socket };
}
async function joined(locationId: string, username: string) {
  const p = await playerIn(locationId, username);
  sendFrame(p.socket, { kind: "presence.join", client: "godot-desktop" });
  return p;
}
const move = (socket: WebSocket, seq: number, x: number, y: number, facing = 0) =>
  sendFrame(socket, { kind: "presence.move", seq, x, y, facing });

type Tick = Extract<ServerFrame, { kind: "presence.tick" }>;

/**
 * The next tick this socket receives that says something about `ok`.
 *
 * Auto-join announces every connecting socket as a static member and the
 * `presence.join` that takes the avatar over re-announces it, so a bare
 * `frameOfKind(socket, "presence.tick")` is not a reliable way to read the
 * tick a test means. This skips the ones carrying something else — it never
 * weakens an assertion, it only aims it. Nothing here drains a socket it
 * later waits on: a timed-out `nextFrame` leaves its resolver armed
 * (`helpers/ws.ts`), so a drain would eat the very frame waited on next.
 */
async function tickWhere(socket: WebSocket, ok: (t: Tick) => boolean, timeoutMs = 4000): Promise<Tick> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const tick = await frameOfKind(socket, "presence.tick", Math.max(1, deadline - Date.now()));
    if (ok(tick)) return tick;
  }
}

const enter = (socket: WebSocket, hookId = "casino.casino") => sendFrame(socket, { kind: "presence.enter", hookId });
const exit = (socket: WebSocket) => sendFrame(socket, { kind: "presence.exit" });

const sit = (token: string, gameId: string, station: number) => app.inject({
  method: "POST", url: "/api/casino/table/sit",
  headers: { authorization: `Bearer ${token}` }, payload: { gameId, station },
});
const leave = (token: string) => app.inject({
  method: "POST", url: "/api/casino/table/leave",
  headers: { authorization: `Bearer ${token}` }, payload: {},
});
const tableView = (token: string) => app.inject({
  method: "GET", url: "/api/casino/table", headers: { authorization: `Bearer ${token}` },
});
const bet = (token: string, wager: string) => app.inject({
  method: "POST", url: "/api/casino/table/bet",
  headers: { authorization: `Bearer ${token}` }, payload: { wager },
});
const act = (token: string, action: "hit" | "stand") => app.inject({
  method: "POST", url: "/api/casino/table/act",
  headers: { authorization: `Bearer ${token}` }, payload: { action },
});
const table = async (token: string) => CasinoTableResponseSchema.parse((await tableView(token)).json()).table;

/**
 * A seed whose deal leaves SOMEBODY to act — `casino-table-money.test.ts`'s
 * `probeSeed` idiom, narrowed to the one property this scenario needs.
 *
 * The shuffle is pure and the seed is a column, so a test can pick the deal
 * it needs and write it on before the bet that completes the table. Nothing
 * else is rigged: every figure still moves through the real routes. Without
 * this, two natural blackjacks (~1 in 450 deals) settle the hand at the deal
 * itself, leaving `phase: "betting"` and no open hand for the mid-hand
 * reconnect — steps 4 and 5 — to reconnect INTO.
 */
function contestedSeed(seats: { seat: number; wager: bigint }[]): string {
  for (let i = 0; i < 4000; i += 1) {
    const seed = `acceptance-${i}`;
    if (!dealTable(seats, seed).done) return seed;
  }
  throw new Error("no seed left a seat to act");
}

/**
 * Play the dealt hand out with ONE joint loop over both players: read the
 * table as A, act with whichever token owns `turnSeat`, sleep otherwise.
 * (Controller ruling B: a per-player loop would spin while the OTHER player
 * must act and time out.)
 */
async function playOut(a: string, b: string): Promise<void> {
  const tokens: Record<number, string> = { 0: a, 1: b };
  for (let i = 0; i < 40; i += 1) {
    const t = await table(a);
    if (t === null || t.phase !== "acting") return;
    const turn = t.turnSeat;
    if (turn !== null && tokens[turn] !== undefined) {
      expect((await act(tokens[turn]!, "stand")).statusCode).toBe(200);
      continue;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("hand did not finish");
}

it("street → shared casino interior → one playable blackjack table → street, with a reconnect mid-hand", async () => {
  const a = await joined(chicago, "alice"); const b = await joined(chicago, "bob");
  await frameOfKind(a.socket, "presence.snapshot"); await frameOfKind(b.socket, "presence.snapshot");
  for (const p of [a, b]) await db.update(playerStats).set({ cash: 1_000_000n }).where(eq(playerStats.playerId, p.playerId));

  // 1. Both walk in.
  enter(a.socket); const aIn = await frameOfKind(a.socket, "presence.snapshot");
  enter(b.socket); const bIn = await frameOfKind(b.socket, "presence.snapshot");
  expect(aIn.room.space?.kind).toBe("interior"); expect(bIn.players.map((p) => p.playerId)).toEqual([a.playerId]);
  const station0 = aIn.room.points!.find((p) => p.binding?.gameId === "blackjack" && p.binding.station === 0)!;

  // 2. Both sit at station 0 and stand at its seats (positions are cosmetic; the client moves itself).
  const sa = CasinoSitResponseSchema.parse((await sit(a.token, "blackjack", 0)).json());
  const sb = CasinoSitResponseSchema.parse((await sit(b.token, "blackjack", 0)).json());
  expect(sb.tableId).toBe(sa.tableId); expect([sa.seat, sb.seat]).toEqual([0, 1]);
  move(a.socket, 1, station0.seats![0]!.x, station0.seats![0]!.y, station0.seats![0]!.facing);
  await tickWhere(b.socket, (t) => t.moved.some((m) => m.playerId === a.playerId));
  const floorBody = CasinoFloorResponseSchema.parse((await app.inject({ method: "GET", url: "/api/casino/floor", headers: { authorization: `Bearer ${a.token}` } })).json());
  expect(floorBody.stations[0]!.seats.map((s) => s.username)).toEqual(["alice", "bob"]);

  // 3. Both bet: the second bet deals.
  await db.update(casinoTables)
    .set({ seed: contestedSeed([{ seat: 0, wager: 100n }, { seat: 1, wager: 100n }]) })
    .where(eq(casinoTables.id, sa.tableId));
  expect((await bet(a.token, "100")).statusCode).toBe(200);
  expect((await bet(b.token, "100")).statusCode).toBe(200);
  const dealt = await table(a.token);
  expect(dealt?.phase).toBe("acting");
  expect(dealt?.handNo).toBeGreaterThanOrEqual(1);   // ruling C: only `phase` is asserted exactly

  // 4. Alice's socket dies mid-hand. Nothing about the hand changes.
  a.socket.close();
  await tickWhere(b.socket, (t) => t.left.includes(a.playerId));
  expect((await table(b.token))?.seats.map((s) => s.playerId)).toEqual([a.playerId, b.playerId]);

  // 5. Alice reconnects straight into the interior and resumes.
  const again = await openSocket(`${baseUrl}?ticket=${await mintTicket(app, a.token)}`);
  opened.push(again);
  expect((await nextFrame(again)).kind).toBe("ready");
  sendFrame(again, { kind: "presence.join", client: "godot-desktop", interior: "casino.casino" });
  await frameOfKind(again, "presence.snapshot");                                // street
  const back = await frameOfKind(again, "presence.snapshot");                  // interior
  expect(back.room.space).toMatchObject({ kind: "interior", hookId: "casino.casino" });
  expect(back.players.map((p) => p.playerId)).toEqual([b.playerId]);
  await tickWhere(b.socket, (t) => t.joined.some((p) => p.playerId === a.playerId));
  const resumed = await table(a.token);
  expect(resumed).toMatchObject({ tableId: sa.tableId, station: 0, mySeat: 0, phase: "acting" });
  expect(resumed?.view).not.toBeNull();

  // 6. Play the hand out: each stands on their turn.
  await playOut(a.token, b.token);
  const settled = await table(a.token);
  expect(settled?.phase).toBe("betting");

  // 7. Leave the table (existing rules: no stake in hand, so freed at once), then walk out.
  expect((await leave(a.token)).json()).toEqual({ left: true, deferred: false });
  expect((await leave(b.token)).json()).toEqual({ left: true, deferred: false });
  exit(again); const aOut = await frameOfKind(again, "presence.snapshot");
  exit(b.socket); const bOut = await frameOfKind(b.socket, "presence.snapshot");
  expect(aOut.room.space).toEqual({ kind: "street", locationId: chicago });
  expect(bOut.players.map((p) => p.playerId)).toContain(a.playerId);
  expect(aOut.you).toMatchObject({ x: bOut.you.x, y: 7.5, facing: Math.PI });
  // Money moved through the ledger, not presence: the invariant test covers sums; here, both still solvent.
  for (const p of [a, b]) {
    const [row] = await db.select({ cash: playerStats.cash }).from(playerStats).where(eq(playerStats.playerId, p.playerId));
    expect(row!.cash).toBeGreaterThan(0n);
  }
});
