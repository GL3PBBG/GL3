import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pushDevices } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let server: Awaited<ReturnType<typeof bootTestServer>>;
let closeServer: () => Promise<void>;

const TOKEN_A = "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]";
const TOKEN_B = "ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]";

beforeEach(async () => {
  await resetDb(db);
  if (!app) {
    server = await bootTestServer();
    ({ app, close: closeServer } = server);
  }
});

afterAll(async () => { await closeServer(); await conn.end(); });

/** Return type is inferred from `app.inject` — do not annotate it. */
async function registerDevice(token: string, authToken: string, platform = "android") {
  return app.inject({
    method: "POST", url: "/api/push/devices",
    headers: { authorization: `Bearer ${authToken}` },
    payload: { expoToken: token, platform },
  });
}

describe("POST /api/push/devices", () => {
  it("registers a device and answers { registered: true }", async () => {
    const player = await registerVerifiedPlayer(server);
    const response = await registerDevice(TOKEN_A, player.token);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ registered: true });

    const rows = await db.select().from(pushDevices).where(eq(pushDevices.expoToken, TOKEN_A));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.playerId).toBe(player.playerId);
    expect(rows[0]!.platform).toBe("android");
    expect(rows[0]!.disabledAt).toBeNull();
  });

  it("is idempotent on the token — a re-register refreshes rather than duplicating", async () => {
    const player = await registerVerifiedPlayer(server);
    await registerDevice(TOKEN_A, player.token);
    const [first] = await db.select().from(pushDevices).where(eq(pushDevices.expoToken, TOKEN_A));

    const again = await registerDevice(TOKEN_A, player.token);
    expect(again.statusCode).toBe(200);

    const rows = await db.select().from(pushDevices).where(eq(pushDevices.expoToken, TOKEN_A));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(first!.id);
    expect(rows[0]!.lastSeenAt.getTime()).toBeGreaterThanOrEqual(first!.lastSeenAt.getTime());
  });

  it("transfers a handset to a second player and clears disabled_at", async () => {
    const a = await registerVerifiedPlayer(server);
    const b = await registerVerifiedPlayer(server);
    await registerDevice(TOKEN_A, a.token);
    await db.update(pushDevices).set({ disabledAt: new Date() }).where(eq(pushDevices.expoToken, TOKEN_A));

    await registerDevice(TOKEN_A, b.token);

    const rows = await db.select().from(pushDevices).where(eq(pushDevices.expoToken, TOKEN_A));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.playerId).toBe(b.playerId);
    expect(rows[0]!.disabledAt).toBeNull();
  });

  it("400s a token that is not an Expo push token", async () => {
    const player = await registerVerifiedPlayer(server);
    const response = await registerDevice("not-a-token", player.token);
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("invalid_request");
    expect(await db.select().from(pushDevices)).toHaveLength(0);
  });

  it("401s without a session", async () => {
    const response = await app.inject({
      method: "POST", url: "/api/push/devices",
      payload: { expoToken: TOKEN_A, platform: "android" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("logs a device registration with a token prefix, never the full token", async () => {
    // Under NODE_ENV=test, Fastify's logger is `abstract-logging` with
    // `logger.child = () => logger` (apps/server/src/app.ts:57), so
    // `app.log` IS `request.log` for the life of this boot — spying on
    // `app.log.info` observes the route's own log call.
    const infoSpy = vi.spyOn(app.log, "info");
    const player = await registerVerifiedPlayer(server);

    await registerDevice(TOKEN_A, player.token);

    const call = infoSpy.mock.calls.find(([, msg]) => msg === "push device registered");
    expect(call).toBeDefined();
    const [obj] = call!;
    expect(obj).toMatchObject({ playerId: player.playerId, platform: "android", tokenPrefix: TOKEN_A.slice(0, 20) });
    expect(JSON.stringify(obj)).not.toContain(TOKEN_A);

    infoSpy.mockRestore();
  });

  it("403s email_unverified — device registration is not on GATE_EXEMPT", async () => {
    const register = await app.inject({
      method: "POST", url: "/api/auth/register",
      payload: { username: `pu_${Date.now()}`, email: `pu${Date.now()}@x.com`, password: "password123" },
    });
    expect(register.statusCode).toBe(201);
    const { token } = register.json() as { token: string };

    const response = await registerDevice(TOKEN_A, token);
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("email_unverified");
    expect(await db.select().from(pushDevices)).toHaveLength(0);
  });
});

describe("DELETE /api/push/devices/:token", () => {
  it("removes the caller's own device and answers 204", async () => {
    const player = await registerVerifiedPlayer(server);
    await registerDevice(TOKEN_A, player.token);

    const response = await app.inject({
      method: "DELETE", url: `/api/push/devices/${encodeURIComponent(TOKEN_A)}`,
      headers: { authorization: `Bearer ${player.token}` },
    });

    expect(response.statusCode).toBe(204);
    expect(await db.select().from(pushDevices)).toHaveLength(0);
  });

  it("never deletes another player's device", async () => {
    const a = await registerVerifiedPlayer(server);
    const b = await registerVerifiedPlayer(server);
    await registerDevice(TOKEN_A, a.token);
    await registerDevice(TOKEN_B, b.token);

    const response = await app.inject({
      method: "DELETE", url: `/api/push/devices/${encodeURIComponent(TOKEN_A)}`,
      headers: { authorization: `Bearer ${b.token}` },
    });

    expect(response.statusCode).toBe(204); // 204 either way — sign-out must not fail
    const surviving = await db.select().from(pushDevices)
      .where(and(eq(pushDevices.expoToken, TOKEN_A), eq(pushDevices.playerId, a.playerId)));
    expect(surviving).toHaveLength(1);
  });

  it("204s for a token that was never registered", async () => {
    const player = await registerVerifiedPlayer(server);
    const response = await app.inject({
      method: "DELETE", url: `/api/push/devices/${encodeURIComponent(TOKEN_B)}`,
      headers: { authorization: `Bearer ${player.token}` },
    });
    expect(response.statusCode).toBe(204);
  });

  it("401s without a session", async () => {
    const response = await app.inject({
      method: "DELETE", url: `/api/push/devices/${encodeURIComponent(TOKEN_A)}`,
    });
    expect(response.statusCode).toBe(401);
  });
});
