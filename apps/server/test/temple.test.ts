import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import mccodesAttributes from "@gl3/plugin-mccodes-attributes";
import templePlugin from "@gl3/plugin-temple";
import { playerStats, settings } from "../src/db/schema/index.js";
import { testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();

afterAll(async () => { await conn.end(); });

async function grantPoints(playerId: string, points: bigint): Promise<void> {
  await db.update(playerStats).set({ points }).where(eq(playerStats.playerId, playerId));
}

describe("temple plugin (default rates: 12 refill / 5 iq / 200 money per point)", () => {
  it("refills energy to max for the configured points, once", async () => {
    const server = await bootTestServer({ plugins: [mccodesAttributes, templePlugin] });
    try {
      const { token, playerId } = await registerVerifiedPlayer(server, { remoteAddress: "10.16.1.1" });
      const auth = { authorization: `Bearer ${token}` };
      await grantPoints(playerId, 100n);
      await db.update(playerStats).set({ energy: 4 }).where(eq(playerStats.playerId, playerId));

      const res = await server.app.inject({ method: "POST", url: "/api/temple/refill", headers: auth });
      expect(res.statusCode).toBe(200);
      expect(res.json().energy).toBe(12);

      const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
      expect(row?.energy).toBe(12);
      expect(row?.points).toBe(88n);

      const again = await server.app.inject({ method: "POST", url: "/api/temple/refill", headers: auth });
      expect(again.statusCode).toBe(409);
      expect(again.json().error).toBe("already_full");
    } finally {
      await server.close();
    }
  });

  it("sells IQ and money at the configured per-point rates, ledgered", async () => {
    const server = await bootTestServer({ plugins: [mccodesAttributes, templePlugin] });
    try {
      const { token, playerId } = await registerVerifiedPlayer(server, { remoteAddress: "10.16.1.2" });
      const auth = { authorization: `Bearer ${token}` };
      await grantPoints(playerId, 100n);

      const iq = await server.app.inject({
        method: "POST", url: "/api/temple/iq", headers: auth, payload: { points: "4" },
      });
      expect(iq.statusCode).toBe(200);
      expect(iq.json().iq).toBe("20");

      const money = await server.app.inject({
        method: "POST", url: "/api/temple/money", headers: auth, payload: { points: "3" },
      });
      expect(money.statusCode).toBe(200);
      expect(money.json().cash).toBe("600");

      const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
      expect(row?.iq).toBe(20n);
      expect(row?.cash).toBe(600n);
      expect(row?.points).toBe(93n); // 100 - 4 - 3
    } finally {
      await server.close();
    }
  });

  it("refuses a purchase the points balance cannot cover", async () => {
    const server = await bootTestServer({ plugins: [mccodesAttributes, templePlugin] });
    try {
      const { token } = await registerVerifiedPlayer(server, { remoteAddress: "10.16.1.3" });
      const res = await server.app.inject({
        method: "POST", url: "/api/temple/money",
        headers: { authorization: `Bearer ${token}` },
        payload: { points: "1" },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("insufficient_points");
    } finally {
      await server.close();
    }
  });

  it("temple.exchanges gates each exchange: absent entries 403, listed ones stay live", async () => {
    // The gl3 curation seam (gl3-hybrid spec §2): the profile seeds
    // "refill", turning off points -> IQ and points -> cash.
    await db.insert(settings).values({ key: "temple.exchanges", value: "refill" })
      .onConflictDoUpdate({ target: settings.key, set: { value: "refill" } });
    const server = await bootTestServer({ plugins: [mccodesAttributes, templePlugin] });
    try {
      const { token, playerId } = await registerVerifiedPlayer(server, { remoteAddress: "10.16.1.4" });
      const auth = { authorization: `Bearer ${token}` };
      await grantPoints(playerId, 100n);
      await db.update(playerStats).set({ energy: 4 }).where(eq(playerStats.playerId, playerId));

      const money = await server.app.inject({
        method: "POST", url: "/api/temple/money", headers: auth, payload: { points: "1" },
      });
      expect(money.statusCode).toBe(403);
      expect(money.json().error).toBe("exchange_disabled");

      const iq = await server.app.inject({
        method: "POST", url: "/api/temple/iq", headers: auth, payload: { points: "1" },
      });
      expect(iq.statusCode).toBe(403);
      expect(iq.json().error).toBe("exchange_disabled");

      const refill = await server.app.inject({ method: "POST", url: "/api/temple/refill", headers: auth });
      expect(refill.statusCode).toBe(200);
    } finally {
      await db.delete(settings).where(eq(settings.key, "temple.exchanges"));
      await server.close();
    }
    // The unset default serves all three — every case above this one runs
    // without the setting and already proves it.
  });

  it("refuses to boot without the anchor — the opt-in property at the loader", async () => {
    // The `energy_not_declared` route guard is defense-in-depth, but a
    // temple-without-anchor boot cannot be constructed to reach it: the
    // loader's requires enforcement fails first, which is the stronger
    // guarantee and the one worth pinning.
    await expect(bootTestServer({ plugins: [templePlugin] })).rejects.toThrow(
      /requires plugin "mccodes-attributes"/,
    );
  });
});
