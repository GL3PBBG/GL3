import { relations, sql } from "drizzle-orm";
import {
  type AnyPgColumn, bigint, customType, index, integer, numeric, pgTable,
  primaryKey, text, timestamp, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";
import { gangs } from "./social.js";
import { crimes, items, locations } from "./content.js";

/** citext: case-insensitive text, so `Bob` and `bob` collide on the unique index. */
export const citext = customType<{ data: string }>({ dataType: () => "citext" });

const numericChance = (name: string) => numeric(name, { precision: 5, scale: 2 });

export const roles = pgTable("roles", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  color: text("color"),
});

/** V2 roleAccess: module referenced by string name, `*` = admin wildcard. Preserved. */
export const roleModuleAccess = pgTable("role_module_access", {
  roleId: uuid("role_id").notNull().references(() => roles.id, { onDelete: "cascade" }),
  moduleKey: text("module_key").notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.roleId, t.moduleKey] }) }));

export const rounds = pgTable("rounds", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true }),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  finalizedAt: timestamp("finalized_at", { withTimezone: true }),
  snapshottedAt: timestamp("snapshotted_at", { withTimezone: true }),
});

export const players = pgTable("players", {
  id: uuid("id").primaryKey(),
  username: citext("username").notNull(),
  email: citext("email"),
  /** Null immediately after migration; filled on first legacy login (spec §4.3). */
  passwordHash: text("password_hash"),
  /** V2 `users.U_password` copied verbatim: sha256(U_id . plaintext). */
  legacyPasswordSha256: text("legacy_password_sha256"),
  /** Required by the §4.3 formula — it hashes the V2 *integer* id, not the uuid. */
  legacyV2Id: integer("legacy_v2_id"),
  /** MCCodes `users.userpass` copied verbatim: md5(pass_salt . md5(password)).
   * An empty/NULL salt means the older unsalted md5(password) form. Upgraded to
   * argon2id on first login, same flow as the V2 column (spec
   * 2026-08-26-mccodes-mechanics-audit §7 item 10). */
  legacyMccodesHash: text("legacy_mccodes_hash"),
  /** MCCodes `users.pass_salt` (8 hex chars). Part of the hash input, NOT an id
   * — so unlike legacy_v2_id it carries no unique index: salts collide across
   * dumps. */
  legacyMccodesSalt: text("legacy_mccodes_salt"),
  roleId: uuid("role_id").references(() => roles.id, { onDelete: "set null" }),
  roundId: uuid("round_id").references(() => rounds.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  /** NULL = not banned. With bannedAt set, a NULL banExpiresAt is permanent. */
  bannedAt: timestamp("banned_at", { withTimezone: true }),
  banReason: text("ban_reason"),
  banExpiresAt: timestamp("ban_expires_at", { withTimezone: true }),
}, (t) => ({
  usernameUnique: uniqueIndex("players_username_unique").on(t.username),
  emailUnique: uniqueIndex("players_email_unique").on(t.email),
  legacyV2IdUnique: uniqueIndex("players_legacy_v2_id_unique").on(t.legacyV2Id),
  roleIdx: index("players_role_idx").on(t.roleId),
  roundIdx: index("players_round_idx").on(t.roundId),
}));

/** 1:1 with players, kept split for hot-row separation (spec §2.5). */
export const playerStats = pgTable("player_stats", {
  playerId: uuid("player_id").primaryKey().references(() => players.id, { onDelete: "cascade" }),
  cash: bigint("cash", { mode: "bigint" }).notNull().default(sql`0`),
  bank: bigint("bank", { mode: "bigint" }).notNull().default(sql`0`),
  points: bigint("points", { mode: "bigint" }).notNull().default(sql`0`),
  bullets: bigint("bullets", { mode: "bigint" }).notNull().default(sql`0`),
  exp: bigint("exp", { mode: "bigint" }).notNull().default(sql`0`),
  health: integer("health").notNull().default(100),
  backfire: integer("backfire").notNull().default(0),
  // MCCodes-parity attributes (specs 2026-08-25-player-attributes and
  // 2026-08-26-mccodes-mechanics-audit). The pools are inert until a plugin
  // declares them through `providesAttributes` — an all-zero row spends
  // nothing and runs no clock — and iq/crime_exp/health_max stay untouched
  // until their cluster-C plugins read them. They live here rather than in a
  // table of their own precisely because this row is already locked by
  // `tx.locks.player`, so they add no lock-graph edge (NOTES.md rule 6).
  energy: integer("energy").notNull().default(0),
  energyMax: integer("energy_max").notNull().default(0),
  will: integer("will").notNull().default(0),
  willMax: integer("will_max").notNull().default(0),
  brave: integer("brave").notNull().default(0),
  braveMax: integer("brave_max").notNull().default(0),
  // bigint, not integer: MCCodes players grind these past 2^31. IQ is bought
  // and studied (courses, jobs, crystal temple), never gym-trained.
  strength: bigint("strength", { mode: "bigint" }).notNull().default(sql`0`),
  agility: bigint("agility", { mode: "bigint" }).notNull().default(sql`0`),
  guard: bigint("guard", { mode: "bigint" }).notNull().default(sql`0`),
  labour: bigint("labour", { mode: "bigint" }).notNull().default(sql`0`),
  iq: bigint("iq", { mode: "bigint" }).notNull().default(sql`0`),
  // MCCodes' global crime-progression counter; feeds imported success
  // formulas (spec 2026-08-26-mccodes-mechanics-audit §7 item 4).
  crimeExp: bigint("crime_exp", { mode: "bigint" }).notNull().default(sql`0`),
  level: integer("level").notNull().default(1),
  // NULL = max health stays rank-derived (GL3-native). Set = the progression
  // plugin owns the cap (+50 per MCCodes level-up). "NULL means not my model",
  // the same convention as the regen stamps (§7 item 8).
  healthMax: integer("health_max"),
  // NULLABLE, never defaultNow(): null means the clock has never started, so
  // the first settle stamps it and accrues nothing. A player migrated from a
  // decade-old dump must not regenerate ten years of energy on first read —
  // the properties cluster shipped exactly that bug with `last_claimed_at`.
  energyRegenAt: timestamp("energy_regen_at", { withTimezone: true }),
  willRegenAt: timestamp("will_regen_at", { withTimezone: true }),
  braveRegenAt: timestamp("brave_regen_at", { withTimezone: true }),
  // Lazy hp-regen clock (⅓ of max per 5 minutes) driven by C3's settleHealth
  // when health_max is set. NULL = the clock never started — same convention
  // as the pool stamps, so imports regenerate nothing retroactively.
  healthRegenAt: timestamp("health_regen_at", { withTimezone: true }),
  rankId: uuid("rank_id").references(() => ranks.id, { onDelete: "set null" }),
  gangId: uuid("gang_id").references((): AnyPgColumn => gangs.id, { onDelete: "set null" }),
  locationId: uuid("location_id").references(() => locations.id, { onDelete: "set null" }),
  weaponItemId: uuid("weapon_item_id").references(() => items.id, { onDelete: "set null" }),
  /**
   * The melee-only second weapon slot (migration 0019, spec
   * 2026-08-26-mccodes-migrator-design §2.1). Slot 1 stays the firearm slot
   * and stays authoritative when armed; this slot only ever holds a
   * melee-model weapon and only fires when slot 1 is empty — NULL is a
   * no-op on every read path, so GL3-native and V2-migrated games stay
   * byte-identical. FK mirrors weapon_item_id exactly.
   */
  weaponMeleeItemId: uuid("weapon_melee_item_id").references(() => items.id, { onDelete: "set null" }),
  armorItemId: uuid("armor_item_id").references(() => items.id, { onDelete: "set null" }),
  avatarUrl: text("avatar_url"),
  bio: text("bio"),
  /** Promoted out of generic timers because they gate actions (spec §2.5). */
  jailedUntil: timestamp("jailed_until", { withTimezone: true }),
  hospitalUntil: timestamp("hospital_until", { withTimezone: true }),
}, (t) => ({
  cashIdx: index("player_stats_cash_idx").on(t.cash),
  expIdx: index("player_stats_exp_idx").on(t.exp),
  gangIdx: index("player_stats_gang_idx").on(t.gangId),
  rankIdx: index("player_stats_rank_idx").on(t.rankId),
  locationIdx: index("player_stats_location_idx").on(t.locationId),
  // The sentence sweeper selects on these every tick. Partial because almost
  // every row has both columns null — the index only ever holds live sentences.
  jailedUntilIdx: index("player_stats_jailed_until_idx")
    .on(t.jailedUntil).where(sql`${t.jailedUntil} is not null`),
  hospitalUntilIdx: index("player_stats_hospital_until_idx")
    .on(t.hospitalUntil).where(sql`${t.hospitalUntil} is not null`),
}));

/**
 * A round is a scoring window, not a wipe. This row is the snapshot taken when
 * a player entered the round; standing = (final ?? current) - start. The
 * `final_*` columns are NULL until the round is finalized, at which point they
 * freeze the board forever. This is also the hall of fame — there is no second
 * table of winners.
 */
export const roundEntries = pgTable("round_entries", {
  roundId: uuid("round_id").notNull().references(() => rounds.id, { onDelete: "cascade" }),
  playerId: uuid("player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  expAtStart: bigint("exp_at_start", { mode: "bigint" }).notNull().default(sql`0`),
  cashAtStart: bigint("cash_at_start", { mode: "bigint" }).notNull().default(sql`0`),
  bankAtStart: bigint("bank_at_start", { mode: "bigint" }).notNull().default(sql`0`),
  finalExp: bigint("final_exp", { mode: "bigint" }),
  finalCash: bigint("final_cash", { mode: "bigint" }),
  finalBank: bigint("final_bank", { mode: "bigint" }),
}, (t) => ({
  pk: primaryKey({ columns: [t.roundId, t.playerId] }),
  playerIdx: index("round_entries_player_idx").on(t.playerId),
}));

/** Mirrors V2 userTimers: open-ended key→time. Custom module keys must survive. */
export const playerTimers = pgTable("player_timers", {
  playerId: uuid("player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.playerId, t.key] }) }));

/** V2 US_crimes dash-string exploded into rows (spec §1.2 quirk). */
export const playerCrimeSkill = pgTable("player_crime_skill", {
  playerId: uuid("player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  crimeId: uuid("crime_id").notNull().references(() => crimes.id, { onDelete: "cascade" }),
  chance: numericChance("chance").notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.playerId, t.crimeId] }) }));

export const ranks = pgTable("ranks", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  expRequired: bigint("exp_required", { mode: "bigint" }).notNull(),
  cashReward: bigint("cash_reward", { mode: "bigint" }).notNull().default(sql`0`),
  bulletReward: integer("bullet_reward").notNull().default(0),
  maxHealth: integer("max_health").notNull().default(100),
}, (t) => ({ expIdx: index("ranks_exp_idx").on(t.expRequired) }));

export const moneyRanks = pgTable("money_ranks", {
  id: uuid("id").primaryKey(),
  label: text("label").notNull(),
  threshold: bigint("threshold", { mode: "bigint" }).notNull(),
});

/** V2 settings key/value, migrated verbatim (spec §1.2). */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const playersRelations = relations(players, ({ one }) => ({
  stats: one(playerStats, { fields: [players.id], references: [playerStats.playerId] }),
  role: one(roles, { fields: [players.roleId], references: [roles.id] }),
}));
