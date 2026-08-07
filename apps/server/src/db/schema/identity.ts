import { relations } from "drizzle-orm";
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
  roleId: uuid("role_id").references(() => roles.id, { onDelete: "set null" }),
  roundId: uuid("round_id").references(() => rounds.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
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
  cash: bigint("cash", { mode: "bigint" }).notNull().default(0n),
  bank: bigint("bank", { mode: "bigint" }).notNull().default(0n),
  points: bigint("points", { mode: "bigint" }).notNull().default(0n),
  bullets: bigint("bullets", { mode: "bigint" }).notNull().default(0n),
  exp: bigint("exp", { mode: "bigint" }).notNull().default(0n),
  health: integer("health").notNull().default(100),
  backfire: integer("backfire").notNull().default(0),
  rankId: uuid("rank_id").references(() => ranks.id, { onDelete: "set null" }),
  gangId: uuid("gang_id").references((): AnyPgColumn => gangs.id, { onDelete: "set null" }),
  locationId: uuid("location_id").references(() => locations.id, { onDelete: "set null" }),
  weaponItemId: uuid("weapon_item_id").references(() => items.id, { onDelete: "set null" }),
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
  cashReward: bigint("cash_reward", { mode: "bigint" }).notNull().default(0n),
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
