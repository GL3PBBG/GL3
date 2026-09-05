import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import mccodesAttributes from "@gl3/plugin-mccodes-attributes";
import { playerStats } from "../src/db/schema/index.js";
import { testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * B0 Task 3 (spec 2026-08-26-mccodes-migrator-design §2.1): the melee-only
 * second weapon slot's precedence. Slot 1 (the firearm slot) is authoritative
 * when armed — a gun there resolves the action byte-identically whether the
 * melee slot holds anything or not. The melee slot fires only when slot 1 is
 * empty AND its row is a melee model; anything else in it (a hand-edited
 * non-melee row) means fists, never a firearm firing from the melee slot.
 */
const { db, sql: conn } = testDb();

afterAll(async () => { await conn.end(); });

async function insertItem(effects: Record<string, unknown>, name: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.execute(sql`
    INSERT INTO items (id, name, item_type, effects)
    VALUES (${id}, ${name}, ${"weapon"}, ${JSON.stringify(effects)}::jsonb)`);
  return id;
}

describe("combat melee-slot precedence (B0)", () => {
  it("both armed: the firearm resolves — gun numbers exactly, melee inert", async () => {
    await db.execute(sql`INSERT INTO settings (key, value) VALUES ('combat.cooldown_seconds', '1') ON CONFLICT (key) DO NOTHING`);
    const server = await bootTestServer({ plugins: [mccodesAttributes] });
    try {
      const attacker = await registerVerifiedPlayer(server, { remoteAddress: "10.21.1.1" });
      const victim = await registerVerifiedPlayer(server, { remoteAddress: "10.21.1.2" });
      const town = crypto.randomUUID();
      await db.execute(sql`INSERT INTO locations (id, name) VALUES (${town}, ${"Slotville"})`);

      const gun = await insertItem(
        { backfireChance: 0, accuracy: 100, damageMin: 10, damageMax: 10 }, "Slot 1 Pistol");
      const knife = await insertItem({ power: 10 }, "Slot 2 Knife");
      await db.update(playerStats).set({
        locationId: town, weaponItemId: gun, weaponMeleeItemId: knife,
        strength: 100n, agility: 1000n, exp: 1000n, level: 100, bullets: 5n, energy: 12,
      }).where(eq(playerStats.playerId, attacker.playerId));
      await db.update(playerStats).set({
        locationId: town, guard: 50n, agility: 50n, health: 500, exp: 1000n, level: 100,
      }).where(eq(playerStats.playerId, victim.playerId));

      const res = await server.app.inject({
        method: "POST", url: `/api/combat/attack/${victim.playerId}`,
        headers: { authorization: `Bearer ${attacker.token}` },
      });
      expect(res.statusCode).toBe(200);
      // Firearm numbers, not melee stats: exactly 10 damage (accuracy 100),
      // exactly 1 bullet — the melee profile would spend 0 and damage by
      // power×strength÷(guard/1.5) = 29.
      expect(res.json().hit).toBe(true);
      expect(res.json().damage).toBe(10);
      expect(res.json().bulletsSpent).toBe(1);
      expect(res.json().weapon).toBe("firearm");
      expect(res.json().weaponName).toBe("Slot 1 Pistol");
      const [v] = await db.select().from(playerStats).where(eq(playerStats.playerId, victim.playerId));
      expect(v?.health).toBe(490);

      const log = (await db.execute(sql`
        SELECT weapon_item_id FROM p_combat_log
        WHERE attacker_id = ${attacker.playerId} ORDER BY created_at DESC LIMIT 1`,
      )) as unknown as { weapon_item_id: string }[];
      expect(log[0]?.weapon_item_id).toBe(gun);
    } finally {
      await server.close();
    }
  });

  it("slot 1 empty + melee in slot 2: the C6 melee arm fires with that weapon", async () => {
    await db.execute(sql`INSERT INTO settings (key, value) VALUES ('combat.cooldown_seconds', '1') ON CONFLICT (key) DO NOTHING`);
    const server = await bootTestServer({ plugins: [mccodesAttributes] });
    try {
      const attacker = await registerVerifiedPlayer(server, { remoteAddress: "10.21.1.3" });
      const victim = await registerVerifiedPlayer(server, { remoteAddress: "10.21.1.4" });
      const town = crypto.randomUUID();
      await db.execute(sql`INSERT INTO locations (id, name) VALUES (${town}, ${"Offhandton"})`);

      const knife = await insertItem({ power: 10 }, "Offhand Knife");
      await db.update(playerStats).set({
        locationId: town, weaponMeleeItemId: knife,
        strength: 100n, agility: 1000n, exp: 1000n, level: 100, bullets: 5n,
      }).where(eq(playerStats.playerId, attacker.playerId));
      await db.update(playerStats).set({
        locationId: town, guard: 50n, agility: 50n, health: 500, exp: 1000n, level: 100,
      }).where(eq(playerStats.playerId, victim.playerId));

      const res = await server.app.inject({
        method: "POST", url: `/api/combat/attack/${victim.playerId}`,
        headers: { authorization: `Bearer ${attacker.token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().bulletsSpent).toBe(0); // melee never spends ammunition
      expect(res.json().weapon).toBe("melee");
      expect(res.json().weaponName).toBe("Offhand Knife");
      if (res.json().hit) {
        // Base 10 × 100 / (50/1.5) floors to 29 before the ±20% swing, so
        // 23–36 uncritted; the d40 crit table can multiply up to ×4.1. The
        // exact numbers are unit-pinned in combat-melee.test.ts — the route
        // draws its own rolls, so this asserts the bounds and the ledger.
        const damage = res.json().damage as number;
        expect(damage).toBeGreaterThanOrEqual(23);
        expect(damage).toBeLessThanOrEqual(147);
        const [v] = await db.select().from(playerStats).where(eq(playerStats.playerId, victim.playerId));
        expect(v?.health).toBe(500 - damage);
      }

      const [after] = await db.select().from(playerStats).where(eq(playerStats.playerId, attacker.playerId));
      expect(after?.bullets).toBe(5n); // untouched

      // The log credits the weapon that actually resolved.
      const log = (await db.execute(sql`
        SELECT weapon_item_id FROM p_combat_log
        WHERE attacker_id = ${attacker.playerId} ORDER BY created_at DESC LIMIT 1`,
      )) as unknown as { weapon_item_id: string }[];
      expect(log[0]?.weapon_item_id).toBe(knife);
    } finally {
      await server.close();
    }
  });

  it("a non-melee row in the melee slot means fists, never a firearm from slot 2", async () => {
    await db.execute(sql`INSERT INTO settings (key, value) VALUES ('combat.cooldown_seconds', '1') ON CONFLICT (key) DO NOTHING`);
    const server = await bootTestServer({ plugins: [mccodesAttributes] });
    try {
      const attacker = await registerVerifiedPlayer(server, { remoteAddress: "10.21.1.5" });
      const victim = await registerVerifiedPlayer(server, { remoteAddress: "10.21.1.6" });
      const town = crypto.randomUUID();
      await db.execute(sql`INSERT INTO locations (id, name) VALUES (${town}, ${"Fistton"})`);

      // Hand-edited gun in the melee slot — the equip route refuses this, so
      // only a direct DB write can produce it (the external-boundary case).
      const smuggled = await insertItem(
        { backfireChance: 0, accuracy: 100, damageMin: 99, damageMax: 99 }, "Smuggled Pistol");
      await db.update(playerStats).set({
        locationId: town, weaponMeleeItemId: smuggled,
        strength: 100n, agility: 1000n, exp: 1000n, level: 100, bullets: 5n,
      }).where(eq(playerStats.playerId, attacker.playerId));
      await db.update(playerStats).set({
        locationId: town, guard: 50n, agility: 50n, health: 500, exp: 1000n, level: 100,
      }).where(eq(playerStats.playerId, victim.playerId));

      const res = await server.app.inject({
        method: "POST", url: `/api/combat/attack/${victim.playerId}`,
        headers: { authorization: `Bearer ${attacker.token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().weapon).toBe("fists");
      expect(res.json().weaponName).toBeNull();
      if (res.json().hit) {
        // Unarmed damage, never the smuggled 99.
        expect(res.json().damage).toBeLessThan(99);
      }
      const log = (await db.execute(sql`
        SELECT weapon_item_id FROM p_combat_log
        WHERE attacker_id = ${attacker.playerId} ORDER BY created_at DESC LIMIT 1`,
      )) as unknown as { weapon_item_id: string | null }[];
      expect(log[0]?.weapon_item_id).toBeNull();
    } finally {
      await server.close();
    }
  });
});

/**
 * Fists as a melee model: `combat.unarmed.model = melee` makes an empty
 * pair of slots resolve through the stat-driven arm with
 * `combat.unarmed.power`, spending no bullets. The default model stays
 * firearm — `combat.test.ts`'s unarmed cases are the byte-identical proof.
 */
describe("fists under combat.unarmed.model = melee", () => {
  async function bootMeleeFists(ip1: string, ip2: string, town: string) {
    await db.execute(sql`INSERT INTO settings (key, value) VALUES
      ('combat.cooldown_seconds', '1'), ('combat.unarmed.model', 'melee'), ('combat.unarmed.power', '2')
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    const server = await bootTestServer({ plugins: [mccodesAttributes] });
    const attacker = await registerVerifiedPlayer(server, { remoteAddress: ip1 });
    const victim = await registerVerifiedPlayer(server, { remoteAddress: ip2 });
    const townId = crypto.randomUUID();
    await db.execute(sql`INSERT INTO locations (id, name) VALUES (${townId}, ${town})`);
    await db.update(playerStats).set({
      locationId: townId, weaponItemId: null, weaponMeleeItemId: null,
      strength: 100n, agility: 1000n, exp: 1000n, level: 100, bullets: 5n, energy: 12,
    }).where(eq(playerStats.playerId, attacker.playerId));
    await db.update(playerStats).set({
      locationId: townId, guard: 50n, agility: 50n, health: 500, exp: 1000n, level: 100,
    }).where(eq(playerStats.playerId, victim.playerId));
    return { server, attacker, victim };
  }

  it("resolves fists by the stats, spends no bullets, credits no item", async () => {
    const { server, attacker, victim } = await bootMeleeFists("10.21.3.1", "10.21.3.2", "Fistmelee");
    try {
      const res = await server.app.inject({
        method: "POST", url: `/api/combat/attack/${victim.playerId}`,
        headers: { authorization: `Bearer ${attacker.token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().weapon).toBe("fists");
      expect(res.json().weaponName).toBeNull();
      expect(res.json().bulletsSpent).toBe(0);
      if (res.json().hit) {
        // power 2 × 100 / (50/1.5) = 6 before the ±20% swing (4–7), the d40
        // crit up to ×4.1 — never the firearm model's flat 1–5 with a bullet.
        expect(res.json().damage).toBeGreaterThanOrEqual(1);
        expect(res.json().damage).toBeLessThanOrEqual(29);
      }
      const [after] = await db.select().from(playerStats).where(eq(playerStats.playerId, attacker.playerId));
      expect(after?.bullets).toBe(5n);
      const log = (await db.execute(sql`
        SELECT weapon_item_id FROM p_combat_log
        WHERE attacker_id = ${attacker.playerId} ORDER BY created_at DESC LIMIT 1`,
      )) as unknown as { weapon_item_id: string | null }[];
      expect(log[0]?.weapon_item_id).toBeNull();
    } finally {
      await server.close();
    }
  });

  it("weapon=firearm with both slots empty is still fists, melee-resolved, no bullet", async () => {
    const { server, attacker, victim } = await bootMeleeFists("10.21.3.3", "10.21.3.4", "Fistchoice");
    try {
      const res = await server.app.inject({
        method: "POST", url: `/api/combat/attack/${victim.playerId}`,
        headers: { authorization: `Bearer ${attacker.token}` },
        payload: { weapon: "firearm" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().weapon).toBe("fists");
      expect(res.json().bulletsSpent).toBe(0);
    } finally {
      await server.close();
    }
  });
});

/**
 * The per-attack choice: an optional `weapon` body field overrides the
 * precedence above. Absent keeps it byte-identical (the three cases above
 * send no body at all). `melee` needs the melee slot armed; `firearm` is
 * slot 1 whatever it holds — fists when empty, exactly like today.
 */
describe("POST /api/combat/attack — the weapon choice", () => {
  async function armBoth(ip1: string, ip2: string, town: string) {
    await db.execute(sql`INSERT INTO settings (key, value) VALUES ('combat.cooldown_seconds', '1') ON CONFLICT (key) DO NOTHING`);
    const server = await bootTestServer({ plugins: [mccodesAttributes] });
    const attacker = await registerVerifiedPlayer(server, { remoteAddress: ip1 });
    const victim = await registerVerifiedPlayer(server, { remoteAddress: ip2 });
    const townId = crypto.randomUUID();
    await db.execute(sql`INSERT INTO locations (id, name) VALUES (${townId}, ${town})`);
    const gun = await insertItem(
      { backfireChance: 0, accuracy: 100, damageMin: 10, damageMax: 10 }, "Choice Pistol");
    const knife = await insertItem({ power: 10 }, "Choice Knife");
    await db.update(playerStats).set({
      locationId: townId, weaponItemId: gun, weaponMeleeItemId: knife,
      strength: 100n, agility: 1000n, exp: 1000n, level: 100, bullets: 5n, energy: 12,
    }).where(eq(playerStats.playerId, attacker.playerId));
    await db.update(playerStats).set({
      locationId: townId, guard: 50n, agility: 50n, health: 500, exp: 1000n, level: 100,
    }).where(eq(playerStats.playerId, victim.playerId));
    return { server, attacker, victim, gun, knife };
  }

  it("both armed + weapon=melee: the melee slot fires, the gun stays holstered", async () => {
    const { server, attacker, victim, knife } = await armBoth("10.21.2.1", "10.21.2.2", "Choicetown");
    try {
      const res = await server.app.inject({
        method: "POST", url: `/api/combat/attack/${victim.playerId}`,
        headers: { authorization: `Bearer ${attacker.token}` },
        payload: { weapon: "melee" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().weapon).toBe("melee");
      expect(res.json().weaponName).toBe("Choice Knife");
      expect(res.json().bulletsSpent).toBe(0);
      const [after] = await db.select().from(playerStats).where(eq(playerStats.playerId, attacker.playerId));
      expect(after?.bullets).toBe(5n);
      const log = (await db.execute(sql`
        SELECT weapon_item_id FROM p_combat_log
        WHERE attacker_id = ${attacker.playerId} ORDER BY created_at DESC LIMIT 1`,
      )) as unknown as { weapon_item_id: string }[];
      expect(log[0]?.weapon_item_id).toBe(knife);
    } finally {
      await server.close();
    }
  });

  it("both armed + weapon=firearm: the gun fires — the same numbers as no choice at all", async () => {
    const { server, attacker, victim, gun } = await armBoth("10.21.2.3", "10.21.2.4", "Gunchoice");
    try {
      const res = await server.app.inject({
        method: "POST", url: `/api/combat/attack/${victim.playerId}`,
        headers: { authorization: `Bearer ${attacker.token}` },
        payload: { weapon: "firearm" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().weapon).toBe("firearm");
      expect(res.json().damage).toBe(10);
      expect(res.json().bulletsSpent).toBe(1);
      const log = (await db.execute(sql`
        SELECT weapon_item_id FROM p_combat_log
        WHERE attacker_id = ${attacker.playerId} ORDER BY created_at DESC LIMIT 1`,
      )) as unknown as { weapon_item_id: string }[];
      expect(log[0]?.weapon_item_id).toBe(gun);
    } finally {
      await server.close();
    }
  });

  it("weapon=melee with an empty melee slot 409s no_melee_weapon and fires nothing", async () => {
    const { server, attacker, victim } = await armBoth("10.21.2.5", "10.21.2.6", "Nomelee");
    try {
      await db.update(playerStats).set({ weaponMeleeItemId: null })
        .where(eq(playerStats.playerId, attacker.playerId));
      const res = await server.app.inject({
        method: "POST", url: `/api/combat/attack/${victim.playerId}`,
        headers: { authorization: `Bearer ${attacker.token}` },
        payload: { weapon: "melee" },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: "no_melee_weapon" });
      const [v] = await db.select().from(playerStats).where(eq(playerStats.playerId, victim.playerId));
      expect(v?.health).toBe(500);
      const [after] = await db.select().from(playerStats).where(eq(playerStats.playerId, attacker.playerId));
      expect(after?.bullets).toBe(5n);
    } finally {
      await server.close();
    }
  });

  it("400s an unknown weapon choice before the cooldown or any lock", async () => {
    const { server, attacker, victim } = await armBoth("10.21.2.7", "10.21.2.8", "Badchoice");
    try {
      const res = await server.app.inject({
        method: "POST", url: `/api/combat/attack/${victim.playerId}`,
        headers: { authorization: `Bearer ${attacker.token}` },
        payload: { weapon: "bazooka" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "invalid_request" });
    } finally {
      await server.close();
    }
  });
});
