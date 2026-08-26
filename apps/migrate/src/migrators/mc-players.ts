import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type mysql from "mysql2/promise";
import {
  items, playerStats, playerTimers, players, transactions,
} from "../../../server/src/db/schema/index.js";
import { getOrCreateV3Id, lookupV3Id } from "../id-map.js";
import {
  bumpTable, recordBankFoldSplit, recordDroppedColumns, recordEquipMerge,
  recordLoginNameDivergence, recordOrphan, type MigrationReport,
} from "../report.js";
import type { Executor } from "../pg/types.js";

/**
 * MCCodes `users` + `userstats` -> GL3 `players` + `player_stats` (B2 Task 9,
 * spec §4 phase 3). Structure follows the V2 players migrator exactly: read
 * both tables, loop, id_map ids, never-clobber upserts, one explanatory
 * opening-balance ledger row per non-zero balance kind (balance-sets — the
 * ledger never fabricates transfer history, audit §7 item 6).
 *
 * The MCCodes-specific decisions, all audit §7: the bank fold
 * (max(bankmoney,0) + max(cybermoney,0), -1 = unopened, pre-fold split
 * reported, either tier > -1 stamps the bank.opened timer so a later open
 * fee never double-charges), pools verbatim with NULL stamps (no
 * retroactive regen — the column docs' whole point), hp/maxhp ->
 * health/health_max, floats rounded to bigints, the two-slot equipment
 * classifier (§6: every MCCodes weapon is melee-model; same-model
 * collisions keep the primary and report the secondary), jail/hospital
 * minute counters -> now + minutes, and donatordays -> the membership timer.
 */

interface UserRow {
  userid: number; username: string; login_name: string; userpass: string; pass_salt: string;
  email: string; user_level: number; signedup: number; laston: number;
  money: number; crystals: number; bankmoney: number; cybermoney: number; donatordays: number;
  energy: number; maxenergy: number; will: number; maxwill: number; brave: number; maxbrave: number;
  hp: number; maxhp: number; level: number; exp: string; crimexp: number;
  location: number; jail: number; hospital: number;
  equip_primary: number; equip_secondary: number; equip_armor: number;
  display_pic: string;
}
interface StatsRow {
  userid: number; strength: number; agility: number; guard: number; labour: number; IQ: number;
}

/** signed int(11) epoch -> Date; 0/negative (junk) -> null. */
function epoch(seconds: number): Date | null {
  return seconds > 0 ? new Date(seconds * 1000) : null;
}

/** The MCCodes item-effect engine's melee marker in GL3's jsonb shape:
 *  `weapon > 0` imported as {power} by mc-items — a bare truthy `power` IS
 *  the melee model (B0 §2.1). itemType must agree (an admin can mistype). */
function isMeleeEffects(effects: unknown): boolean {
  return typeof effects === "object" && effects !== null
    && typeof (effects as { power?: unknown }).power === "number";
}

/** A settled far-future stamp — exactly what the bank plugin's open route
 *  writes (bank.opened, 100 years) so a re-opened fee check matches. */
const HUNDRED_YEARS_MS = 100 * 365 * 86_400_000;

