import { definePlugin, InsufficientFundsError, PluginError, route } from "@gl3/plugin-sdk";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { FastifyInstance } from "fastify";
import postgres from "postgres";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfig } from "../src/config.js";
import * as schema from "../src/db/schema/index.js";
import { locations, notifications, playerStats, transactions } from "../src/db/schema/index.js";
import { lockLocationsForUpdate } from "../src/economy/ledger.js";
import { testDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();

/**
 * One route exercising all four Task 0 prerequisites inside a single
 * ctx.transaction: the location lock, exp/rank-up, jailing, and notifying.
 * The response echoes back what each call returned so the test can assert
 * on both the HTTP response and (separately, via a fresh read) the
 * committed DB state.
 */
const prereqPlugin = definePlugin({
  id: "pcpp",
  version: "1.0.0",
  basePaths: ["/api/pcpp"],
  routes: [
    route({
      method: "POST",
      path: "/api/pcpp/exercise",
      body: z.object({ locationId: z.string().uuid() }),
      handler: async (ctx, { body }) => {
        const playerId = ctx.player?.id;
        if (playerId === undefined) throw new Error("expected authenticated player");
        const result = await ctx.transaction(async (tx) => {
          await tx.locks.location(body.locationId);
          const rankUp = await tx.economy.applyExpAndRankUp(playerId, 0n);
          const jailedUntil = await tx.jail.sendToJail(playerId, 60);
          await tx.notify(playerId, "hello");
          return { rankUp, jailedUntil };
        });
        return {
          status: 200,
          body: { rankUp: result.rankUp, jailedUntil: result.jailedUntil.toISOString() },
        };
      },
    }),
  ],
});

/**
 * An overdraft is the one `applyBalanceChange` failure a ported module must
 * turn into a specific HTTP response (409 for bank/travel/bullets, 400 for
 * gangs). Core's InsufficientFundsError lives in apps/server, which a plugin
 * package may not import, so the SDK exports its own and the ctx translates.
 */
const overdraftPlugin = definePlugin({
  id: "pcod",
  version: "1.0.0",
  basePaths: ["/api/pcod"],
  routes: [
    route({
      method: "POST",
      path: "/api/pcod/overdraft",
      handler: async (ctx) => {
        const playerId = ctx.player?.id;
        if (playerId === undefined) throw new Error("expected authenticated player");
        return ctx.transaction(async (tx) => {
          try {
            await tx.economy.applyBalanceChange({
              playerId, amount: -1n, kind: "cash", reason: "test.overdraft",
            });
          } catch (error) {
            if (error instanceof InsufficientFundsError) {
              throw new PluginError("insufficient_funds", 409, { kind: error.kind });
            }
            throw error;
          }
          return { status: 200, body: { ok: true } };
        });
      },
    }),
  ],
});

let app: FastifyInstance;
let closeServer: () => Promise<void>;

let regCounter = 0;

/** Register a player and return { token, playerId } — inline, same as plugin-routes.test.ts. */
async function register(target: FastifyInstance): Promise<{ token: string; playerId: string }> {
  regCounter++;
  const reg = await target.inject({
    method: "POST",
    url: "/api/auth/register",
    remoteAddress: `10.21.${regCounter >> 8 & 0xff}.${regCounter & 0xff}`,
    payload: {
      username: `PCPPUser${regCounter}`,
      password: "hunter2hunter2",
    },
  });
  return reg.json();
}

async function insertLocation(): Promise<string> {
  const id = "01920000-0000-7000-8000-0000000000" + String(regCounter).padStart(2, "0");
  await db.insert(locations).values({ id, name: `loc${regCounter}` });
  return id;
}

beforeAll(async () => {
  ({ app, close: closeServer } = await bootTestServer({ plugins: [prereqPlugin, overdraftPlugin] }));
});

afterAll(async () => {
  await closeServer();
  await conn.end();
});

describe("plugin ctx port prerequisites", () => {
  it("locks a location, applies exp/rank-up, jails, and notifies inside one transaction", async () => {
    const { token, playerId } = await register(app);
    const locationId = await insertLocation();
    const before = Date.now();

    const res = await app.inject({
      method: "POST",
      url: "/api/pcpp/exercise",
      headers: { authorization: `Bearer ${token}` },
      payload: { locationId },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.rankUp).toBeNull();
    const jailedUntil = new Date(body.jailedUntil);
    const expectedMs = before + 60_000;
    expect(Math.abs(jailedUntil.getTime() - expectedMs)).toBeLessThan(5_000);

    // Fresh reads against a separate connection — not the route's tx — to
    // confirm the writes actually committed.
    const [stats] = await db.select({ jailedUntil: playerStats.jailedUntil })
      .from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(stats?.jailedUntil).not.toBeNull();
    expect(Math.abs((stats?.jailedUntil?.getTime() ?? 0) - expectedMs)).toBeLessThan(5_000);

    const notes = await db.select().from(notifications).where(eq(notifications.playerId, playerId));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ playerId, body: "hello" });
  });
});

