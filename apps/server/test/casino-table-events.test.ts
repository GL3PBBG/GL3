import { GameEventSchema, PluginsPayloadSchema, type GameEvent } from "@gl3/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { loadConfig } from "../src/config.js";
import { locations, playerStats } from "../src/db/schema/index.js";
import { createSubscriber } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { propertiesPlugin as propertiesTable } from "./helpers/plugin-tables.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";
import { awaitOwnEvent } from "./helpers/events.js";

/**
 * The casino hub's one event: a SILENT `table` tick, published to every seat
 * at the end of a mutating table transaction (`publishTableTick`).
 *
 * Two properties, and they are separate places in the system. On the WIRE the
 * tick is an ordinary `plugin.event` — nothing about it says "silent", because
 * silence is not a property of an event, it is a property of its DECLARATION.
 * The declaration reaches the client through `GET /api/plugins`, which is why
 * the manifest case below is not decoration: without `silent: true` there the
 * feed would render a line per transition per seat, which is exactly why the
 * table shipped on a poll and no events at all.
 *
 * Recipients are the seat set before the change UNIONED with the seat set
 * after it, which the leave case below is the point of: a freed seat appears
 * in neither the response nor the post-change set, and is the client with the
 * stalest cache.
 *
 * RULE 4 THROUGHOUT: `game:events` is one global channel shared by every test
 * file in the run, so every assertion here filters by the ACTING player's own
 * id. That filter is also what makes the recipient set assertable — every tick
 * one transaction produces carries the caller as actor and one seat as
 * audience, so collecting the actor's own traffic yields exactly that table's
 * recipients.
 */
const { db, sql: conn } = testDb();
const redisUrl = loadConfig(process.env).redisUrl;
const subscriber = createSubscriber(redisUrl);

let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;

let regCounter = 0;

