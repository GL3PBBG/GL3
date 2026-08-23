import { uuidv7 } from "uuidv7";
import type { Db } from "./client.js";
import { crimes, items, locations, ranks } from "./schema/index.js";

/**
 * Which of the sample-content seeds a boot should run, given the plugin ids
 * that boot loaded. Pure so the profile's seeding policy is testable without
 * a database: a seed runs only when a plugin that reads its table loaded —
 * sample crimes with no crimes plugin would fill a table no route ever
 * queries. Ranks always run: the ladder is progression infrastructure and
 * the ranks plugin is framework (never absent); the mafia rank names are
 * admin-editable sample data, not code.
 */
export function bootSeedsFor(loadedPluginIds: Iterable<string>): {
  crimes: boolean; ranks: true; locations: boolean; items: boolean;
} {
  const ids = loadedPluginIds instanceof Set ? loadedPluginIds : new Set(loadedPluginIds);
  return {
    crimes: ids.has("crimes"),
    ranks: true,
    locations: ids.has("travel") || ids.has("bullets"),
    items: ids.has("inventory"),
  };
}

export async function seedCrimes(db: Db): Promise<void> {
  const existing = await db.select({ id: crimes.id }).from(crimes).limit(1);
  if (existing.length > 0) return;

  await db.insert(crimes).values([
    { id: uuidv7(), name: "Pickpocket", description: "Lift a wallet in a crowd.", cooldownSeconds: 30, minPayout: 50n, maxPayout: 250n, minBullets: 0, maxBullets: 0, expReward: 5n, minRank: 0, sort: 10, jailChancePercent: 0, jailSeconds: 0 },
    { id: uuidv7(), name: "Rob a Store", description: "Hold up the corner shop.", cooldownSeconds: 60, minPayout: 200n, maxPayout: 900n, minBullets: 0, maxBullets: 2, expReward: 12n, minRank: 0, sort: 20, jailChancePercent: 25, jailSeconds: 45 },
    { id: uuidv7(), name: "Armoured Van", description: "Take the van on the freeway.", cooldownSeconds: 300, minPayout: 2000n, maxPayout: 9000n, minBullets: 1, maxBullets: 5, expReward: 40n, minRank: 0, sort: 30, jailChancePercent: 40, jailSeconds: 120 },
  ]);
}

export async function seedRanks(db: Db): Promise<void> {
  const existing = await db.select({ id: ranks.id }).from(ranks).limit(1);
  if (existing.length > 0) return;

  await db.insert(ranks).values([
    { id: uuidv7(), name: "Associate", expRequired: 0n, cashReward: 0n, bulletReward: 0, maxHealth: 100 },
    { id: uuidv7(), name: "Soldier", expRequired: 100n, cashReward: 500n, bulletReward: 5, maxHealth: 110 },
    { id: uuidv7(), name: "Capo", expRequired: 500n, cashReward: 2500n, bulletReward: 15, maxHealth: 125 },
    { id: uuidv7(), name: "Underboss", expRequired: 2000n, cashReward: 10000n, bulletReward: 40, maxHealth: 150 },
    { id: uuidv7(), name: "Boss", expRequired: 8000n, cashReward: 50000n, bulletReward: 100, maxHealth: 200 },
  ]);
}

export async function seedLocations(db: Db): Promise<void> {
  const existing = await db.select({ id: locations.id }).from(locations).limit(1);
  if (existing.length > 0) return;

  await db.insert(locations).values([
    { id: uuidv7(), name: "New York", travelCost: 0n, travelCooldownSeconds: 30, bulletStock: 1000, bulletCost: 3n },
    { id: uuidv7(), name: "Chicago", travelCost: 100n, travelCooldownSeconds: 60, bulletStock: 500, bulletCost: 5n },
    { id: uuidv7(), name: "Miami", travelCost: 250n, travelCooldownSeconds: 120, bulletStock: 300, bulletCost: 8n },
  ]);
}

/**
 * Two starter items so equip is not inert before a shop exists: one weapon to
 * fight with, one consumable to heal with.
 *
 * Same shape as the other seeds in this file — uuidv7 ids and an
 * already-populated early return, so a re-run is a no-op rather than a
 * duplicate. Because the ids are generated, no test may hardcode one; look a
 * starter item up by `name`.
 */
export async function seedItems(db: Db): Promise<void> {
  const existing = await db.select({ id: items.id }).from(items).limit(1);
  if (existing.length > 0) return;

  await db.insert(items).values([
    {
      id: uuidv7(),
      name: "Rusty Pistol",
      itemType: "weapon",
      effects: {
        accuracy: 55, damageMin: 8, damageMax: 18,
        bulletsPerShot: 1, critChance: 5, critMultiplier: 1.5,
        armorPierce: 0, minRankExp: 0,
      },
    },
    { id: uuidv7(), name: "First Aid Kit", itemType: "consumable", effects: { heal: 25 } },
  ]);
}
