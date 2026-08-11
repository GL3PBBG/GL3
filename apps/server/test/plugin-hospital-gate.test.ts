import { definePlugin, route } from "@gl3/plugin-sdk";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { playerStats } from "../src/db/schema/index.js";
import { bootTestServer } from "./helpers/server.js";
import { testDb } from "./helpers/db.js";

const gatedRoute = route({
  method: "POST",
  path: "/api/gate-probe/act",
  accessInHospital: false,
  handler: async () => ({ status: 200, body: { ok: true } }),
});

const openRoute = route({
  method: "GET",
  path: "/api/gate-probe/read",
  handler: async () => ({ status: 200, body: { ok: true } }),
});

const probePlugin = definePlugin({
  id: "gate-probe",
  version: "1.0.0",
  basePaths: ["/api/gate-probe"],
  routes: [gatedRoute, openRoute],
});

describe("accessInHospital gate", () => {
  let app: FastifyInstance;
  let close: () => Promise<void>;
  let token: string;
  let playerId: string;

  beforeAll(async () => {
    ({ app, close } = await bootTestServer({ plugins: [probePlugin] }));
    const res = await app.inject({
      method: "POST", url: "/api/auth/register",
      // uuidv7's first 8 hex chars are timestamp bits that barely change
      // across a fast run — slice the tail, not the head, for uniqueness
      // (see hospital-status.test.ts, Task 3).
      payload: { username: `hosp-${Date.now()}`, password: "correct horse battery" },
    });
    // /api/auth/register answers { token, playerId, username } (auth/routes.ts)
    // — not a nested `player` object.
    const body = res.json();
    token = body.token;
    playerId = body.playerId;
  });

  afterAll(async () => { await close(); });

  it("defaults to true — an ungated route answers while hospitalised", async () => {
    const { db } = await testDb();
    await db.update(playerStats)
      .set({ hospitalUntil: new Date(Date.now() + 60_000), health: 0 })
      .where(eq(playerStats.playerId, playerId));

    const res = await app.inject({
      method: "GET", url: "/api/gate-probe/read",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("answers 423 with retry-after when the route opts out", async () => {
    const { db } = await testDb();
    await db.update(playerStats)
      .set({ hospitalUntil: new Date(Date.now() + 60_000), health: 0 })
      .where(eq(playerStats.playerId, playerId));

    const res = await app.inject({
      method: "POST", url: "/api/gate-probe/act",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(423);
    expect(res.json()).toMatchObject({ error: "hospitalised" });
    expect(res.headers["retry-after"]).toBeDefined();
  });

  it("settles an elapsed sentence and lets the request through", async () => {
    const { db } = await testDb();
    await db.update(playerStats)
      .set({ hospitalUntil: new Date(Date.now() - 1000), health: 0 })
      .where(eq(playerStats.playerId, playerId));

    const res = await app.inject({
      method: "POST", url: "/api/gate-probe/act",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(row?.hospitalUntil).toBeNull();
    expect(row?.health).toBe(100);
  });
});