async function register(): Promise<{ token: string; playerId: string; username: string }> {
  regCounter += 1;
  return registerVerifiedPlayer({ app, redis }, {
    username: `Ticker${regCounter}`,
    remoteAddress: `10.67.${(regCounter >> 8) & 0xff}.${regCounter & 0xff}`,
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

/** `cost` is the owner's lever; a solvent house so no bet is refused. */
async function seedHouse(locationId: string, ownerId: string): Promise<string> {
  const id = uuidv7();
  await db.insert(propertiesTable).values({
    id, locationId, pluginId: "blackjack", ownerPlayerId: ownerId, cost: 200_000n, profit: 0n,
  });
  return id;
}

async function placePlayer(playerId: string, locationId: string, cash: bigint): Promise<void> {
  await db.update(playerStats)
    .set({ locationId, cash, jailedUntil: null, hospitalUntil: null })
    .where(eq(playerStats.playerId, playerId));
}

function sit(token: string, gameId = "blackjack") {
  return app.inject({
    method: "POST", url: "/api/casino/table/sit",
    headers: { authorization: `Bearer ${token}` }, payload: { gameId },
  });
}

function bet(token: string, wager: bigint) {
  return app.inject({
    method: "POST", url: "/api/casino/table/bet",
    headers: { authorization: `Bearer ${token}` }, payload: { wager: String(wager) },
  });
}

function leave(token: string) {
  return app.inject({
    method: "POST", url: "/api/casino/table/leave",
    headers: { authorization: `Bearer ${token}` }, payload: {},
  });
}

/** `casino-table-clock.test.ts`'s opener: a town with a solvent house and
 *  `count` players seated at one table there. */
async function seatTable(count: number): Promise<{
  tableId: string; locationId: string;
  players: { token: string; playerId: string; username: string }[];
}> {
  const locationId = await seedLocation();
  const { playerId: ownerId } = await register();
  await seedHouse(locationId, ownerId);
  await placePlayer(ownerId, locationId, 10_000_000n);

  const players: { token: string; playerId: string; username: string }[] = [];
  let tableId = "";
  for (let i = 0; i < count; i += 1) {
    const p = await register();
    await placePlayer(p.playerId, locationId, 1_000_000n);
    const res = await sit(p.token);
    expect(res.statusCode).toBe(200);
    const body = res.json<{ tableId: string; seat: number }>();
    if (i === 0) tableId = body.tableId;
    expect(body.tableId).toBe(tableId);
    players.push(p);
  }
  return { tableId, locationId, players };
}

type PluginEnvelope = Extract<GameEvent, { type: "plugin.event" }>;

const isTableTick = (event: GameEvent): event is PluginEnvelope =>
  event.type === "plugin.event" && event.pluginId === "casino" && event.name === "table";

/**
 * `awaitOwnEvent`'s collecting twin: resolves as soon as `expected` table ticks
 * naming `actorId` have arrived, and rejects at `timeoutMs` naming what it did
 * get. Needed because one table transaction publishes N ticks with the SAME
 * actor and different audiences, and `awaitOwnEvent` settles on the first.
 *
 * COUNT-DRIVEN, NOT WINDOW-DRIVEN, and that is the whole point of the shape.
 * A fixed window opened before the request is a bet on how long that request
 * takes under load, which is how a test like this goes flaky on a busy box
 * (NOTES.md: flaky means broken). The count is known exactly — it is the seat
 * set the case constructed — so the happy path never waits at all and the
 * deadline is only ever the failure path.
 *
 * Same rule-4 filter as `awaitOwnEvent` and the same
 * `GameEventSchema.safeParse` on the way in, so another file's traffic is
 * discarded rather than asserted against.
 */
function collectOwnTicks(
  actorId: string, expected: number, timeoutMs = 5000,
): Promise<PluginEnvelope[]> {
  return new Promise((resolve, reject) => {
    const seen: PluginEnvelope[] = [];
    const finish = (): void => {
      clearTimeout(timer);
      subscriber.off("message", onMessage);
    };
    const onMessage = (channel: string, raw: string): void => {
      if (channel !== GAME_EVENTS_CHANNEL) return;
      const parsed = GameEventSchema.safeParse(JSON.parse(raw));
      if (!parsed.success || parsed.data.actorId !== actorId) return;
      if (!isTableTick(parsed.data)) return;
      seen.push(parsed.data);
      if (seen.length >= expected) {
        finish();
        resolve(seen);
      }
    };
    const timer = setTimeout(() => {
      finish();
      reject(new Error(
        `collectOwnTicks: wanted ${expected} table ticks for ${actorId} within `
        + `${timeoutMs}ms, got ${seen.length} (${tickedPlayerIds(seen).join(", ")})`,
      ));
    }, timeoutMs);
    subscriber.on("message", onMessage);
  });
}

/**
 * Marks a pending expectation as handled the moment it is created.
 *
 * Both helpers above reject on a deadline, and every case here creates them
 * BEFORE the request whose events they are waiting for. If an assertion
 * between those two points fails, the promise is still pending and nothing
 * ever awaits it — vitest would report the real assertion failure and then, up
 * to five seconds later, an unhandled rejection attributed to whichever test
 * happened to be running by then. Attaching a no-op handler leaves `await`
 * behaving exactly as before (the promise still rejects for the awaiting
 * caller) while making that phantom failure impossible.
 */
function armed<T>(pending: Promise<T>): Promise<T> {
  pending.catch(() => undefined);
  return pending;
}

/** The audience player ids of the ticks in `events`, sorted for comparison. */
function tickedPlayerIds(events: readonly GameEvent[]): string[] {
  return events
    .filter(isTableTick)
    .map((e) => (e.audience.kind === "player" ? e.audience.playerId : "NOT-A-PLAYER-AUDIENCE"))
    .sort();
}

beforeAll(async () => {
  await resetDb(db);
  ({ app, close: closeServer, redis } = await bootTestServer());
  await subscriber.subscribe(GAME_EVENTS_CHANNEL);
});

afterAll(async () => {
  await closeServer?.();
  await conn.end();
  subscriber.disconnect();
});

describe("the table event's manifest declaration", () => {
  it("reaches the client marked silent, with the casino invalidation prefix", async () => {
    const { token } = await register();
    const res = await app.inject({
      method: "GET", url: "/api/plugins", headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);

    // Parsed with the DTO the browser parses with: `PluginsPayloadSchema` is
    // all-or-nothing, so a `silent` the shared schema did not know about would
    // take the whole plugin payload down rather than being ignored.
    const payload = PluginsPayloadSchema.parse(res.json());
    const meta = payload.events.find((e) => e.pluginId === "casino" && e.name === "table");
    expect(meta).toBeDefined();
    expect(meta?.silent).toBe(true);
    expect(meta?.invalidates).toEqual(["casino"]);
    // Required of every declaration, silent or not: a client that predates the
    // flag renders this rather than failing.
    expect(meta?.describe).not.toBe("");
  });
});

describe("POST /api/casino/table/bet", () => {
  it("ticks every seat at the table, the bettor included", async () => {
    const { tableId, players } = await seatTable(2);
    const [a, b] = players as [typeof players[0], typeof players[0]];

    // Two seats, so two ticks — the count the collector waits for.
    const collected = armed(collectOwnTicks(a.playerId, 2));
    const first = armed(awaitOwnEvent(subscriber, a.playerId));

    expect((await bet(a.token, 10_000n)).statusCode).toBe(200);

    // The envelope, on the wire: an ordinary `plugin.event`. Nothing here says
    // "silent" — that lives in the manifest, asserted above.
    expect(GameEventSchema.parse(await first)).toMatchObject({
      type: "plugin.event",
      pluginId: "casino",
      name: "table",
      actorId: a.playerId,
      payload: { tableId },
    });

    const ticks = await collected;
    expect(tickedPlayerIds(ticks)).toEqual([a.playerId, b.playerId].sort());
    // The actor is the CALLER for every one of them, including the tick
    // addressed to the seat that did not act.
    for (const tick of ticks) {
      expect(tick.actorId).toBe(a.playerId);
      expect(tick.payload).toEqual({ tableId });
    }
  });

  it("does not tick a player seated at a different table", async () => {
    const { players } = await seatTable(2);
    const [a] = players as [typeof players[0], typeof players[0]];

    // A whole other town, so a whole other table — the bet below is none of
    // this player's business.
    const elsewhere = await seatTable(1);
    const outsider = elsewhere.players[0]!;

    // Both of a's own table's ticks, then the assertion: the outsider is not
    // among the recipients, and there is nothing left in flight that could
    // still name them.
    const collected = armed(collectOwnTicks(a.playerId, 2));
    expect((await bet(a.token, 10_000n)).statusCode).toBe(200);

    const recipients = tickedPlayerIds(await collected);
    expect(recipients).toEqual(players.map((p) => p.playerId).sort());
    expect(recipients).not.toContain(outsider.playerId);
  });
});

describe("POST /api/casino/table/leave", () => {
  /**
   * The union half of the recipient set, and the case that decides it. The
   * seat this transaction FREED is not in the post-change set at all, and it
   * is the client whose cache is now most wrong — it still holds a
   * `casinoTable` entry for a table the player has left. Recipients are
   * therefore pre ∪ post, so the leaver hears about their own leave.
   */
  it("ticks the leaver as well as the seats they left behind", async () => {
    const { tableId, players } = await seatTable(2);
    const [a, b] = players as [typeof players[0], typeof players[0]];

    // Two, not one: the seat that stays AND the seat this leave frees.
    const collected = armed(collectOwnTicks(b.playerId, 2));

    // No stake anywhere, so this is the wager-0 fast exit: the seat is freed
    // in this request rather than deferred to a settle.
    const res = await leave(b.token);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ left: boolean; deferred: boolean }>()).toEqual({ left: true, deferred: false });

    const ticks = await collected;
    expect(tickedPlayerIds(ticks)).toEqual([a.playerId, b.playerId].sort());
    for (const tick of ticks) {
      expect(tick.actorId).toBe(b.playerId);
      expect(tick.payload).toEqual({ tableId });
    }
  });
});

describe("POST /api/casino/table/sit", () => {
  it("ticks the seats already at the table plus the arriving player", async () => {
    const { tableId, locationId, players } = await seatTable(1);
    const [seated] = players as [typeof players[0]];

    const arriving = await register();
    await placePlayer(arriving.playerId, locationId, 1_000_000n);

    // The seat already there plus the arriving caller.
    const collected = armed(collectOwnTicks(arriving.playerId, 2));

    const res = await sit(arriving.token);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ tableId: string }>().tableId).toBe(tableId);

    const ticks = await collected;
    expect(tickedPlayerIds(ticks)).toEqual([seated.playerId, arriving.playerId].sort());
  });
});
