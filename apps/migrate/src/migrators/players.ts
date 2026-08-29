import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type mysql from "mysql2/promise";
import { players, playerStats, transactions } from "../../../server/src/db/schema/index.js";
import { getOrCreateV3Id, lookupV3Id } from "../id-map.js";
import { bumpTable, recordOrphan, type MigrationReport } from "../report.js";
import type { Executor } from "../pg/types.js";

interface UserRow {
  U_id: number; U_name: string; U_email: string | null; U_password: string;
  U_userLevel: number; U_status: number; U_round: number;
}
interface UserStatsRow {
  US_id: number; US_money: number; US_bank: number; US_bullets: number; US_exp: number;
  US_health: number; US_backfire: number; US_points: number; US_weapon: number; US_armor: number;
  US_rank: number; US_location: number | null; US_pic: string | null; US_bio: string | null;
}

export async function migratePlayers(pool: mysql.Pool, exec: Executor, report: MigrationReport): Promise<void> {
  const [userRows] = await pool.query<(UserRow & mysql.RowDataPacket)[]>(
    "SELECT U_id, U_name, U_email, U_password, U_userLevel, U_status, U_round FROM users",
  );
  const [statsRows] = await pool.query<(UserStatsRow & mysql.RowDataPacket)[]>(
    "SELECT US_id, US_money, US_bank, US_bullets, US_exp, US_health, US_backfire, US_points, " +
    "US_weapon, US_armor, US_rank, US_location, US_pic, US_bio FROM userStats",
  );
  const statsByUser = new Map(statsRows.map((r) => [r.US_id, r]));

  for (const user of userRows) {
    bumpTable(report, "users", "read");
    const { v3Id: playerId } = await getOrCreateV3Id(exec, "users", user.U_id);

    // "Known unknowns" item 2: U_userLevel treated as userRoles.UR_id. No
    // matching role -> left null, not an orphan (role_id is nullable, and
    // §4.2's orphan policy names users/gangs/items specifically, not roles).
    const roleId = await lookupV3Id(exec, "userRoles", user.U_userLevel);
    const roundId = await lookupV3Id(exec, "rounds", user.U_round);

    // V2's U_status: 1 = active (email verified/not gated), 2 = awaiting
    // email validation. Any status other than 2 counts as verified.
    const emailVerifiedAt = user.U_status === 2 ? null : new Date();

    await exec.insert(players).values({
      id: playerId, username: user.U_name, email: user.U_email,
      passwordHash: null, legacyPasswordSha256: user.U_password, legacyV2Id: user.U_id,
      roleId, roundId, emailVerifiedAt,
    }).onConflictDoUpdate({
      target: players.id,
      set: {
        username: user.U_name, email: user.U_email, roleId, roundId,
        // Never clobber a legacy hash the server has already nulled out
        // after a successful upgrade to argon2id (SPEC §4.3, Task 31's
        // e2e test) — only refresh it while the player is still
        // un-upgraded. `players.passwordHash`/`players.legacyPasswordSha256`
        // here refer to the EXISTING row (Postgres upsert semantics: only
        // `excluded.*` refers to the proposed new row), so this survives
        // any number of re-runs after login has upgraded the player.
        legacyPasswordSha256: sql`CASE WHEN ${players.passwordHash} IS NULL THEN ${user.U_password} ELSE ${players.legacyPasswordSha256} END`,
        // Same shape, opposite direction: never downgrade a player who has
        // since verified natively in GL3 (email_verified_at non-null) back
        // to NULL just because V2 still shows U_status=2 on a re-run. Only
        // ever move NULL -> non-null here, never the other way. The
        // incoming value is passed as an ISO string (not the raw Date) —
        // unlike a `.values()` insert, a raw `sql` template does not run
        // drizzle's column-type mapping, so an embedded Date reaches the
        // driver un-serialised and postgres-js rejects it.
        emailVerifiedAt: sql`CASE WHEN ${players.emailVerifiedAt} IS NOT NULL THEN ${players.emailVerifiedAt} ELSE ${emailVerifiedAt === null ? null : emailVerifiedAt.toISOString()} END`,
      },
    });
    bumpTable(report, "users", "written");

    const stats = statsByUser.get(user.U_id);
    if (!stats) {
      recordOrphan(report, "userStats", user.U_id, `user ${user.U_id} has no matching userStats row`);
      continue;
    }
    bumpTable(report, "userStats", "read");

    const rankId = await lookupV3Id(exec, "ranks", stats.US_rank);
    const locationId = stats.US_location ? await lookupV3Id(exec, "locations", stats.US_location) : null;
    // 0 is V2's "nothing equipped" convention, not a real item reference.
    const weaponItemId = stats.US_weapon > 0 ? await lookupV3Id(exec, "items", stats.US_weapon) : null;
    const armorItemId = stats.US_armor > 0 ? await lookupV3Id(exec, "items", stats.US_armor) : null;
    // V2's crime gate compared C_level against US_rank directly — a numeric
    // level in practice. GL3's gate compares player_stats.level, so without
    // this a migrated player would sit at the default 1 and lose access to
    // crimes they could commit in V2 the moment the gate is enforced.
    const level = stats.US_rank;

    await exec.insert(playerStats).values({
      playerId,
      cash: BigInt(stats.US_money), bank: BigInt(stats.US_bank), bullets: BigInt(stats.US_bullets),
      exp: BigInt(stats.US_exp), points: BigInt(stats.US_points),
      health: stats.US_health, backfire: stats.US_backfire,
      rankId, locationId, weaponItemId, armorItemId,
      avatarUrl: stats.US_pic, bio: stats.US_bio,
      level,
      // gang_id / jailed_until / hospital_until: filled by later migrators.
    }).onConflictDoUpdate({
      target: playerStats.playerId,
      set: {
        cash: BigInt(stats.US_money), bank: BigInt(stats.US_bank), bullets: BigInt(stats.US_bullets),
        exp: BigInt(stats.US_exp), points: BigInt(stats.US_points),
        health: stats.US_health, backfire: stats.US_backfire,
        rankId, locationId, weaponItemId, armorItemId,
        avatarUrl: stats.US_pic, bio: stats.US_bio,
        level,
      },
    });
    bumpTable(report, "userStats", "written");

    // Opening-balance ledger rows (plan Global Constraints line 36/38). One row
    // per NON-ZERO balance kind; the balance is already set on player_stats
    // above, so these rows only explain it — they do not move it (do NOT call
    // applyBalanceChange; that would double-count). Idempotent on re-run via the
    // deterministic jobId hitting the transactions_job_id_unique index.
    const balances: { kind: "cash" | "bank" | "points"; amount: bigint }[] = [
      { kind: "cash", amount: BigInt(stats.US_money) },
      { kind: "bank", amount: BigInt(stats.US_bank) },
      { kind: "points", amount: BigInt(stats.US_points) },
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
        jobId: `migrate:opening_balance:${user.U_id}:${kind}`,
      }).onConflictDoNothing({ target: transactions.jobId });
    }
  }
}