export async function migrateMcPlayers(pool: mysql.Pool, exec: Executor, report: MigrationReport): Promise<void> {
  const [userRows] = await pool.query<(UserRow & mysql.RowDataPacket)[]>(
    "SELECT userid, username, login_name, userpass, pass_salt, email, user_level, signedup, laston, " +
    "money, crystals, bankmoney, cybermoney, donatordays, energy, maxenergy, will, maxwill, " +
    "brave, maxbrave, hp, maxhp, level, exp, crimexp, location, jail, hospital, " +
    "equip_primary, equip_secondary, equip_armor, display_pic FROM users",
  );
  const [statsRows] = await pool.query<(StatsRow & mysql.RowDataPacket)[]>(
    "SELECT userid, strength, agility, guard, labour, IQ FROM userstats",
  );
  const statsByUser = new Map(statsRows.map((r) => [r.userid, r]));
  const [roleRows] = await pool.query<(mysql.RowDataPacket & { userid: number; staff_role: number })[]>(
    "SELECT userid, staff_role FROM users_roles",
  );
  const roleByUser = new Map(roleRows.map((r) => [r.userid, r.staff_role]));
  const [fedRows] = await pool.query<(mysql.RowDataPacket & { fed_userid: number; fed_days: number; fed_reason: string })[]>(
    "SELECT fed_userid, fed_days, fed_reason FROM fedjail",
  );
  const fedByUser = new Map(fedRows.map((r) => [r.fed_userid, r]));

  const now = new Date();

  for (const user of userRows) {
    bumpTable(report, "users", "read");
    const { v3Id: playerId } = await getOrCreateV3Id(exec, "users", user.userid);

    // Role: an explicit staff_roles assignment wins; user_level 2/3 without
    // one falls back to the imported Administrator/assistant role (the
    // synthetic mc_user_level keys mc-roles seeded).
    const staffRole = roleByUser.get(user.userid);
    let roleId: string | null = null;
    if (staffRole !== undefined) {
      roleId = await lookupV3Id(exec, "staff_roles", staffRole);
    } else if (user.user_level === 2 || user.user_level === 3) {
      roleId = await lookupV3Id(exec, "mc_user_level", user.user_level);
    }

    // fedjail -> the players ban surface (0015): day-based, dated at
    // migration (the source stores no timestamp), expiring after fed_days.
    const fed = fedByUser.get(user.userid);

    await exec.insert(players).values({
      id: playerId,
      username: user.username,
      email: user.email === "" ? null : user.email,
      passwordHash: null,
      legacyMccodesHash: user.userpass === "" ? null : user.userpass,
      legacyMccodesSalt: user.pass_salt === "" ? null : user.pass_salt,
      roleId,
      createdAt: epoch(user.signedup) ?? undefined,
      lastSeenAt: epoch(user.laston),
      // MCCodes has no email verification (its `verified` is an anti-macro
      // captcha) — imported players are verified.
      emailVerifiedAt: new Date(0),
      ...(fed !== undefined ? {
        bannedAt: now,
        banReason: fed.fed_reason,
        banExpiresAt: new Date(now.getTime() + fed.fed_days * 86_400_000),
      } : {}),
    }).onConflictDoUpdate({
      target: players.id,
      set: {
        username: user.username,
        email: user.email === "" ? null : user.email,
        roleId,
        lastSeenAt: epoch(user.laston),
        // Never clobber a hash the server already upgraded to argon2id (the
        // V2 migrator's CASE pattern, applied to the mccodes pair) —
        // `players.passwordHash` below refers to the EXISTING row.
        legacyMccodesHash: sql`CASE WHEN ${players.passwordHash} IS NULL THEN ${user.userpass} ELSE ${players.legacyMccodesHash} END`,
        legacyMccodesSalt: sql`CASE WHEN ${players.passwordHash} IS NULL THEN ${user.pass_salt} ELSE ${players.legacyMccodesSalt} END`,
        // Same never-downgrade shape as V2: only NULL -> set, never back.
        // ISO string, not Date — raw sql templates skip drizzle's mapping.
        emailVerifiedAt: sql`CASE WHEN ${players.emailVerifiedAt} IS NOT NULL THEN ${players.emailVerifiedAt} ELSE ${"1970-01-01T00:00:00.000Z"} END`,
        ...(fed !== undefined ? {
          bannedAt: now,
          banReason: fed.fed_reason,
          banExpiresAt: new Date(now.getTime() + fed.fed_days * 86_400_000),
        } : {}),
      },
    });
    bumpTable(report, "users", "written");

    // login_name is a separate login handle in MCCodes; GL3 has one
    // username. A divergence is an admin-action entry, not data loss.
    if (user.login_name !== "" && user.login_name !== user.username) {
      recordLoginNameDivergence(report, {
        v2Id: user.userid, username: user.username, loginName: user.login_name,
      });
    }

    const stats = statsByUser.get(user.userid);
    if (!stats) {
      recordOrphan(report, "userstats", user.userid, `user ${user.userid} has no matching userstats row`);
      continue;
    }
    bumpTable(report, "userstats", "read");

    // --- equipment: the two-slot classifier (spec §6) ----------------------
    // Every MCCodes weapon imports melee-model (flat items.weapon, no
    // accuracy data — mc-items), but the classifier reads the migrated
    // effects rather than assuming, so a hand-built source behaves the same.
    const equipSources = [user.equip_primary, user.equip_secondary].filter((id) => id > 0);
    const equipLookups = await Promise.all(equipSources.map(async (sourceId) => ({
      sourceId,
      v3Id: await lookupV3Id(exec, "items", sourceId),
    })));
    const migratedEquip = equipLookups.filter((e): e is { sourceId: number; v3Id: string } => e.v3Id !== null);
    for (const e of equipLookups) {
      if (e.v3Id === null) {
        recordOrphan(report, "users", user.userid, `equipped item ${e.sourceId} was not migrated`);
      }
    }
    let equipRows: { id: string; itemType: string; effects: unknown }[] = [];
    if (migratedEquip.length > 0) {
      equipRows = await exec.select({ id: items.id, itemType: items.itemType, effects: items.effects })
        .from(items)
        .where(sql`${items.id} IN (${sql.join(migratedEquip.map((e) => sql`${e.v3Id}`), sql`, `)})`);
    }
    const rowByV3 = new Map(equipRows.map((r) => [r.id, r]));
    let weaponItemId: string | null = null;
    let weaponMeleeItemId: string | null = null;
    let keptFirearmSource = 0;
    let keptMeleeSource = 0;
    for (const e of migratedEquip) {
      const row = rowByV3.get(e.v3Id);
      if (row === undefined || row.itemType !== "weapon") continue;
      if (isMeleeEffects(row.effects)) {
        if (weaponMeleeItemId === null) {
          weaponMeleeItemId = e.v3Id;
          keptMeleeSource = e.sourceId;
        } else if (keptMeleeSource !== e.sourceId) {
          recordEquipMerge(report, user.userid, keptMeleeSource, e.sourceId);
        }
      } else if (weaponItemId === null) {
        weaponItemId = e.v3Id;
        keptFirearmSource = e.sourceId;
      } else if (keptFirearmSource !== e.sourceId) {
        recordEquipMerge(report, user.userid, keptFirearmSource, e.sourceId);
      }
    }
    const armorItemId = user.equip_armor > 0
      ? await lookupV3Id(exec, "items", user.equip_armor) : null;
    if (user.equip_armor > 0 && armorItemId === null) {
      recordOrphan(report, "users", user.userid, `equipped armor ${user.equip_armor} was not migrated`);
    }

    // --- economy: fold + timers --------------------------------------------
    const bank = BigInt(Math.max(user.bankmoney, 0)) + BigInt(Math.max(user.cybermoney, 0));
    const bankOpened = user.bankmoney > -1 || user.cybermoney > -1;
    if (bankOpened && bank > 0n) {
      recordBankFoldSplit(report, {
        v2Id: user.userid, bank: user.bankmoney, cyber: user.cybermoney, folded: bank.toString(),
      });
    }
    if (bankOpened) {
      await exec.insert(playerTimers).values({
        playerId, key: "bank.opened", expiresAt: new Date(now.getTime() + HUNDRED_YEARS_MS),
      }).onConflictDoUpdate({
        target: [playerTimers.playerId, playerTimers.key],
        set: { expiresAt: new Date(now.getTime() + HUNDRED_YEARS_MS) },
      });
    }
    if (user.donatordays > 0) {
      const until = new Date(now.getTime() + user.donatordays * 86_400_000);
      await exec.insert(playerTimers).values({ playerId, key: "membership", expiresAt: until })
        .onConflictDoUpdate({ target: [playerTimers.playerId, playerTimers.key], set: { expiresAt: until } });
    }

    // --- the stats row ------------------------------------------------------
    const locationId = user.location > 0 ? await lookupV3Id(exec, "cities", user.location) : null;
    if (user.location > 0 && locationId === null) {
      recordOrphan(report, "users", user.userid, `city ${user.location} was not migrated`);
    }
    const jailedUntil = user.jail > 0 ? new Date(now.getTime() + user.jail * 60_000) : null;
    const hospitalUntil = user.hospital > 0 ? new Date(now.getTime() + user.hospital * 60_000) : null;

    const statValues = {
      cash: BigInt(user.money),
      bank,
      points: BigInt(user.crystals),
      energy: user.energy, energyMax: user.maxenergy,
      will: user.will, willMax: user.maxwill,
      brave: user.brave, braveMax: user.maxbrave,
      health: user.hp,
      healthMax: user.maxhp > 0 ? user.maxhp : null,
      level: user.level,
      exp: BigInt(Math.round(Number(user.exp))),
      crimeExp: BigInt(user.crimexp),
      strength: BigInt(Math.round(stats.strength)),
      agility: BigInt(Math.round(stats.agility)),
      guard: BigInt(Math.round(stats.guard)),
      labour: BigInt(Math.round(stats.labour)),
      iq: BigInt(Math.round(stats.IQ)),
      locationId,
      weaponItemId, weaponMeleeItemId, armorItemId,
      avatarUrl: user.display_pic === "" ? null : user.display_pic,
      jailedUntil, hospitalUntil,
    };
    await exec.insert(playerStats).values({ playerId, ...statValues })
      .onConflictDoUpdate({ target: playerStats.playerId, set: statValues });
    bumpTable(report, "userstats", "written");

    // Opening balances — explain, never move (V2's deterministic-jobId shape).
    const balances: { kind: "cash" | "bank" | "points"; amount: bigint }[] = [
      { kind: "cash", amount: statValues.cash },
      { kind: "bank", amount: bank },
      { kind: "points", amount: statValues.points },
    ];
    for (const { kind, amount } of balances) {
      if (amount === 0n) continue;
      await exec.insert(transactions).values({
        id: uuidv7(),
        playerId,
        amount,
        balanceKind: kind,
        reason: "migration.opening_balance",
        refId: null,
        jobId: `migrate:opening_balance:${user.userid}:${kind}`,
      }).onConflictDoNothing({ target: transactions.jobId });
    }
  }

  // Reverse orphans: a userstats row whose user never existed — no FKs in
  // the source schema, so this is expected in real dumps (audit §2).
  const seenUsers = new Set(userRows.map((u) => u.userid));
  for (const row of statsRows) {
    if (!seenUsers.has(row.userid)) {
      recordOrphan(report, "userstats", row.userid, "userstats row has no matching user");
    }
  }

  // Table-level drops, recorded once with the row count (spec §8).
  recordDroppedColumns(report, "users", [
    "force_logout", "attacking", "verified", "voted", "boxes_opened", "daysold",
    "gender", "duties", "staffnotes", "user_notepad", "posts", "forums_avatar",
    "forums_signature", "friend_count", "enemy_count", "new_events", "new_mail",
    "new_announcements", "lastip", "lastip_login", "lastip_signup", "last_login",
    "mailban", "mb_reason", "forumban", "fb_reason", "jail_reason", "hospreason",
    "fedjail", "lastrest_life", "lastrest_other",
  ], userRows.length);
}
