import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { resolveMeleeStrike } from "@gl3/plugin-combat";
import mccodesAttributes from "@gl3/plugin-mccodes-attributes";
import { playerStats } from "../src/db/schema/index.js";
import { testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();

afterAll(async () => { await conn.end(); });

const ROLLS = { hitRoll: 0, damageRoll: 10000, critRoll: 1, critAmountRoll: 30 };

describe("resolveMeleeStrike (pure, attack.php:198-236 verbatim)", () => {
  const base = {
    power: 10, attStrength: 100, attAgility: 1000,
    defGuard: 50, defAgility: 50, targetArmor: 0,
  };

  it("computes power × strength ÷ (guard/1.5) with the ±20% swing", () => {
    // 10 × 100 / (50/1.5) = 29.999… — PHP's (int) cast and our floor both
    // yield 29. The float math is part of the parity, not an error in it.
    const out = resolveMeleeStrike(base, { ...ROLLS });
    expect(out).toMatchObject({ hit: true, crit: false, damage: 29, armorAbsorbed: 0, bulletsSpent: 0 });
  });

  it("subtracts flat armor with a minimum-1 floor", () => {
    expect(resolveMeleeStrike({ ...base, targetArmor: 25 }, { ...ROLLS }).damage).toBe(4); // 29 − 25
    const floored = resolveMeleeStrike({ ...base, targetArmor: 100 }, { ...ROLLS });
    expect(floored.damage).toBe(1);
    expect(floored.armorAbsorbed).toBe(28); // max(0, 29 − 1)
  });

  it("clamps the agility ratio to 10–95", () => {
    // 60 × 1000/50 = 1200 → clamped 95: roll 95 misses, 94 hits.
    expect(resolveMeleeStrike(base, { ...ROLLS, hitRoll: 95 }).hit).toBe(false);
    expect(resolveMeleeStrike(base, { ...ROLLS, hitRoll: 94 }).hit).toBe(true);
    // 60 × 5/100 = 3 → clamped 10: roll 5 hits despite the raw ratio.
    expect(resolveMeleeStrike({ ...base, attAgility: 5, defAgility: 100 }, { ...ROLLS, hitRoll: 5 }).hit).toBe(true);
  });

  it("applies the d40 crit table: 17 multiplies, 8 and 25 divide", () => {
    // critRoll 16 (a rolled 17) with amount 30 → ×3: 29 → 87.
    expect(resolveMeleeStrike(base, { ...ROLLS, critRoll: 16 })).toMatchObject({ crit: true, damage: 87 });
    // critRoll 7 (a rolled 8) with amount 20 → ÷2: floor(29/2) = 14.
    expect(resolveMeleeStrike(base, { ...ROLLS, critRoll: 7, critAmountRoll: 20 }).damage).toBe(14);
    expect(resolveMeleeStrike(base, { ...ROLLS, critRoll: 7, critAmountRoll: 20 }).crit).toBe(false);
  });

  it("normalizes zero defender stats in the divisors", () => {
    // guard 0 → treated as 1: 10 × 100 / (1/1.5) = 1500.
    expect(resolveMeleeStrike({ ...base, defGuard: 0 }, { ...ROLLS }).damage).toBe(1500);
  });
});

describe("melee combat + initiation energy (integration)", () => {
  it("a melee weapon hits by stats, spends no bullets, wears nothing, and initiation bills once", async () => {
    await db.execute(sql`INSERT INTO settings (key, value) VALUES ('combat.cooldown_seconds', '1')`);
    const server = await bootTestServer({ plugins: [mccodesAttributes] });
    try {
      const attacker = await registerVerifiedPlayer(server, { remoteAddress: "10.19.1.1" });
      const victim = await registerVerifiedPlayer(server, { remoteAddress: "10.19.1.2" });
      const town = crypto.randomUUID();
      await db.execute(sql`INSERT INTO locations (id, name) VALUES (${town}, ${"Meleeville"})`);

      const weaponId = crypto.randomUUID();
      const effects = JSON.stringify({ power: 10 });
      await db.execute(sql`
        INSERT INTO items (id, name, item_type, effects)
        VALUES (${weaponId}, ${"Rusty Knife"}, ${"weapon"}, ${effects}::jsonb)`);
      await db.update(playerStats).set({
        locationId: town, weaponItemId: weaponId,
        strength: 100n, agility: 1000n, exp: 1000n, level: 100, bullets: 5n,
      }).where(eq(playerStats.playerId, attacker.playerId));
      await db.update(playerStats).set({
        locationId: town, guard: 50n, agility: 50n, health: 500, exp: 1000n, level: 100,
      }).where(eq(playerStats.playerId, victim.playerId));

      const first = await server.app.inject({
        method: "POST", url: `/api/combat/attack/${victim.playerId}`,
        headers: { authorization: `Bearer ${attacker.token}` },
      });
      expect(first.statusCode).toBe(200);
      expect(first.json().bulletsSpent).toBe(0); // melee: no ammunition
      if (first.json().hit) {
        expect(first.json().damage).toBeGreaterThanOrEqual(1);
        const [v] = await db.select().from(playerStats).where(eq(playerStats.playerId, victim.playerId));
        expect(v?.health).toBeLessThan(500);
      }

      const [afterFirst] = await db.select().from(playerStats).where(eq(playerStats.playerId, attacker.playerId));
      expect(afterFirst?.energy).toBe(6);          // 12 − floor(12/2) initiation
      expect(afterFirst?.bullets).toBe(5n);        // untouched

      // No weapon wear: no condition row for a melee weapon.
      const wear = (await db.execute(
        sql`SELECT count(*)::int AS n FROM p_combat_weapon_condition WHERE player_id = ${attacker.playerId}`,
      )) as unknown as { n: number }[];
      expect(Number(wear[0]?.n ?? 0)).toBe(0);

      // The second shot inside the engagement window bills NO initiation.
      await new Promise((r) => setTimeout(r, 1200));
      const second = await server.app.inject({
        method: "POST", url: `/api/combat/attack/${victim.playerId}`,
        headers: { authorization: `Bearer ${attacker.token}` },
      });
      expect(second.statusCode).toBe(200);
      const [afterSecond] = await db.select().from(playerStats).where(eq(playerStats.playerId, attacker.playerId));
      expect(afterSecond?.energy).toBe(6);
    } finally {
      await server.close();
    }
  });

  it("refuses an attack the initiation energy cannot cover", async () => {
    const server = await bootTestServer({ plugins: [mccodesAttributes] });
    try {
      const attacker = await registerVerifiedPlayer(server, { remoteAddress: "10.19.1.3" });
      const victim = await registerVerifiedPlayer(server, { remoteAddress: "10.19.1.4" });
      const town = crypto.randomUUID();
      await db.execute(sql`INSERT INTO locations (id, name) VALUES (${town}, ${"Tiredtown"})`);
      await db.update(playerStats).set({ locationId: town, energy: 4, exp: 1000n, level: 100 })
        .where(eq(playerStats.playerId, attacker.playerId));
      await db.update(playerStats).set({ locationId: town, exp: 1000n, level: 100 })
        .where(eq(playerStats.playerId, victim.playerId));

      const res = await server.app.inject({
        method: "POST", url: `/api/combat/attack/${victim.playerId}`,
        headers: { authorization: `Bearer ${attacker.token}` },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("insufficient_energy");
    } finally {
      await server.close();
    }
  });
});
