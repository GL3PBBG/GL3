import { definePlugin, filterPoint, on, route, type FilterPoint } from "@gl3/plugin-sdk";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { createSubscriber } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { awaitOwnEvent } from "./helpers/events.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
const redisUrl = loadConfig(process.env).redisUrl;
const subscriber = createSubscriber(redisUrl);
let app: FastifyInstance;
let closeServer: () => Promise<void>;
let redis: Redis;

/**
 * The point "applier" owns and "subscriber" subscribes to. `"propagate"`
 * because there is nothing here to collect through — a single subscriber
 * either runs or the chain throws.
 */
const hookPoint: FilterPoint<string> = filterPoint<string>("applier.hook", "propagate");

const applierPlugin = definePlugin({
  id: "applier",
  version: "1.0.0",
  basePaths: ["/api/applier"],
  routes: [
    route({
      method: "POST",
      path: "/api/applier/run",
      handler: async (ctx) => {
        const result = await ctx.filters.apply(hookPoint, "initial");
        return { status: 200, body: { result } };
      },
    }),
  ],
});

const subscriberPlugin = definePlugin({
  id: "subscriber",
  version: "1.0.0",
  basePaths: ["/api/subscriber"],
  filters: [
    on(hookPoint, async (ctx, value) => {
      const playerId = ctx.player?.id;
      if (playerId !== undefined) {
        await ctx.transaction(async (tx) => {
          await tx.events.publish({
            name: "subscriber.fired",
            actorId: playerId,
            actorName: ctx.player?.username ?? "unknown",
            audience: { kind: "global" },
            payload: { seenValue: value },
          });
        });
      }
      // Returning ctx.pluginId (not the incoming value) is the assertion:
      // it can only be "subscriber" if this callback ran under ITS OWN
      // plugin's ctx, not the applier's.
      return ctx.pluginId;
    }),
  ],
});

beforeEach(async () => {
  await resetDb(db);
  ({ app, close: closeServer, redis } = await bootTestServer({ plugins: [applierPlugin, subscriberPlugin] }));
});

afterAll(async () => {
  // closeServer() already disconnects the app's own redis (see
  // bootTestServer's `close`) — only the subscriber connection is ours.
  await closeServer();
  await conn.end();
  subscriber.disconnect();
});

describe("each filter subscriber runs under its own plugin's ctx", () => {
  it("returns the subscriber's own pluginId and attributes its published event to it", async () => {
    await subscriber.subscribe(GAME_EVENTS_CHANNEL);
    const { token, playerId } = await registerVerifiedPlayer({ app, redis }, { username: "Nazorine" });

    const watch = awaitOwnEvent(subscriber, playerId);

    const res = await app.inject({
      method: "POST",
      url: "/api/applier/run",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().result).toBe("subscriber");

    const event = await watch;
    if (event.type !== "plugin.event") throw new Error(`expected plugin.event, got ${event.type}`);
    expect(event.pluginId).toBe("subscriber");
    expect(event.name).toBe("subscriber.fired");
  });
});
