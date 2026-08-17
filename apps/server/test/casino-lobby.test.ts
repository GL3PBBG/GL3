import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminPage as casinoAdminPage } from "@gl3/plugin-casino";
import { locations, playerStats } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { casinoSessions, propertiesPlugin as propertiesTable } from "./helpers/plugin-tables.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * GET /api/casino (the lobby), the lazy forfeit of an abandoned hand, and the
 * casino's admin section.
 *
 * Runs against the real installed `blackjack` game through a bare
 * `bootTestServer()`, the shape `casino-play.test.ts` established.
 *
 * The lobby is read-only and takes no locks; the forfeit is a write and lives
 * inside `play`'s transaction, taking the session row FOR UPDATE as the third
 * and last step of the lock order `casino-lock-order.test.ts` pins. Nothing
 * here re-proves that ordering — this file is about behaviour.
 */
const { db, sql: conn } = testDb();

let app: FastifyInstance;
let closeServer: () => Promise<void>;
/** The first player registered after `resetDb` becomes the Administrator. */
let adminToken: string;

let regCounter = 0;

async function register(): Promise<{ token: string; playerId: string; username: string }> {
  regCounter += 1;
  const username = `Punter${regCounter}`;
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    // Registration is rate-limited per IP and the app is booted once, so every
    // registration in this file needs its own address.
    remoteAddress: `10.63.${(regCounter >> 8) & 0xff}.${regCounter & 0xff}`,
    payload: { username, password: "hunter2hunter2" },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json<{ token: string; playerId: string }>();
  return { ...body, username };
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

/** `casino-play.test.ts`'s `seedHouse`: `cost` is the owner's lever, 0n = unset. */
async function seedHouse(
  locationId: string, ownerId: string | null, cost: bigint, profit = 0n,
): Promise<string> {
  const id = uuidv7();
  await db.insert(propertiesTable).values({
    id, locationId, pluginId: "blackjack", ownerPlayerId: ownerId, cost, profit,
  });
  return id;
}

async function placePlayer(playerId: string, locationId: string, cash: bigint): Promise<void> {
  await db.update(playerStats).set({ locationId, cash }).where(eq(playerStats.playerId, playerId));
}

const cashOf = async (id: string): Promise<bigint> => {
  const [row] = await db.select({ cash: playerStats.cash }).from(playerStats).where(eq(playerStats.playerId, id));
  return row?.cash ?? 0n;
};

const profitOf = async (propertyId: string): Promise<bigint> => {
  const [row] = await db.select().from(propertiesTable).where(eq(propertiesTable.id, propertyId));
  return row?.profit ?? 0n;
};

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

function play(token: string, gameId: string, wager: string) {
  return app.inject({
    method: "POST", url: "/api/casino/play", headers: auth(token), payload: { gameId, wager },
  });
}

function lobby(token: string) {
  return app.inject({ method: "GET", url: "/api/casino", headers: auth(token) });
}

interface LobbyGame { gameId: string; name: string; ownerName: string | null; maxBet: string }
interface LobbySession {
  sessionId: string; gameId: string; gameName: string; wager: string; view: unknown; expiresAt: string;
}
interface LobbyBody {
  locationId: string; locationName: string; minBet: string;
  games: LobbyGame[]; session: LobbySession | null;
}

/**
 * Plays until a hand STAYS open, and answers what `play` returned for it.
 *
 * Blackjack's `start` settles immediately on a natural dealt from a real
 * `node:crypto` shoe (either side, roughly one hand in eleven), and a settled
 * hand blocks nothing — so retrying is sound and keeps the session's `state`
 * a real one written by the real route rather than a hand-built fixture. The
 * cap is not a flake budget: eleven consecutive naturals is a shuffle bug, not
 * bad luck (`casino-play.test.ts`'s "flaky means broken" note).
 */
async function openHand(token: string, wager: string): Promise<{ sessionId: string; view: unknown }> {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const res = await play(token, "blackjack", wager);
    expect(res.statusCode, `play body: ${res.body}`).toBe(200);
    const body = res.json<{ sessionId: string; view: unknown; done: boolean }>();
    if (!body.done) return { sessionId: body.sessionId, view: body.view };
  }
  throw new Error("25 hands in a row settled at deal — that is a shuffle bug, not a flake");
}