describe("tx.locks.locations", () => {
  // What this proves: a multi-row call (with a duplicate and a null mixed
  // in) doesn't throw, and the rows it locked are still intact and
  // readable once the transaction has committed and released its locks.
  // It does NOT prove ordering, deduplication, or null-dropping — Postgres
  // allows re-acquiring FOR UPDATE on a row a transaction already holds, so
  // a non-deduping implementation passes this unchanged, and `id = NULL`
  // locks zero rows without throwing, so a missing null-filter passes this
  // unchanged too. See the next test for those three properties.
  it("does not throw on a multi-row call with a duplicate and a null, and leaves the rows intact", async () => {
    const a = uuidv7();
    const b = uuidv7();
    await db.insert(locations).values([
      { id: a, name: "Alpha", bulletStock: 1, bulletCost: 1n },
      { id: b, name: "Beta", bulletStock: 1, bulletCost: 1n },
    ]);

    // Descending input: the helper must still lock ascending.
    const [hi, lo] = a < b ? [b, a] : [a, b];
    await db.transaction(async (tx) => {
      await lockLocationsForUpdate(tx, [hi, lo, hi, null]);
    });

    // A null-only call must not throw and must not emit a statement that
    // would lock the whole table.
    await db.transaction(async (tx) => {
      await lockLocationsForUpdate(tx, [null]);
    });

    // The rows are untouched and still readable afterwards. Scoped to this
    // test's own ids, not the whole table: the earlier "plugin ctx port
    // prerequisites" describe above inserts its own location row with no
    // cleanup in between, so the table is not empty by the time this runs.
    const rows = await db.select({ id: locations.id }).from(locations)
      .where(inArray(locations.id, [a, b]));
    expect(rows).toHaveLength(2);
  });

  // Whether lockLocationsForUpdate's internal dedupe, null-drop, and sort
  // are *observed* by the database (as opposed to merely not throwing) is
  // not visible through the row data alone — the only externally-observable
  // trace is the actual SQL Postgres receives. Modelled directly on the
  // sibling `lockPlayersForUpdate` precedent at ledger.test.ts:227-258: a
  // second real connection with the `postgres` driver's `debug` hook (a
  // genuine driver feature, not a test double) records every statement and
  // its bound params. lockLocationsForUpdate issues one `FOR UPDATE`
  // statement per row (not a single `IN (...)`, see the doc comment on the
  // helper), so a call with a duplicate and a null mixed into a descending
  // pair must still produce exactly two such statements, for the lower id
  // then the higher id, in that order — proving dedup (3 inputs collapse to
  // 2 statements), null-drop (the null never appears), and ascending order
  // (lo before hi despite descending call-site order) all at once.
  it("sends exactly one FOR UPDATE statement per distinct id, in ascending order, dropping the null", async () => {
    const a = uuidv7();
    const b = uuidv7();
    await db.insert(locations).values([
      { id: a, name: "Gamma", bulletStock: 1, bulletCost: 1n },
      { id: b, name: "Delta", bulletStock: 1, bulletCost: 1n },
    ]);
    const [hi, lo] = a < b ? [b, a] : [a, b];

    const captured: { query: string; params: unknown[] }[] = [];
    const debugSql = postgres(loadConfig(process.env).databaseUrl, {
      debug: (_conn, query, params) => { captured.push({ query, params }); },
    });
    const debugDb = drizzle(debugSql, { schema });

    try {
      await debugDb.transaction(async (tx) => {
        await lockLocationsForUpdate(tx, [hi, lo, hi, null]);
      });

      const lockQueries = captured.filter((c) => /for update/i.test(c.query));
      expect(lockQueries).toHaveLength(2);
      expect(lockQueries.map((q) => q.params)).toEqual([[lo], [hi]]);
    } finally {
      await debugSql.end();
    }
  });

  it("actually blocks a competing FOR UPDATE on one of the rows", async () => {
    const id = uuidv7();
    await db.insert(locations).values({ id, name: "Contended", bulletStock: 1, bulletCost: 1n });

    const blocker = postgres(loadConfig(process.env).databaseUrl, { max: 1 });
    const t0 = await blocker.reserve();
    try {
      await t0`BEGIN`;
      await t0`SELECT id FROM locations WHERE id = ${id}::uuid FOR UPDATE`;

      let locked = false;
      const contender = db.transaction(async (tx) => {
        await lockLocationsForUpdate(tx, [id]);
        locked = true;
      });

      await new Promise((resolve) => { setTimeout(resolve, 200); });
      expect(locked).toBe(false); // still parked on t0's lock

      await t0`ROLLBACK`;
      await contender;
      expect(locked).toBe(true);
    } finally {
      t0.release();
      await blocker.end();
    }
  });
});

describe("plugin ctx overdraft translation", () => {
  it("surfaces an overdraft as the SDK's InsufficientFundsError and rolls the transaction back", async () => {
    // A freshly registered player starts at 0 cash, so debiting 1 overdrafts.
    const { token, playerId } = await register(app);

    const res = await app.inject({
      method: "POST",
      url: "/api/pcod/overdraft",
      headers: { authorization: `Bearer ${token}` },
    });

    // 409, not 500: the plugin caught a class it is allowed to import.
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "insufficient_funds", kind: "cash" });

    // Fresh reads on a separate connection: the failed leg committed nothing.
    const [stats] = await db.select({ cash: playerStats.cash })
      .from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(stats?.cash).toBe(0n);
    expect(await db.select().from(transactions)
      .where(eq(transactions.playerId, playerId))).toHaveLength(0);
  });
});
