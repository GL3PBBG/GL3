import { definePlugin, route } from "@gl3/plugin-sdk";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { locations, notifications, playerStats } from "../src/db/schema/index.js";
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
  ({ app, close: closeServer } = await bootTestServer({ plugins: [prereqPlugin] }));
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
