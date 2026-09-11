import { and, eq, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { definePlugin, on } from "@gl3/plugin-sdk";
import { games, type GameDef } from "@gl3/plugin-casino";
import { FARO } from "./helpers/faro.js";
import { testDb, resetDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { locations, playerStats, settings, transactions } from "../src/db/schema/index.js";
import { applyBalanceChange } from "../src/economy/ledger.js";
import { casinoMachines } from "../../../packages/plugins/casino/src/schema.js";
import { propertiesPlugin as properties } from "./helpers/plugin-tables.js";
import { CasinoMachineResponseSchema, type CasinoMachine } from "@gl3/shared";

const { db, sql: connection } = testDb();
let server: Awaited<ReturnType<typeof bootTestServer>>;
let installed = true;
const plugin = definePlugin({ id: "faro", version: "1.0.0", basePaths: ["/api/faro"],
  filters: [on(games, (_ctx, list) => installed ? [...list, { ...FARO, machine: true } as GameDef] : list)],
});
beforeAll(async () => {
  await resetDb(db);
  await db.insert(settings).values({ key: "properties.skim_percent", value: "10" });
  server = await bootTestServer({ plugins: [plugin] });
});
afterAll(async () => { await server?.close(); await connection.end(); });
let count = 0;
async function person(locationId: string) {
  const user = await registerVerifiedPlayer(server, { remoteAddress: `10.131.0.${++count}` });
  await db.update(playerStats).set({ locationId }).where(eq(playerStats.playerId, user.playerId));
  await db.transaction(tx => applyBalanceChange(tx, { playerId: user.playerId, kind: "cash", amount: 10000n, reason: "test.seed" }));
  return user;
}
async function setup(owned = false) {
  const locationId = uuidv7();
  await db.insert(locations).values({ id: locationId, name: `Machine ${locationId}` });
  const user = await person(locationId);
  const owner = owned ? await person(locationId) : null;
  if (owner) await db.insert(properties).values({ id: uuidv7(), locationId, pluginId: "faro", ownerPlayerId: owner.playerId, cost: 1000n, profit: 0n });
  return { user, owner };
}
async function request(token: string, verb: string, payload?: unknown, expected = 200) {
  const result = await server.app.inject({ method: payload === undefined ? "GET" : "POST", url: `/api/casino/machine${verb ? "/" + verb : ""}`, headers: { authorization: `Bearer ${token}` }, ...(payload === undefined ? {} : { payload }) });
  expect(result.statusCode, result.body).toBe(expected);
  return expected === 200 ? CasinoMachineResponseSchema.parse(result.json()) : null;
}
async function open(token: string) { return (await request(token, "open", { gameId: "faro", credits: "1000", wager: "100" }))!.machine!; }
const stamp = (m: CasinoMachine) => ({ id: m.id, revision: m.revision });
const cash = async (id: string) => (await db.select().from(playerStats).where(eq(playerStats.playerId, id)))[0]!.cash;

describe("persistent machine credits", () => {
  it("reserves the buy-in and refunds unplayed credits with no house skim", async () => {
    const { user, owner } = await setup(true);
    const machine = await open(user.token);
    expect(await cash(user.playerId)).toBe(9000n);
    expect(await cash(owner!.playerId)).toBe(10000n);
    expect(machine).toMatchObject({ credits: "1000", inRound: false, revision: 0 });
    expect((await request(user.token, "cashout", stamp(machine)))!.cashedOut).toBe("1000");
    expect(await cash(user.playerId)).toBe(10000n);
    expect(await cash(owner!.playerId)).toBe(10000n);
    await request(user.token, "cashout", stamp(machine), 409);
  });

  it("retains winnings for the next spin and conserves cash plus escrow minus skim", async () => {
    const { user, owner } = await setup(true);
    let machine = await open(user.token);
    machine = (await request(user.token, "spin", { ...stamp(machine), wager: "100" }))!.machine!;
    expect(machine).toMatchObject({ credits: "900", inRound: true });
    expect(await cash(user.playerId)).toBe(9000n);
    expect(await cash(owner!.playerId)).toBe(10090n);
    machine = (await request(user.token, "act", { ...stamp(machine), action: "win" }))!.machine!;
    expect(machine).toMatchObject({ credits: "1100", inRound: false, closed: false });
    expect(await cash(owner!.playerId)).toBe(9890n);
    machine = (await request(user.token, "spin", { ...stamp(machine), wager: "200" }))!.machine!;
    machine = (await request(user.token, "act", { ...stamp(machine), action: "lose" }))!.machine!;
    expect(machine.credits).toBe("900");
    await request(user.token, "cashout", stamp(machine));
    expect(await cash(user.playerId)).toBe(9900n);
    expect(await cash(owner!.playerId)).toBe(10070n);
    const [net] = await db.select({ sum: sql<string>`sum(${transactions.amount})::text` }).from(transactions)
      .where(and(eq(transactions.reason, "casino.faro.credits"), sql`${transactions.playerId} in (${user.playerId}, ${owner!.playerId})`));
    expect(net!.sum).toBe("-30");
  });

  it("serializes simultaneous spins and rejects stale actions from the prior round", async () => {
    const { user } = await setup();
    const machine = await open(user.token);
    const replies = await Promise.all([0, 1].map(() => server.app.inject({ method: "POST", url: "/api/casino/machine/spin", headers: { authorization: `Bearer ${user.token}` }, payload: { ...stamp(machine), wager: "100" } })));
    expect(replies.map(r => r.statusCode).sort()).toEqual([200, 409]);
    const current = (await request(user.token, ""))!.machine!;
    expect(current.credits).toBe("900");
    await request(user.token, "act", { ...stamp(machine), action: "win" }, 409);
    const settled = (await request(user.token, "act", { ...stamp(current), action: "win" }))!.machine!;
    await request(user.token, "act", { ...stamp(current), action: "win" }, 409);
    expect((await request(user.token, ""))!.machine!.credits).toBe(settled.credits);
  });

  it("survives reload and long absences without forfeiting the wallet", async () => {
    const { user } = await setup();
    const machine = await open(user.token);
    await db.update(casinoMachines).set({ createdAt: new Date("2000-01-01") }).where(eq(casinoMachines.id, machine.id));
    expect((await request(user.token, ""))!.machine).toMatchObject({ id: machine.id, credits: "1000" });
    await request(user.token, "open", { gameId: "faro", credits: "1000", wager: "100" }, 409);
    expect(await cash(user.playerId)).toBe(9000n);
  });

  it("returns unplayed credits even if the game disappears during a round", async () => {
    const { user } = await setup();
    let machine = await open(user.token);
    machine = (await request(user.token, "spin", { ...stamp(machine), wager: "100" }))!.machine!;
    installed = false;
    try {
      expect((await request(user.token, ""))!.machine!.available).toBe(false);
      expect((await request(user.token, "cashout", stamp(machine)))!.cashedOut).toBe("900");
      expect(await cash(user.playerId)).toBe(9900n);
    } finally { installed = true; }
  });

  it("rolls back unsupported raises and refuses other players' wallets", async () => {
    const { user, owner } = await setup(true);
    let machine = await open(user.token);
    await request(owner!.token, "cashout", stamp(machine), 404);
    await request(user.token, "spin", { ...stamp(machine), wager: "1001" }, 400);
    machine = (await request(user.token, "spin", { ...stamp(machine), wager: "100" }))!.machine!;
    await request(user.token, "act", { ...stamp(machine), action: "double" }, 400);
    expect((await request(user.token, ""))!.machine).toMatchObject({ revision: machine.revision, credits: "900", inRound: true });
  });

  it("keeps cash and every player's ledger in agreement", async () => {
    const invalid = await db.execute(sql`select ps.player_id from player_stats ps left join transactions t
      on t.player_id = ps.player_id and t.balance_kind = 'cash'
      group by ps.player_id, ps.cash having ps.cash <> coalesce(sum(t.amount),0)`);
    expect(invalid).toHaveLength(0);
    const fks = await db.execute(sql`select conname from pg_constraint where conrelid = 'p_casino_machines'::regclass and contype='f'`);
    expect(fks).toHaveLength(0);
  });
});