beforeAll(async () => {
  await resetDb(db);
  ({ app, close: closeServer } = await bootTestServer());
  // FIRST registration in this file, so this is the Administrator.
  adminToken = (await register()).token;
});

afterAll(async () => {
  await closeServer?.();
  await conn.end();
});

describe("GET /api/casino", () => {
  it("lists every installed game with its house owner and max bet for the player's town", async () => {
    const punter = await register();
    const owner = await register();
    const locationId = await seedLocation();
    await seedHouse(locationId, owner.playerId, 50_000n); // lever: max bet 50,000
    await placePlayer(punter.playerId, locationId, 1_000_000n);
    await placePlayer(owner.playerId, locationId, 10_000_000n);

    const res = await lobby(punter.token);
    expect(res.statusCode).toBe(200);
    const body = res.json<LobbyBody>();

    expect(body.locationId).toBe(locationId);
    expect(body.locationName).toMatch(/^city-/);
    expect(body.minBet).toBe("10000"); // the default min_bet
    // Every game the registry holds, which on this branch is exactly one.
    expect(body.games.map((game) => game.gameId)).toEqual(["blackjack"]);
    expect(body.games[0]).toEqual({
      gameId: "blackjack",
      name: "Blackjack",
      ownerName: owner.username,
      // The owner's lever IS the maximum bet (V2 blackjack.inc.php:276), and
      // money crosses the wire as a decimal string.
      maxBet: "50000",
    });
    expect(body.session).toBeNull();
  });

  it("falls back to the max_bet setting in a town with no owner", async () => {
    const punter = await register();
    const locationId = await seedLocation();
    await placePlayer(punter.playerId, locationId, 1_000_000n);

    const unowned = await lobby(punter.token);
    expect(unowned.statusCode).toBe(200);
    expect(unowned.json<LobbyBody>().games[0]).toMatchObject({
      ownerName: null,
      maxBet: "10000000", // DEFAULT_MAX_BET — nobody's lever applies
    });

    // A property row that exists but is UNOWNED is the same case: the
    // franchise design keeps unregistered and unowned rows alive, and
    // `ownerAt` answers null for both.
    await seedHouse(locationId, null, 50_000n);
    const stillUnowned = await lobby(punter.token);
    expect(stillUnowned.json<LobbyBody>().games[0]).toMatchObject({
      ownerName: null,
      maxBet: "10000000",
    });
  });

  it("returns the player's open hand with its current view", async () => {
    const punter = await register();
    const locationId = await seedLocation();
    await placePlayer(punter.playerId, locationId, 1_000_000n);

    const hand = await openHand(punter.token, "100000");

    const res = await lobby(punter.token);
    expect(res.statusCode).toBe(200);
    const session = res.json<LobbyBody>().session;
    expect(session).not.toBeNull();
    expect(session?.sessionId).toBe(hand.sessionId);
    expect(session?.gameId).toBe("blackjack");
    expect(session?.gameName).toBe("Blackjack");
    expect(session?.wager).toBe("100000");
    // The SAME view `play` answered with, re-rendered from the stored state by
    // the game's own `view`. Equality is the assertion that matters: a resume
    // that draws a different hand from the one dealt is the bug this catches.
    expect(session?.view).toEqual(hand.view);
    // A view the player can actually be shown — cards, not an empty node.
    expect(JSON.stringify(session?.view)).toContain("\"cards\"");
    expect(new Date(session?.expiresAt ?? 0).getTime()).toBeGreaterThan(Date.now());
  });

  it("409s a player who is nowhere, the answer play gives", async () => {
    const nowhere = await register();
    const res = await lobby(nowhere.token);
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe("no_location");
  });
});

