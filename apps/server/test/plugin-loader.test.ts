import helloPlugin from "@gl3/hello-plugin";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { loadConfig } from "../src/config.js";
import { loadPlugins } from "../src/plugins/loader.js";
import { createRedis, createSubscriber } from "../src/redis.js";
import { testDb } from "./helpers/db.js";
import { awaitOwnEvent } from "./helpers/events.js";
import { bootTestServer } from "./helpers/server.js";

// testDb() returns createDb's { db, sql } pair, NOT a drizzle db — calling it
// as one fails with TypeError. There is no testRedis helper anywhere in this
// repo; open a Redis client the way test/bank.test.ts does. Both are opened
// ONCE at module scope: calling testDb() per test would open a new Postgres
// pool each time and leak it.
const { db, sql: conn } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);
const subscriber = createSubscriber(loadConfig(process.env).redisUrl);

afterAll(async () => {
  await conn.end();
  redis.disconnect();
  subscriber.disconnect();
});

const deps = () => ({ db, redis, queues: new Map(), settings: {} });

let regCounter = 0;

/** Register a player and return { token, playerId } — inline because no shared factories file exists. */
function register(app: FastifyInstance): Promise<{ token: string; playerId: string }> {
  regCounter++;
  return app
    .inject({
      method: "POST",
      url: "/api/auth/register",
      // Distinct IP per registration to keep this file's rate-limit bucket private.
      remoteAddress: `10.13.${regCounter >> 8 & 0xff}.${regCounter & 0xff}`,
      payload: {
        username: `HPLUser${regCounter}`,
        password: "hunter2hunter2",
      },
    })
    .then((res) => res.json() as { token: string; playerId: string });
}

describe("hello-plugin end to end", () => {
  it("applies its migration once across two boots", async () => {
    await loadPlugins(deps(), [helloPlugin]);
    await loadPlugins(deps(), [helloPlugin]);
    await db.execute(sql`select 1 from p_hello_greetings limit 1`);
  });

  it("contributes a menu entry to /api/plugins", async () => {
    const { app, close } = await bootTestServer({ plugins: [helloPlugin] });
    try {
      const { token } = await register(app);
      const res = await app.inject({
        method: "GET",
        url: "/api/plugins",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.json().menu).toContainEqual(expect.objectContaining({ label: "Hello", path: "/hello" }));
    } finally {
      await close();
    }
  });

  it("serves its route and publishes its event on the bus", async () => {
    const { app, close } = await bootTestServer({ plugins: [helloPlugin] });
    try {
      const { token, playerId } = await register(app);
      await subscriber.subscribe(GAME_EVENTS_CHANNEL);
      const received = awaitOwnEvent(subscriber, playerId);

      const res = await app.inject({
        method: "POST",
        url: "/api/hello/greet",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ greetings: 1 });

      const event = await received;
      expect(event).toMatchObject({ type: "plugin.event", pluginId: "hello", name: "greeted" });
    } finally {
      await close();
      await subscriber.unsubscribe(GAME_EVENTS_CHANNEL);
    }
  });

  it("counts repeat greetings in the plugin's own table", async () => {
    const { app, close } = await bootTestServer({ plugins: [helloPlugin] });
    try {
      const { token } = await register(app);
      await app.inject({
        method: "POST",
        url: "/api/hello/greet",
        headers: { authorization: `Bearer ${token}` },
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/hello/greet",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.json()).toEqual({ greetings: 2 });
    } finally {
      await close();
    }
  });

  it("rejects a plugin whose basePath collides with core", async () => {
    const evil = {
      ...helloPlugin,
      id: "evil",
      basePaths: ["/api/auth"],
      tables: {},
      migrations: [],
    };
    // Strip tables/migrations from the spread clone so the table-prefix check
    // does not fire first (validate.ts checks table names before basePaths).
    // The whole message, not /reserved/: this isolates exactly one failure.
    await expect(loadPlugins(deps(), [evil])).rejects.toThrow(
      'plugin validation failed — plugin "evil" claims "/api/auth", which is reserved to core',
    );
  });
});
