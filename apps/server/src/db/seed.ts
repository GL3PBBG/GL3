import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { Db } from "./client.js";
import { crimes, items, locations, ranks, settings } from "./schema/index.js";

type SeedProfile = "gl3" | "v2" | "mccodes" | "framework";

/**
 * Which of the sample-content seeds a boot should run, given the plugin ids
 * that boot loaded and the profile. Pure so the profile's seeding policy is
 * testable without a database: a seed runs only when a plugin that reads
 * its table loaded — sample crimes with no crimes plugin would fill a table
 * no route ever queries. Ranks always run: the ladder is progression
 * infrastructure and the ranks plugin is framework (never absent); the
 * mafia rank names are admin-editable sample data, not code.
 * `templeExchanges` is profile-gated too: only gl3 curates the temple
 * (gl3-hybrid spec §2) — a mccodes boot stays the faithful port.
 */
export function bootSeedsFor(loadedPluginIds: Iterable<string>, profile: SeedProfile): {
  crimes: boolean; ranks: true; locations: boolean; items: boolean;
  family: boolean; templeExchanges: boolean; unarmedMelee: boolean; missWillCost: boolean;
  venues: boolean;
} {
  const ids = loadedPluginIds instanceof Set ? loadedPluginIds : new Set(loadedPluginIds);
  return {
    crimes: ids.has("crimes"),
    ranks: true,
    locations: ids.has("travel") || ids.has("bullets"),
    items: ids.has("inventory"),
    family: ids.has("houses") || ids.has("education") || ids.has("jobs"),
    templeExchanges: profile === "gl3" && ids.has("temple"),
    // gl3 only, like the temple: mccodes keeps the spec'd firearm-model
    // fists (what MCCodes did unarmed is unverified, so the faithful port is
    // left alone) and v2 has no strength to swing.
    unarmedMelee: profile === "gl3" && ids.has("combat"),
    // gl3 only, same reasoning: a miss costing will is a GL3 rule, not
    // MCCodes' (attack.php charges energy, never will) nor V2's (no pools).
    // Inert anyway wherever no plugin declares the pool.
    missWillCost: profile === "gl3" && ids.has("combat"),
    // Town venues (spec 2026-09-21 §4): profile-gated, NOT plugin-gated, so
    // the flag's shape stays a pure function of the profile the way the
    // three above are. `properties` is bundled into both gl3 and v2, and
    // `seedVenueRows` is called with the declared property types — an empty
    // list on a boot without them makes it a no-op anyway.
    venues: profile === "gl3" || profile === "v2",
  };
}

/** The historical three cooldown/skill crimes — the v2 profile's catalog. */
const V2_CRIME_ROWS = () => [
  { id: uuidv7(), name: "Pickpocket", description: "Lift a wallet in a crowd.", cooldownSeconds: 30, minPayout: 50n, maxPayout: 250n, minBullets: 0, maxBullets: 0, expReward: 5n, minLevel: 0, sort: 10, jailChancePercent: 0, jailSeconds: 0 },
  { id: uuidv7(), name: "Rob a Store", description: "Hold up the corner shop.", cooldownSeconds: 60, minPayout: 200n, maxPayout: 900n, minBullets: 0, maxBullets: 2, expReward: 12n, minLevel: 0, sort: 20, jailChancePercent: 25, jailSeconds: 45 },
  { id: uuidv7(), name: "Armoured Van", description: "Take the van on the freeway.", cooldownSeconds: 300, minPayout: 2000n, maxPayout: 9000n, minBullets: 1, maxBullets: 5, expReward: 40n, minLevel: 0, sort: 30, jailChancePercent: 40, jailSeconds: 120 },
];

/**
 * The blended catalog (gl3-hybrid spec §2-3): every crime prices BOTH
 * economies — brave (the MCCodes throttle) and a short cooldown (the V2
 * one) — and resolves through a stat formula, so a fresh gl3 game
 * exercises pools, gym training and crime_exp from day one. Formula
 * vocabulary is the crimes plugin's five tokens only.
 */
