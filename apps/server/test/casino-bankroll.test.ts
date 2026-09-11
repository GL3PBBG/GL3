import { eq, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { definePlugin, on } from "@gl3/plugin-sdk";
import { tableGames, type TableGameDef } from "@gl3/plugin-casino";
import { testDb, resetDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { locations, playerStats, settings } from "../src/db/schema/index.js";
import { applyBalanceChange } from "../src/economy/ledger.js";
import { casinoSeats, casinoTables } from "../../../packages/plugins/casino/src/schema.js";
import { propertiesPlugin as properties } from "./helpers/plugin-tables.js";
import { CasinoTableResponseSchema } from "@gl3/shared";

const { db, sql: connection } = testDb();
let server: Awaited<ReturnType<typeof bootTestServer>>;
let installed = true;
type State = { seats: { seat: number; wager: bigint }[]; done: boolean; mint?: boolean };
const game: TableGameDef<State> = {
  id: "faro", name: "Bankroll test", bankroll: true, maxPayoutMultiplier: 5,
  action: z.enum(["finish", "mint"]),
  deal: ({ seats }) => ({ state: { seats, done: false }, done: false, turn: seats[0]!.seat }),
  act: (state, _seat, action) => ({ state: { ...state, done: true, mint: action === "mint" }, done: true, turn: null }),
  autoAct: state => ({ state: { ...state, done: true }, done: true, turn: null }),
  settle: state => state.seats.map(s => ({ seat: s.seat, payout: state.mint ? s.wager * 2n : s.wager - 10n })),
  view: () => ({ kind: "text", value: "Bankroll" }), moves: () => [],
};
const plugin = definePlugin({ id: "faro", version: "1.0.0", basePaths: ["/api/faro"],
  filters: [on(tableGames, (_ctx, list) => installed ? [...list, game as TableGameDef] : list)],
});
beforeAll(async () => {
  await resetDb(db);
  await db.insert(settings).values({ key: "properties.skim_percent", value: "10" });
  server = await bootTestServer({ plugins: [plugin] });
});
afterAll(async () => { await server?.close(); await connection.end(); });
let count = 0;
async function setup() {
  const locationId = uuidv7();
  await db.insert(locations).values({ id: locationId, name: `Bankroll ${locationId}` });
  const users = [];
  for (let i = 0; i < 3; i++) {
    const user = await registerVerifiedPlayer(server, { remoteAddress: `10.132.0.${++count}` });
    await db.update(playerStats).set({ locationId }).where(eq(playerStats.playerId, user.playerId));
    await db.transaction(tx => applyBalanceChange(tx, { playerId: user.playerId, kind: "cash", amount: 10000n, reason: "test.seed" }));
    users.push(user);
  }
  const [a, b, owner] = users;
  await db.insert(properties).values({ id: uuidv7(), locationId, pluginId: "faro", ownerPlayerId: owner!.playerId, cost: 1000n, profit: 0n });
  await request(a!.token, "sit", { gameId: "faro" });
  await request(b!.token, "sit", { gameId: "faro" });
  return { a: a!, b: b!, owner: owner! };
}
async function request(token: string, verb: string, payload?: unknown, expected = 200) {
  const result = await server.app.inject({ method: payload === undefined ? "GET" : "POST", url: `/api/casino/table${verb ? "/" + verb : ""}`, headers: { authorization: `Bearer ${token}` }, ...(payload === undefined ? {} : { payload }) });
  expect(result.statusCode, result.body).toBe(expected);
  return result.json();
}
const cash = async (id: string) => (await db.select().from(playerStats).where(eq(playerStats.playerId, id)))[0]!.cash;
const view = async (token: string) => CasinoTableResponseSchema.parse(await request(token, "")).table!;
const bet = (token: string) => request(token, "bet", { wager: "1000" });

describe("persistent table bankroll", () => {
  it("keeps stacks across hands, skims only rake, and returns credits exactly once", async () => {
    const { a, b, owner } = await setup();
    await bet(a.token);
    expect(await cash(a.playerId)).toBe(9000n);
    expect(await cash(owner.playerId)).toBe(10000n);
    await bet(b.token);
    await request(a.token, "act", { action: "finish" });
    let table = await view(a.token);
    expect(table.bankroll).toBe(true);
    expect(table.phase).toBe("betting");
    expect(table.seats.map(s => s.credits)).toEqual(["990", "990"]);
    expect(table.seats.map(s => s.wager)).toEqual(["0", "0"]);
    expect(await cash(owner.playerId)).toBe(10018n);
    await request(a.token, "bet", { wager: "0" });
    await request(b.token, "bet", { wager: "0" });
    expect(await cash(a.playerId)).toBe(9000n);
    table = await view(a.token);
    expect(table.handNo).toBe(2);
    expect(table.seats.map(s => s.wager)).toEqual(["990", "990"]);
    await request(a.token, "act", { action: "finish" });
    await request(a.token, "leave", {});
    await request(b.token, "leave", {});
    expect(await cash(a.playerId)).toBe(9980n);
    expect(await cash(b.playerId)).toBe(9980n);
    expect(await cash(owner.playerId)).toBe(10036n);
    await request(a.token, "leave", {}, 404);
  });

  it("waits for an opponent and refunds a ready stack before the deal even after uninstall", async () => {
    const { a, b, owner } = await setup();
    await bet(a.token);
    const table = await view(a.token);
    await db.update(casinoTables).set({ deadlineAt: new Date(0) }).where(eq(casinoTables.id, table.tableId));
    expect((await view(a.token)).phase).toBe("betting");
    expect((await view(a.token)).handNo).toBe(0);
    installed = false;
    try { await request(a.token, "leave", {}); await request(b.token, "leave", {}); }
    finally { installed = true; }
    expect(await cash(a.playerId)).toBe(10000n);
    expect(await cash(owner.playerId)).toBe(10000n);
  });

  it("settles a deferred cash-out and never spends another buy-in on an expired clock", async () => {
    const { a, b } = await setup();
    await bet(a.token); await bet(b.token);
    expect((await request(b.token, "leave", {})).deferred).toBe(true);
    const table = await view(a.token);
    await db.update(casinoTables).set({ deadlineAt: new Date(0) }).where(eq(casinoTables.id, table.tableId));
    const resumed = await view(a.token);
    expect(resumed.phase).toBe("betting");
    expect(resumed.deadlineAt).toBe(null);
    expect(resumed.seats).toHaveLength(1);
    expect(resumed.seats[0]!.credits).toBe("990");
    expect(await cash(b.playerId)).toBe(9990n);
    expect(await cash(a.playerId)).toBe(9000n);
    await request(a.token, "leave", {});
  });

  it("rolls back payouts exceeding the funded pot and serializes duplicate buy-ins", async () => {
    const { a, b, owner } = await setup();
    const replies = await Promise.all([0,1].map(() => server.app.inject({ method: "POST", url: "/api/casino/table/bet", headers: { authorization: `Bearer ${a.token}` }, payload: { wager: "1000" } })));
    expect(replies.map(r => r.statusCode).sort()).toEqual([200,409]);
    await bet(b.token);
    await request(a.token, "act", { action: "mint" }, 500);
    expect((await view(a.token)).phase).toBe("acting");
    expect(await cash(owner.playerId)).toBe(10000n);
    await request(a.token, "act", { action: "finish" });
    await request(a.token, "leave", {}); await request(b.token, "leave", {});
  });

  it("refunds idle credits when a player is swept from a table", async () => {
    const { a, b, owner } = await setup();
    await bet(a.token); await bet(b.token);
    await request(a.token, "act", { action: "finish" });
    // An additional unowned table participant makes a real two-player deal
    // possible while the original funded player sits out.
    await db.delete(properties).where(eq(properties.ownerPlayerId, owner.playerId));
    await request(owner.token, "sit", { gameId: "faro" });
    await db.update(casinoSeats).set({ idleHands: 100 }).where(eq(casinoSeats.playerId, a.playerId));
    await request(b.token, "bet", { wager: "0" }); await bet(owner.token);
    const table = await view(b.token);
    await db.update(casinoTables).set({ deadlineAt: new Date(0) }).where(eq(casinoTables.id, table.tableId));
    await view(b.token);
    expect((await db.select().from(casinoSeats).where(eq(casinoSeats.playerId, a.playerId)))).toHaveLength(0);
    expect(await cash(a.playerId)).toBe(9990n);
  });

  it("finishes a legacy hand after upgrade before adopting retained stacks", async () => {
    const { a, b, owner } = await setup();
    game.bankroll = false;
    try { await bet(a.token); } finally { game.bankroll = true; }
    expect(await cash(owner.playerId)).toBe(10900n);
    await bet(b.token);
    expect((await view(a.token)).seats.every(s => s.credits === null)).toBe(true);
    await request(a.token, "act", { action: "finish" });
    expect(await cash(a.playerId)).toBe(9990n);
    await bet(a.token); await bet(b.token);
    expect((await view(a.token)).seats.every(s => s.credits === "1000")).toBe(true);
    await request(a.token, "act", { action: "finish" });
    await request(a.token, "leave", {}); await request(b.token, "leave", {});
  });

  it("preserves the ledger invariant", async () => {
    const invalid = await db.execute(sql`select ps.player_id from player_stats ps left join transactions t
      on t.player_id = ps.player_id and t.balance_kind = 'cash'
      group by ps.player_id, ps.cash having ps.cash <> coalesce(sum(t.amount),0)`);
    expect(invalid).toHaveLength(0);
  });
});
