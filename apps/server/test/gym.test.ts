import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import gymPlugin, { trainSession } from "@gl3/plugin-gym";
import mccodesAttributes from "@gl3/plugin-mccodes-attributes";
import { playerStats } from "../src/db/schema/index.js";
import { testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();

afterAll(async () => { await conn.end(); });

/** Draws in call order: r1, r2, r3, drain, r1, r2, … */
function scripted(values: number[]): { int: (min: number, max: number) => number } {
  let i = 0;
  return { int: () => values[i++] ?? 0 };
}

describe("trainSession (pure, gym.php:46-61 verbatim)", () => {
  it("applies the per-rep formula against the live, draining will", () => {
    // Rep 1: (2/900)*1000 * (100+20)/150, drain 3. Rep 2: (1/1000)*800 * (97+20)/150, drain 5.
    const out = trainSession(scripted([2, 900, 1000, 3, 1, 1000, 800, 5]), 100, 2);
    expect(out.gain).toBeCloseTo((2 / 900) * 1000 * (120 / 150) + (1 / 1000) * 800 * (117 / 150), 10);
    expect(out.willDrained).toBe(8);
  });

  it("floors the will drain at zero", () => {
    const out = trainSession(scripted([1, 900, 900, 3, 1, 900, 900, 3]), 1, 2);
    // Rep 1 drains min(3, 1) = 1; rep 2 drains min(3, 0) = 0, and its gain
    // multiplier uses will 0: (0+20)/150.
    expect(out.willDrained).toBe(1);
    expect(out.gain).toBeCloseTo((1 / 900) * 900 * (21 / 150) + (1 / 900) * 900 * (20 / 150), 10);
  });
});

describe("gym plugin", () => {
  it("trains: spends energy, drains will, raises the stat", async () => {
    const server = await bootTestServer({ plugins: [mccodesAttributes, gymPlugin] });
    try {
      const { token, playerId } = await registerVerifiedPlayer(server, { remoteAddress: "10.11.1.1" });
      const auth = { authorization: `Bearer ${token}` };

      const res = await server.app.inject({
        method: "POST", url: "/api/gym/train", headers: auth,
        payload: { stat: "strength", reps: 10 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().energySpent).toBe(10);
      expect(Number(res.json().gain)).toBeGreaterThan(0);

      const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
      expect(row?.energy).toBe(2);            // 12 seeded − 10 spent
      expect(row?.will).toBeLessThan(100);    // rand(1,3) per rep
      expect(row?.will).toBeGreaterThanOrEqual(70);
      expect(row?.strength).toBeGreaterThan(0n);
    } finally {
      await server.close();
    }
  });

  it("refuses a session the energy pool cannot cover, moving nothing", async () => {
    const server = await bootTestServer({ plugins: [mccodesAttributes, gymPlugin] });
    try {
      const { token, playerId } = await registerVerifiedPlayer(server, { remoteAddress: "10.11.1.2" });
      const res = await server.app.inject({
        method: "POST", url: "/api/gym/train",
        headers: { authorization: `Bearer ${token}` },
        payload: { stat: "agility", reps: 20 },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("insufficient_energy");

      const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
      expect(row?.energy).toBe(12);
      expect(row?.will).toBe(100);
      expect(row?.agility).toBe(0n);
    } finally {
      await server.close();
    }
  });

  it("trains from jail (MCCodes' jail gym) but not from hospital", async () => {
    const server = await bootTestServer({ plugins: [mccodesAttributes, gymPlugin] });
    try {
      const jailed = await registerVerifiedPlayer(server, { remoteAddress: "10.11.1.3" });
      await db.update(playerStats)
        .set({ jailedUntil: new Date(Date.now() + 300_000) })
        .where(eq(playerStats.playerId, jailed.playerId));
      const res = await server.app.inject({
        method: "POST", url: "/api/gym/train",
        headers: { authorization: `Bearer ${jailed.token}` },
        payload: { stat: "guard", reps: 5 },
      });
      expect(res.statusCode).toBe(200);

      const hospital = await registerVerifiedPlayer(server, { remoteAddress: "10.11.1.4" });
      await db.update(playerStats)
        .set({ hospitalUntil: new Date(Date.now() + 300_000) })
        .where(eq(playerStats.playerId, hospital.playerId));
      const blocked = await server.app.inject({
        method: "POST", url: "/api/gym/train",
        headers: { authorization: `Bearer ${hospital.token}` },
        payload: { stat: "guard", reps: 5 },
      });
      expect(blocked.statusCode).toBe(423);
      expect(blocked.json().error).toBe("in_hospital");
    } finally {
      await server.close();
    }
  });
});