const BLENDED_CRIME_ROWS = () => [
  { id: uuidv7(), name: "Pickpocket", description: "Lift a wallet in a crowd.", cooldownSeconds: 20, braveCost: 2, minPayout: 50n, maxPayout: 250n, minBullets: 0, maxBullets: 0, expReward: 5n, crimeExpReward: 2n, minLevel: 0, sort: 10, jailChancePercent: 5, jailSeconds: 30, successFormula: "min(95, 20 + CRIMEXP / 50)" },
  { id: uuidv7(), name: "Shoplift", description: "Walk out wearing it.", cooldownSeconds: 30, braveCost: 3, minPayout: 100n, maxPayout: 400n, minBullets: 0, maxBullets: 0, expReward: 8n, crimeExpReward: 3n, minLevel: 0, sort: 20, jailChancePercent: 10, jailSeconds: 45, successFormula: "min(90, 15 + CRIMEXP / 40)" },
  { id: uuidv7(), name: "Pick a Lock", description: "Quiet hands, quiet street.", cooldownSeconds: 45, braveCost: 4, minPayout: 200n, maxPayout: 700n, minBullets: 0, maxBullets: 0, expReward: 12n, crimeExpReward: 5n, minLevel: 0, sort: 30, jailChancePercent: 15, jailSeconds: 60, successFormula: "min(90, 10 + CRIMEXP / 30 + IQ / 200)" },
  { id: uuidv7(), name: "Mug a Stranger", description: "Pick someone who looks flush.", cooldownSeconds: 60, braveCost: 6, minPayout: 300n, maxPayout: 1200n, minBullets: 0, maxBullets: 0, expReward: 18n, crimeExpReward: 7n, minLevel: 0, sort: 40, jailChancePercent: 20, jailSeconds: 90, successFormula: "min(85, 10 + LEVEL * 3 + CRIMEXP / 60)" },
  { id: uuidv7(), name: "Rob a Store", description: "Hold up the corner shop.", cooldownSeconds: 90, braveCost: 8, minPayout: 600n, maxPayout: 2500n, minBullets: 0, maxBullets: 2, expReward: 25n, crimeExpReward: 10n, minLevel: 0, sort: 50, jailChancePercent: 25, jailSeconds: 120, successFormula: "min(80, 5 + LEVEL * 3 + CRIMEXP / 80)" },
  { id: uuidv7(), name: "Boost a Car", description: "The keys are a suggestion.", cooldownSeconds: 150, braveCost: 10, minPayout: 1200n, maxPayout: 5000n, minBullets: 0, maxBullets: 0, expReward: 35n, crimeExpReward: 14n, minLevel: 0, sort: 60, jailChancePercent: 30, jailSeconds: 180, successFormula: "min(75, 5 + LEVEL * 2 + CRIMEXP / 100 + WILL / 20)" },
  { id: uuidv7(), name: "Armoured Van", description: "Take the van on the freeway.", cooldownSeconds: 300, braveCost: 14, minPayout: 2500n, maxPayout: 9000n, minBullets: 1, maxBullets: 5, expReward: 50n, crimeExpReward: 20n, minLevel: 0, sort: 70, jailChancePercent: 35, jailSeconds: 240, successFormula: "min(70, LEVEL * 2 + CRIMEXP / 150)" },
  { id: uuidv7(), name: "Museum Heist", description: "In through the skylight.", cooldownSeconds: 600, braveCost: 20, minPayout: 6000n, maxPayout: 25000n, minBullets: 0, maxBullets: 0, expReward: 90n, crimeExpReward: 35n, minLevel: 0, sort: 80, jailChancePercent: 40, jailSeconds: 300, successFormula: "min(65, max(5, LEVEL * 2 + CRIMEXP / 200 + IQ / 100))" },
];

export async function seedCrimes(db: Db, profile: SeedProfile): Promise<void> {
  const existing = await db.select({ id: crimes.id }).from(crimes).limit(1);
  if (existing.length > 0) return;

  await db.insert(crimes).values(profile === "v2" ? V2_CRIME_ROWS() : BLENDED_CRIME_ROWS());
}

/**
 * The gl3 temple curation (spec §2): energy refills only. onConflictDoNothing,
 * never upsert — an operator's edited value must survive every reboot.
 */