describe("the lazy forfeit", () => {
  it("forfeits a hand older than session_expiry_minutes on the next play", async () => {
    const punter = await register();
    const owner = await register();
    const locationId = await seedLocation();
    // `profit` is seeded to the stale wager: the house was paid it at the play
    // that opened the abandoned hand, so this is the state a real abandonment
    // leaves behind. Nothing below may give any of it back.
    const STALE_WAGER = 250_000n;
    const propertyId = await seedHouse(locationId, owner.playerId, 0n, STALE_WAGER);
    await placePlayer(punter.playerId, locationId, 1_000_000n);
    await placePlayer(owner.playerId, locationId, 10_000_000n);

    const staleId = uuidv7();
    await db.insert(casinoSessions).values({
      id: staleId,
      playerId: punter.playerId,
      gameId: "blackjack",
      locationId,
      propertyId,
      wager: STALE_WAGER,
      state: {},
      status: "open",
      seed: "stale",
      // Default session_expiry_minutes is 30.
      createdAt: new Date(Date.now() - 45 * 60_000),
    });

    // The lobby does not offer a Resume for a hand that is already forfeit.
    expect((await lobby(punter.token)).json<LobbyBody>().session).toBeNull();

    const punterCashBefore = await cashOf(punter.playerId);
    const ownerCashBefore = await cashOf(owner.playerId);

    const res = await play(punter.token, "blackjack", "100000");
    expect(res.statusCode, `play body: ${res.body}`).toBe(200);
    const body = res.json<{ sessionId: string; done: boolean; payout?: string }>();
    expect(body.sessionId).not.toBe(staleId);

    // The stale hand is settled, and settled is all it is: its wager is
    // untouched, because a forfeit moves no money — the wager left the player
    // at the `play` that opened it and is already the house's.
    const [stale] = await db.select().from(casinoSessions).where(eq(casinoSessions.id, staleId));
    expect(stale?.status).toBe("settled");
    expect(stale?.settledAt).not.toBeNull();
    expect(stale?.wager).toBe(STALE_WAGER);

    // The ONLY money that moved is the new hand's own escrow (and its payout,
    // if `start` dealt a natural — `casino-play.test.ts`'s net-from-the-body
    // idiom, which keeps this deterministic against a real shuffle).
    const net = body.done ? BigInt(body.payout ?? "0") - 100_000n : -100_000n;
    expect(await cashOf(punter.playerId)).toBe(punterCashBefore + net);
    expect(await cashOf(owner.playerId)).toBe(ownerCashBefore - net);
    // Not `STALE_WAGER - net + something`: the forfeited wager stays on the
    // house's books exactly as it was.
    expect(await profitOf(propertyId)).toBe(STALE_WAGER - net);

    // Exactly one hand exists per play, and at most one of them is open.
    const rows = await db.select().from(casinoSessions).where(eq(casinoSessions.playerId, punter.playerId));
    expect(rows).toHaveLength(2);
    const open = rows.filter((row) => row.status === "open");
    // Zero when the new hand dealt a natural and settled inside `play`.
    expect(open).toHaveLength(body.done ? 0 : 1);
    if (!body.done) expect(open[0]?.id).toBe(body.sessionId);
  });

  it("still refuses a second play while a hand is live", async () => {
    const punter = await register();
    const locationId = await seedLocation();
    await placePlayer(punter.playerId, locationId, 1_000_000n);

    // One minute old, well inside the 30-minute expiry: the forfeit branch
    // must not fire, or every open hand would be forfeitable immediately.
    await db.insert(casinoSessions).values({
      id: uuidv7(),
      playerId: punter.playerId,
      gameId: "blackjack",
      locationId,
      propertyId: null,
      wager: 50_000n,
      state: {},
      status: "open",
      seed: "fresh",
      createdAt: new Date(Date.now() - 60_000),
    });

    const res = await play(punter.token, "blackjack", "50000");
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe("session_open");
  });
});

