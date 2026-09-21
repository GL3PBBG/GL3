import { definePlugin, route } from "@gl3/plugin-sdk";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { locations, playerStats } from "../src/db/schema/index.js";
import { seedLocations } from "../src/db/seed.js";
import { resetDb, testDb } from "./helpers/db.js";
import { propertiesPlugin as propertiesTable } from "./helpers/plugin-tables.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();

const VenueProbeParamsSchema = z.object({ venue: z.string() });

/** A fixture route that answers the ctx predicate and the tx predicate for the caller's town. */
const probe = definePlugin({
  id: "vprobe",
  version: "1.0.0",
  apiVersion: 1,
  basePaths: ["/api/vprobe"],
  requires: ["properties"],
  routes: [
    route({
      method: "GET",
      path: "/api/vprobe/:venue",
      params: VenueProbeParamsSchema,
      handler: async (ctx, { params }) => {
        if (ctx.player === null) throw new Error("unauthorized");
        const [row] = await ctx.transaction((tx) =>
          tx.db.select({ locationId: playerStats.locationId }).from(playerStats).where(eq(playerStats.playerId, ctx.player!.id)),
        );
        const locationId = row?.locationId ?? null;
        if (locationId === null) return { status: 200, body: { ctx: false, tx: false } };
        const viaCtx = await ctx.venues.has(locationId, params.venue);
        const viaTx = await ctx.transaction((tx) => tx.venues.has(locationId, params.venue));
        return { status: 200, body: { ctx: viaCtx, tx: viaTx } };
      },
    }),
  ],
});

let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;

beforeAll(async () => {
  ({ app, close: closeServer, redis } = await bootTestServer({ plugins: [probe] }));
});

beforeEach(async () => {
  await resetDb(db);
  await seedLocations(db);
});

afterAll(async () => {
  await closeServer();
  await conn.end();
});

const townId = async (name: string) =>
  (await db.select({ id: locations.id }).from(locations).where(eq(locations.name, name)))[0]!.id;

describe("ctx.venues.has / tx.venues.has (spec §2)", () => {
  it("answers false with no row, true for a state-run row, true for an owned row, false for another type", async () => {
    const p = await registerVerifiedPlayer({ app, redis });
    const chicago = await townId("Chicago");
    await db.update(playerStats).set({ locationId: chicago }).where(eq(playerStats.playerId, p.playerId));

    const get = (venue: string) =>
      app.inject({ method: "GET", url: `/api/vprobe/${venue}`, headers: { authorization: `Bearer ${p.token}` } });

    expect((await get("blackjack")).json()).toEqual({ ctx: false, tx: false });

    await db.insert(propertiesTable).values({
      id: uuidv7(),
      locationId: chicago,
      pluginId: "blackjack",
      ownerPlayerId: null,
      cost: 0n,
      profit: 0n,
    });
    expect((await get("blackjack")).json()).toEqual({ ctx: true, tx: true });
    expect((await get("brothel")).json()).toEqual({ ctx: false, tx: false });

    await db.update(propertiesTable).set({ ownerPlayerId: p.playerId }).where(eq(propertiesTable.pluginId, "blackjack"));
    expect((await get("blackjack")).json()).toEqual({ ctx: true, tx: true });
  });
});