export async function seedTempleExchanges(db: Db): Promise<void> {
  await db.insert(settings).values({ key: "temple.exchanges", value: "refill" })
    .onConflictDoNothing({ target: settings.key });
}

/**
 * gl3's fists: `combat.unarmed.model = melee`, so bare hands scale with the
 * gym like a knife does and spend no bullets. onConflictDoNothing for the
 * same reason as the temple — an admin who flips it back to firearm must
 * not be undone by the next reboot.
 */
export async function seedUnarmedMelee(db: Db): Promise<void> {
  await db.insert(settings).values({ key: "combat.unarmed.model", value: "melee" })
    .onConflictDoNothing({ target: settings.key });
}

/**
 * gl3's composure tax: `combat.miss.will_cost = 10`, one will regen tick per
 * missed shot, clamped to the pool at charge time. onConflictDoNothing so
 * an admin's own figure survives a reboot.
 */
export async function seedMissWillCost(db: Db): Promise<void> {
  await db.insert(settings).values({ key: "combat.miss.will_cost", value: "10" })
    .onConflictDoNothing({ target: settings.key });
}

/**
 * Sample content for the MCCodes-family plugin tables. Runs AFTER
 * `loadPlugins` (whose plugin migrations create these tables — on a first
 * boot they do not exist at the core-seed point), gated per table on its
 * plugin id and empty-table-guarded like every other seed. Raw SQL because
 * core has no drizzle definitions for plugin-owned `p_*` tables.
 */