describe("the casino admin section", () => {
  const ADMIN_ROUTES = ["/api/admin/casino", "/api/admin/casino/settings"] as const;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /** `admin-ids-hidden.test.ts`'s walker, applied to this one page. */
  function tableColumnKeys(node: unknown): string[] {
    if (typeof node !== "object" || node === null) return [];
    const keys: string[] = [];
    if ("kind" in node && node.kind === "table" && "columns" in node && Array.isArray(node.columns)) {
      for (const column of node.columns) {
        if (typeof column === "object" && column !== null && "key" in column) keys.push(String(column.key));
      }
    }
    for (const field of ["children", "items"] as const) {
      if (field in node && Array.isArray(node[field])) {
        for (const child of node[field] as unknown[]) keys.push(...tableColumnKeys(child));
      }
    }
    return keys;
  }

  it("403s a non-admin on both routes", async () => {
    const pleb = await register();
    for (const url of ADMIN_ROUTES) {
      const res = await app.inject({ method: "GET", url, headers: auth(pleb.token) });
      expect(res.statusCode, url).toBe(403);
    }
  });

  it("declares no id column and serves no UUID in either payload", async () => {
    // The page: no column key is an id at all. This section has no form, so
    // there is not even a `valueKey` for one to travel in.
    const columns = tableColumnKeys(casinoAdminPage.view);
    expect(columns.length).toBeGreaterThan(0);
    expect(columns.filter((key) => /^id$|Id$/.test(key))).toEqual([]);

    // The payload: a UUID cannot reach the table even by accident. Seeded with
    // a live hand so the sessions table has a row whose player, town and
    // property are all uuid-keyed in the database.
    const punter = await register();
    const owner = await register();
    const locationId = await seedLocation();
    await seedHouse(locationId, owner.playerId, 0n);
    await placePlayer(punter.playerId, locationId, 1_000_000n);
    await placePlayer(owner.playerId, locationId, 10_000_000n);
    await openHand(punter.token, "100000");

    for (const url of ADMIN_ROUTES) {
      const res = await app.inject({ method: "GET", url, headers: auth(adminToken) });
      expect(res.statusCode, url).toBe(200);
      const rows = res.json<{ rows: Record<string, unknown>[] }>().rows;
      expect(rows.length, url).toBeGreaterThan(0);
      for (const row of rows) {
        for (const [key, value] of Object.entries(row)) {
          expect(typeof value === "string" && UUID_RE.test(value), `${url} ${key}=${String(value)}`).toBe(false);
        }
      }
    }
  });

  it("reports the three settings in force and where each came from", async () => {
    const res = await app.inject({
      method: "GET", url: "/api/admin/casino/settings", headers: auth(adminToken),
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json<{ rows: { key: string; label: string; value: string; source: string }[] }>().rows;
    expect(rows.map((row) => row.key)).toEqual(["min_bet", "max_bet", "session_expiry_minutes"]);
    // No settings rows are seeded, so every one of them is the coded default.
    expect(rows.map((row) => row.value)).toEqual(["10000", "10000000", "30"]);
    expect(rows.map((row) => row.source)).toEqual(["default", "default", "default"]);
  });

  it("lists open hands, marking the stale ones", async () => {
    const punter = await register();
    const locationId = await seedLocation();
    await placePlayer(punter.playerId, locationId, 1_000_000n);
    await db.insert(casinoSessions).values({
      id: uuidv7(),
      playerId: punter.playerId,
      gameId: "blackjack",
      locationId,
      propertyId: null,
      wager: 123_000n,
      state: {},
      status: "open",
      seed: "abandoned",
      createdAt: new Date(Date.now() - 90 * 60_000),
    });

    const res = await app.inject({ method: "GET", url: "/api/admin/casino", headers: auth(adminToken) });
    expect(res.statusCode).toBe(200);
    const rows = res.json<{ rows: { game: string; player: string; town: string; wager: string; stale: string }[] }>().rows;

    const mine = rows.find((row) => row.player === punter.username);
    expect(mine).toBeDefined();
    expect(mine).toMatchObject({
      game: "Blackjack",     // the registry's display name, not the raw id
      wager: "123000",       // a decimal string, never a JSON number
      stale: "yes",
    });
    expect(mine?.town).toMatch(/^city-/);

    // A settled hand is not an open hand: the list is what is on the tables.
    const settledId = uuidv7();
    await db.insert(casinoSessions).values({
      id: settledId,
      playerId: punter.playerId,
      gameId: "blackjack",
      locationId,
      propertyId: null,
      wager: 999_000n,
      state: {},
      status: "settled",
      seed: "done",
      settledAt: new Date(),
    });
    const after = await app.inject({ method: "GET", url: "/api/admin/casino", headers: auth(adminToken) });
    expect(after.json<{ rows: { wager: string }[] }>().rows.map((row) => row.wager)).not.toContain("999000");
  });
});
