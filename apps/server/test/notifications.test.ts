import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { notifications } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;
let token: string;
let playerId: string;
let otherToken: string;

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer, redis } = await bootTestServer());

  ({ token, playerId } = await registerVerifiedPlayer({ app, redis }, { username: "Vito" }));
  ({ token: otherToken } = await registerVerifiedPlayer({ app, redis }, { username: "Sonny" }));
});

afterAll(async () => { await closeServer(); await conn.end(); });

describe("GET /api/notifications", () => {
  it("lists this player's notifications newest first, unread by default", async () => {
    const older = uuidv7();
    await db.insert(notifications).values({ id: older, playerId, body: "older" });
    await new Promise((r) => setTimeout(r, 10));
    const newer = uuidv7();
    await db.insert(notifications).values({ id: newer, playerId, body: "newer" });

    const res = await app.inject({
      method: "GET", url: "/api/notifications", headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const { notifications: list } = res.json();
    expect(list.map((n: { id: string }) => n.id)).toEqual([newer, older]);
    expect(list[0].readAt).toBeNull();
  });

  it("401s without a token", async () => {
    expect((await app.inject({ method: "GET", url: "/api/notifications" })).statusCode).toBe(401);
  });
});

describe("POST /api/notifications/:notificationId/read", () => {
  it("marks a notification read", async () => {
    const id = uuidv7();
    await db.insert(notifications).values({ id, playerId, body: "hi" });

    const res = await app.inject({
      method: "POST", url: `/api/notifications/${id}/read`, headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(204);

    const [row] = await db.select().from(notifications).where(eq(notifications.id, id));
    expect(row?.readAt).not.toBeNull();
  });

  it("404s marking someone else's notification read", async () => {
    const id = uuidv7();
    await db.insert(notifications).values({ id, playerId, body: "hi" });

    const res = await app.inject({
      method: "POST", url: `/api/notifications/${id}/read`, headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