export async function seedFamilyContent(db: Db, loadedPluginIds: Iterable<string>): Promise<void> {
  const ids = loadedPluginIds instanceof Set ? loadedPluginIds : new Set(loadedPluginIds);

  if (ids.has("houses")) {
    // > 1, not > 0: the houses plugin's own migration seeds Default House.
    const rows = (await db.execute(sql`SELECT count(*)::int AS n FROM p_houses_houses`)) as unknown as { n: number }[];
    if ((rows[0]?.n ?? 0) <= 1) {
      await db.execute(sql`INSERT INTO p_houses_houses (id, name, price, will) VALUES
        (gen_random_uuid(), 'Small Flat', 25000, 150),
        (gen_random_uuid(), 'Townhouse', 120000, 250),
        (gen_random_uuid(), 'Penthouse', 600000, 400)`);
    }
  }

  if (ids.has("education")) {
    const rows = (await db.execute(sql`SELECT count(*)::int AS n FROM p_education_courses`)) as unknown as { n: number }[];
    if ((rows[0]?.n ?? 0) === 0) {
      await db.execute(sql`INSERT INTO p_education_courses
        (id, name, description, cost, days, strength_gain, agility_gain, guard_gain, labour_gain, iq_gain) VALUES
        (gen_random_uuid(), 'Street Smarts', 'Two days of hard lessons.', 500, 2, 1, 0, 1, 0, 0),
        (gen_random_uuid(), 'Boxing Basics', 'Learn to take a hit.', 1200, 4, 2, 0, 1, 1, 0),
        (gen_random_uuid(), 'Night School', 'Books after dark.', 2500, 7, 0, 0, 0, 0, 5)`);
    }
  }

  if (ids.has("jobs")) {
    const rows = (await db.execute(sql`SELECT count(*)::int AS n FROM p_jobs_jobs`)) as unknown as { n: number }[];
    if ((rows[0]?.n ?? 0) === 0) {
      // No FKs on these tables (rule 6 discipline), but first_rank_id must
      // point at a real rank — generate the uuids here so the reference holds.
      const warehouseId = uuidv7();
      const loaderId = uuidv7();
      const copyShopId = uuidv7();
      const clerkId = uuidv7();
      await db.execute(sql`INSERT INTO p_jobs_ranks
        (id, job_id, name, pay, strength_gain, labour_gain, iq_gain, strength_req, labour_req, iq_req) VALUES
        (${loaderId}, ${warehouseId}, 'Loader', 150, 1, 1, 0, 0, 0, 0),
        (gen_random_uuid(), ${warehouseId}, 'Foreman', 400, 1, 2, 0, 50, 0, 0),
        (${clerkId}, ${copyShopId}, 'Clerk', 120, 0, 1, 1, 0, 0, 0),
        (gen_random_uuid(), ${copyShopId}, 'Manager', 350, 0, 1, 2, 0, 0, 40)`);
      await db.execute(sql`INSERT INTO p_jobs_jobs (id, name, description, first_rank_id) VALUES
        (${warehouseId}, 'Warehouse Crew', 'Lift, carry, repeat.', ${loaderId}),
        (${copyShopId}, 'Copy Shop', 'Toner and patience.', ${clerkId})`);
    }
  }
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

/**
 * First-boot venue seeding (spec 2026-09-21 town-venues §4). Since that
 * cluster a venue — a casino, a bullet factory — exists in a town only where
 * a `p_properties_properties` row exists for `(location_id, plugin_id)`, so
 * without this a fresh native game would have no venues anywhere. One
 * state-run row (owner null) per (town × declared property type) is exactly
 * what the every-town synthesis used to fabricate at read time, so a fresh
 * gl3/v2 game keeps showing every venue everywhere, exactly as before this
 * cluster; admins remove what a town should not have.
 *
 * Runs ONCE, on an EMPTY table: a game migrated from V2 carries the real
 * answer about which towns have what, and that answer is never overwritten
 * or added to. `last_claimed_at`'s migration bug is the precedent — a
 * "harmless" backfill over migrated rows is the one to be careful with.
 *
 * Raw SQL by table name, no drizzle model: core never imports a plugin's
 * schema (`venueExists` in `plugins/ctx.ts` is the same idiom). It therefore
 * belongs to the SECOND seed pass, after `loadPlugins` has run the plugin
 * migrations that create the table — like `seedFamilyContent`.
 *
 * `mode` is the upgrade seam. `"first-boot"` is the rule above verbatim, plus
 * ONE warning naming how many (town × type) pairs have no row, for the
 * already-running native game this cluster leaves with fewer venues than it
 * had. `"fill"` (SEED_VENUES=fill) inserts exactly those missing pairs as
 * state-run rows on an empty OR a populated table, touching no row that
 * exists — including an owned one.
 */
export type VenueSeedMode = "first-boot" | "fill";

export async function seedVenueRows(
  db: Db, typeIds: readonly string[], mode: VenueSeedMode = "first-boot",
): Promise<void> {
  if (typeIds.length === 0) return;

  const towns = await db.select({ id: locations.id, name: locations.name }).from(locations);
  if (towns.length === 0) return;

  const existing = await db.execute(sql`select location_id, plugin_id from p_properties_properties`);
  const held = new Set([...existing].map((row) => `${String(row.location_id)}\u0000${String(row.plugin_id)}`));

  const missing = towns.flatMap((town) => typeIds
    .filter((typeId) => !held.has(`${town.id}\u0000${typeId}`))
    .map((typeId) => ({ town, typeId })));

  if (mode === "first-boot" && held.size > 0) {
    // The migrated-game rule: a non-empty table is somebody's real answer and
    // is never added to silently. But an already-running NATIVE game reaching
    // this cluster is in exactly the same state and wants the opposite, so say
    // so once rather than leaving its operator to notice missing doors.
    if (missing.length > 0) {
      const first = missing[0]!;
      console.warn(
        { missing: missing.length, example: `${first.town.name}/${first.typeId}` },
        "venues: some towns have no row for a declared property type — provision them in Admin → Properties → Venues, or boot once with SEED_VENUES=fill",
      );
    }
    return;
  }

  if (missing.length === 0) return;

  const values = missing.map(({ town, typeId }) => sql`(${uuidv7()}, ${town.id}, ${typeId}, null, 0, 0)`);
  // `on conflict do nothing` over the (location_id, plugin_id) unique index:
  // two replicas booting against the same empty database race here, and the
  // loser must boot rather than crash on a duplicate key. It also makes the
  // fill pass safe against a row appearing between the read above and this
  // insert.
  const inserted = await db.execute(sql`
    insert into p_properties_properties (id, location_id, plugin_id, owner_player_id, cost, profit)
    values ${sql.join(values, sql`, `)}
    on conflict (location_id, plugin_id) do nothing
    returning id
  `);

  if (mode === "fill") {
    console.info({ inserted: [...inserted].length }, "venues: filled missing town × type rows");
  }
}
