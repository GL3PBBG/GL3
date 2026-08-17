import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import casinoPlugin, { games, type GameDef, type GameStep } from "@gl3/plugin-casino";
import propertiesPlugin from "@gl3/plugin-properties";
import { on, PluginError, type PluginManifest } from "@gl3/plugin-sdk";
import { loadConfig } from "../src/config.js";
import { locations, players, playerStats } from "../src/db/schema/index.js";
import { runPluginMigrations } from "../src/plugins/migrate.js";
import { createRedis } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { casinoSessions } from "./helpers/plugin-tables.js";
import { callPluginRoute } from "./helpers/plugin-route.js";

/**
 * The trust boundary spec §11 risk 1 claims, tested against a game that abuses
 * it.
 *
 * §3 says a game "cannot get money wrong, because it never touches money" — it
 * returns a figure and the hub decides. That is only true if the hub BOUNDS
 * the figure. Blackjack is well-behaved, so every other test in this cluster
 * exercises the honest path; this file installs a deliberately hostile
 * `GameDef` and asserts the hub refuses it. The marketplace this SDK exists
 * for means the next game comes from a stranger.
 *
 * The rogue game's id must be `casino` — `buildRegistry` rejects a `GameDef`
 * whose id is not an installed plugin id, and `callPluginRoute` builds a ctx
 * whose installed set is the one manifest it is given.
 *
 * No `bootTestServer()`, so this file runs the casino's and properties'
 * migrations itself (NOTES.md), and a `PluginError` propagates to the caller
 * rather than becoming a status code.
 */
const { db, sql: conn } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);
const leaderboardPrefix = `casino-rogue-${uuidv7()}`;

const WAGER = 10_000n;

/** A game whose behaviour each test picks. Only the hub is under test. */
function rogueGame(over: Partial<GameDef<unknown>>): GameDef<unknown> {
  const openStep: GameStep<unknown> = {
    state: { rogue: true }, view: { kind: "text", value: "rogue" }, done: false,
  };
  return {
    id: "casino",
    name: "Rogue",
    maxPayoutMultiplier: 2,
    action: z.unknown(),
    start: () => openStep,
    act: () => openStep,
    settle: () => 0n,
    ...over,
  };
}

/** The real casino hub, with one game subscribed to its own filter point —
 *  the same route a third-party game takes. */
function casinoWith(game: GameDef<unknown>): PluginManifest {
  return { ...casinoPlugin, filters: [on(games, (_ctx, list) => [...list, game as GameDef])] };
}

async function seedPlayer(cash: bigint): Promise<{ playerId: string; locationId: string }> {
  const locationId = uuidv7();
  await db.insert(locations).values({
    id: locationId,
    name: `rogue-town-${locationId.slice(-8)}`,
    travelCost: 0n,
    travelCooldownSeconds: 60,
    bulletStock: 0,
    bulletCost: 1n,
  });
  const playerId = uuidv7();
  await db.insert(players).values({ id: playerId, username: `rogue-${playerId.slice(-8)}` });
  await db.insert(playerStats).values({ playerId, cash, locationId });
  return { playerId, locationId };
}

const cashOf = async (id: string): Promise<bigint> => {
  const [row] = await db.select({ cash: playerStats.cash }).from(playerStats).where(eq(playerStats.playerId, id));
  return row?.cash ?? 0n;
};

function play(manifest: PluginManifest, playerId: string) {
  return callPluginRoute(manifest, "POST", "/api/casino/play", {
    db, redis, leaderboardPrefix, playerId,
    body: { gameId: "casino", wager: WAGER.toString() },
  });
}

function act(manifest: PluginManifest, playerId: string) {
  return callPluginRoute(manifest, "POST", "/api/casino/act", {
    db, redis, leaderboardPrefix, playerId, body: { action: "go" },
  });
}

beforeAll(async () => {
  await resetDb(db);
  await runPluginMigrations(db, [casinoPlugin, propertiesPlugin]);
});

afterAll(async () => {
  await redis.quit();
  await conn.end();
});

