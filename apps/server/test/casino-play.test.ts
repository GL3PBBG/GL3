import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { locations, playerStats } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { casinoSessions, propertiesPlugin as propertiesTable } from "./helpers/plugin-tables.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * POST /api/casino/play — escrow, house resolution, exposure check.
 *
 * Runs against the real installed `blackjack` game (a CORE_PLUGIN, like
 * `casino` itself — casino-boot.test.ts's precedent), through a bare
 * `bootTestServer()`, exactly the shape `properties-routes.test.ts` uses.
 *
 * Every check exercised here (min/max bet, insufficient funds, house
 * exposure, unknown game, an already-open session) is decided BEFORE
 * `game.start` runs, so none of it depends on the real shuffle. Only the
 * "escrows the wager" test reaches `game.start`, and blackjack's `start` can
 * settle immediately on a natural dealt from a real `node:crypto` shoe — so
 * that test computes its expected deltas from the response body's
 * `done`/`payout` fields rather than assuming the hand stays open, which
 * keeps it deterministic regardless of the deal (CLAUDE.md: "flaky means
 * broken").
 */
const { db, sql: conn } = testDb();

let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;

let regCounter = 0;

async function register(): Promise<{ token: string; playerId: string }> {
  regCounter += 1;
  return registerVerifiedPlayer({ app, redis }, {
    username: `Gambler${regCounter}`,
    remoteAddress: `10.60.${(regCounter >> 8) & 0xff}.${regCounter & 0xff}`,
  });
}

async function seedLocation(): Promise<string> {
  const id = uuidv7();
  await db.insert(locations).values({
    id,
    name: `city-${id.slice(-8)}`,
    travelCost: 0n,
    travelCooldownSeconds: 60,
    bulletStock: 0,
    bulletCost: 1n,
  });
  return id;
}

const cashOf = async (id: string): Promise<bigint> => {
  const [row] = await db.select({ cash: playerStats.cash }).from(playerStats).where(eq(playerStats.playerId, id));
  return row?.cash ?? 0n;
};

/**
 * Seeds a blackjack house directly, bypassing `properties/buy` — this file
 * is about the casino's own escrow/exposure logic, not property acquisition.
 * `cost` is the owner's lever (V2 blackjack.inc.php:276): 0n means "unset",
 * which falls back to the `max_bet` setting.
 */
async function seedHouse(locationId: string, ownerId: string, cost: bigint): Promise<string> {
  const id = uuidv7();
  await db.insert(propertiesTable).values({
    id, locationId, pluginId: "blackjack", ownerPlayerId: ownerId, cost, profit: 0n,
  });
  return id;
}

async function placePlayer(playerId: string, locationId: string, cash: bigint): Promise<void> {
  await db.update(playerStats).set({ locationId, cash }).where(eq(playerStats.playerId, playerId));
}

function play(token: string, gameId: string, wager: string) {
  return app.inject({
    method: "POST",
    url: "/api/casino/play",
    headers: { authorization: `Bearer ${token}` },
    payload: { gameId, wager },
  });
}

beforeAll(async () => {
  await resetDb(db);
  ({ app, close: closeServer, redis } = await bootTestServer());
});

afterAll(async () => {
  await closeServer?.();
  await conn.end();
});

describe("POST /api/casino/play", () => {
  it("rejects a wager below min_bet", async () => {
    const { token, playerId } = await register();
    const locationId = await seedLocation();
    await placePlayer(playerId, locationId, 1_000_000n);

    // Default min_bet is 10,000.
    const res = await play(token, "blackjack", "5000");
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe("wager_below_min");
  });

  it("rejects a wager above the house lever", async () => {
    const { token, playerId } = await register();
    const { playerId: ownerId } = await register();
    const locationId = await seedLocation();
    await seedHouse(locationId, ownerId, 50_000n); // lever: max bet 50,000
    await placePlayer(playerId, locationId, 1_000_000n);

    const res = await play(token, "blackjack", "100000");
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe("wager_above_max");
  });

  it("404s an unknown gameId", async () => {
    const { token, playerId } = await register();
    const locationId = await seedLocation();
    await placePlayer(playerId, locationId, 1_000_000n);

    const res = await play(token, "roulette", "50000");
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toBe("no_such_game");
  });

  it("refuses to play with insufficient cash", async () => {
    const { token, playerId } = await register();
    const locationId = await seedLocation();
    await placePlayer(playerId, locationId, 0n);

    const res = await play(token, "blackjack", "20000");
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe("insufficient_funds");
  });

  it("refuses a wager the house cannot cover", async () => {
    const { token, playerId } = await register();
    const { playerId: ownerId } = await register();
    const locationId = await seedLocation();
    await seedHouse(locationId, ownerId, 0n); // no lever set — falls back to max_bet
    await placePlayer(playerId, locationId, 1_000_000n);
    await placePlayer(ownerId, locationId, 100_000n);

    // 60,000 * 2.5 = 150,000 > the owner's 100,000 cash.
    const res = await play(token, "blackjack", "60000");
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe("house_cannot_cover");
  });

  it("escrows the wager to the house, exactly", async () => {
    const { token, playerId } = await register();
    const { playerId: ownerId } = await register();
    const locationId = await seedLocation();
    const propertyId = await seedHouse(locationId, ownerId, 0n);
    await placePlayer(playerId, locationId, 1_000_000n);
    await placePlayer(ownerId, locationId, 10_000_000n);

    const cashBefore = await cashOf(playerId);
    const ownerCashBefore = await cashOf(ownerId);

    const res = await play(token, "blackjack", "100000");
    expect(res.statusCode).toBe(200);
    const body = res.json<{ done: boolean; wager: string; payout?: string }>();

    // `play` echoes the stake on both branches. Not an information gap the way
    // `act`'s is — the caller sent this figure — but it is what lets the two
    // routes share one response shape, and it is canonical where the request
    // need not be (`BigInt("007").toString()` is `"7"`).
    expect(body.wager).toBe("100000");

    // The wager is always escrowed. If `start` also settled the hand (a
    // natural), the payout moves back on top of it in the same call — so the
    // net to the player is `payout - wager` when done, else just `-wager`.
    const net = body.done ? BigInt(body.payout ?? "0") - 100_000n : -100_000n;

    expect(await cashOf(playerId)).toBe(cashBefore + net);
    expect(await cashOf(ownerId)).toBe(ownerCashBefore - net);

    // profit moves with the money — payOwner does both or neither.
    const [prop] = await db.select().from(propertiesTable).where(eq(propertiesTable.id, propertyId));
    expect(prop?.profit).toBe(-net);
  });

  it("refuses a second play while one is open", async () => {
    const { token, playerId } = await register();
    const locationId = await seedLocation();
    await placePlayer(playerId, locationId, 1_000_000n);

    // Seeded directly rather than left open by a real hand: blackjack can
    // settle at `start` on a natural, which would make this flaky if it
    // depended on the first play staying open.
    await db.insert(casinoSessions).values({
      id: uuidv7(),
      playerId,
      gameId: "blackjack",
      locationId,
      propertyId: null,
      wager: 50_000n,
      state: {},
      status: "open",
      seed: "x",
    });

    const res = await play(token, "blackjack", "50000");
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe("session_open");
  });

  it("plays fine in an unowned town, capped by the max_bet setting", async () => {
    const { token, playerId } = await register();
    const locationId = await seedLocation();
    await placePlayer(playerId, locationId, 1_000_000n);

    // Within the default max_bet (10,000,000) and no house at all.
    const ok = await play(token, "blackjack", "50000");
    expect(ok.statusCode).toBe(200);

    // A second, unrelated player so the wager-cap check below isn't shadowed
    // by the first player's now-open (or settled) session.
    const { token: token2, playerId: playerId2 } = await register();
    await placePlayer(playerId2, locationId, 1_000_000n);

    const overCap = await play(token2, "blackjack", "20000000");
    expect(overCap.statusCode).toBe(400);
    expect(overCap.json<{ error: string }>().error).toBe("wager_above_max");
  });
});
