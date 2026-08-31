import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { players } from "../src/db/schema/index.js";
import { testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * Layer 0 of the anti-bot cluster: `players.signup_ip` / `players.last_ip`
 * (migration 0022). The IP recorded is `clientIp(request, config.clientIpHeader)`
 * — the header path itself is unit-tested in rate-limit.test.ts, so these
 * tests drive the socket-address fallback via inject's `remoteAddress`.
 */
const server = await bootTestServer();
const { db, sql } = testDb();

afterAll(async () => {
  await server.close();
  await sql.end();
});

async function ipRow(playerId: string): Promise<{ signupIp: string | null; lastIp: string | null }> {
  const [row] = await db.select({ signupIp: players.signupIp, lastIp: players.lastIp })
    .from(players).where(eq(players.id, playerId));
  if (row === undefined) throw new Error("player row missing");
  return row;
}

describe("ip telemetry", () => {
  it("register stamps signup_ip and last_ip from the client address", async () => {
    const { playerId } = await registerVerifiedPlayer(server, { remoteAddress: "203.0.113.9" });
    const row = await ipRow(playerId);
    expect(row.signupIp).toBe("203.0.113.9");
    expect(row.lastIp).toBe("203.0.113.9");
  });

  it("login updates last_ip and leaves signup_ip alone", async () => {
    const { playerId, username } = await registerVerifiedPlayer(server, { remoteAddress: "203.0.113.9" });
    const login = await server.app.inject({
      method: "POST", url: "/api/auth/login", remoteAddress: "198.51.100.7",
      payload: { username, password: "password123" },
    });
    expect(login.statusCode).toBe(200);
    const row = await ipRow(playerId);
    expect(row.signupIp).toBe("203.0.113.9");
    expect(row.lastIp).toBe("198.51.100.7");
  });

  it("an authenticated request refreshes last_ip through the presence touch", async () => {
    const { playerId, token } = await registerVerifiedPlayer(server, { remoteAddress: "203.0.113.9" });
    // The last_seen stamp is throttled by SET NX EX 60; clear the marker so
    // THIS request takes the write path rather than the throttled no-op.
    await server.redis.del(`lastseenmark:${playerId}`);
    const me = await server.app.inject({
      method: "GET", url: "/api/auth/me", remoteAddress: "192.0.2.55",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(200);
    const row = await ipRow(playerId);
    expect(row.lastIp).toBe("192.0.2.55");
  });
});