describe("a game that returns a payout it is not entitled to", () => {
  it("is clamped to maxPayoutMultiplier × wager", async () => {
    const { playerId } = await seedPlayer(1_000_000n);
    // Declares 2×, settles 10× — the difference would be MINTED: the player
    // is credited in full while an owned house is only debited what it holds,
    // and in an unowned town there is no counterparty at all.
    const manifest = casinoWith(rogueGame({
      start: () => ({ state: {}, view: { kind: "text", value: "x" }, done: true }),
      settle: (_state, wager) => wager * 10n,
    }));

    const before = await cashOf(playerId);
    const result = await play(manifest, playerId);

    const body = z.object({ payout: z.string(), done: z.boolean() }).parse(result.body);
    expect(body.done).toBe(true);
    expect(body.payout).toBe((WAGER * 2n).toString());
    // Escrowed WAGER, paid back the clamped 2×: net +1× and not +9×.
    expect(await cashOf(playerId)).toBe(before + WAGER);
  });

  it("refuses a negative payout outright rather than debiting the player again", async () => {
    const { playerId } = await seedPlayer(1_000_000n);
    const manifest = casinoWith(rogueGame({
      start: () => ({ state: {}, view: { kind: "text", value: "x" }, done: true }),
      settle: () => -1n,
    }));

    const before = await cashOf(playerId);
    await expect(play(manifest, playerId)).rejects.toMatchObject({ code: "invalid_payout" });
    // The whole transaction rolls back, so even the escrow is undone.
    expect(await cashOf(playerId)).toBe(before);
  });
});

describe("a game that raises the wager by a negative amount", () => {
  it("is refused, and the hand is left exactly as it was", async () => {
    const { playerId } = await seedPlayer(1_000_000n);
    const manifest = casinoWith(rogueGame({
      // A negative delta turns `escrow` into a CREDIT to the player and drives
      // the stored wager below zero.
      act: () => ({
        state: {}, view: { kind: "text", value: "x" }, done: false, wagerDelta: -5_000n,
      }),
    }));

    await play(manifest, playerId);
    const afterPlay = await cashOf(playerId);
    const [opened] = await db.select().from(casinoSessions).where(eq(casinoSessions.playerId, playerId));
    expect(opened?.status).toBe("open");

    await expect(act(manifest, playerId)).rejects.toMatchObject({ code: "invalid_wager_delta" });

    expect(await cashOf(playerId)).toBe(afterPlay);
    const [after] = await db.select().from(casinoSessions).where(eq(casinoSessions.playerId, playerId));
    expect(after?.wager).toBe(opened?.wager);
    expect(after?.status).toBe("open");
  });
});

describe("a game whose declared multiplier is not a number", () => {
  it("answers a clean error rather than a RangeError from BigInt()", async () => {
    const { playerId } = await seedPlayer(1_000_000n);
    const manifest = casinoWith(rogueGame({ maxPayoutMultiplier: Number.NaN }));

    const error = await play(manifest, playerId).catch((e: unknown) => e);
    // `BigInt(Math.round(NaN * 10))` throws RangeError, which routes.ts
    // re-throws as a 500 with a stack trace rather than a refusal.
    expect(error).toBeInstanceOf(PluginError);
    expect(error).toMatchObject({ code: "invalid_game_multiplier" });
  });
});

describe("a game that throws", () => {
  it("becomes a clean error from `start`", async () => {
    const { playerId } = await seedPlayer(1_000_000n);
    const manifest = casinoWith(rogueGame({
      start: () => { throw new Error("dealer walked off"); },
    }));

    const error = await play(manifest, playerId).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PluginError);
    expect(error).toMatchObject({ code: "game_error" });
  });

  it("becomes a clean error from `act`", async () => {
    const { playerId } = await seedPlayer(1_000_000n);
    const manifest = casinoWith(rogueGame({
      act: () => { throw new Error("no such move"); },
    }));

    await play(manifest, playerId);
    const error = await act(manifest, playerId).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PluginError);
    expect(error).toMatchObject({ code: "game_error" });
  });
});
