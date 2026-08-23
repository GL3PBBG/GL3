import type mysql from "mysql2/promise";
import { gangInvites, gangLogs, gangPermissions } from "../../../server/src/db/schema/index.js";
import { getOrCreateV3Id, lookupV3Id } from "../id-map.js";
import { bumpTable, recordOrphan, type MigrationReport } from "../report.js";
import type { Executor } from "../pg/types.js";
import { unixToDate } from "../time.js";

interface PermissionRow { GP_user: number; GP_access: string; }
// Column names per V2's gangs module: GI_user = invited player,
// GI_gangUser = the gang member who sent the invite (gangs.inc.php inserts
// GI_user/GI_gangUser/GI_gang). V2 keeps no invite timestamp.
interface InviteRow { GI_id: number; GI_gang: number; GI_user: number; GI_gangUser: number; }
// GL_user is NOT NULL DEFAULT 0 — 0, not NULL, is V2's system-entry sentinel.
interface LogRow { GL_id: number; GL_gang: number; GL_user: number; GL_log: string; GL_time: number; }
interface GangMembershipLookupRow { US_id: number; US_gang: number; }

export async function migrateGangSocial(pool: mysql.Pool, exec: Executor, report: MigrationReport): Promise<void> {
  const [membershipRows] = await pool.query<(GangMembershipLookupRow & mysql.RowDataPacket)[]>(
    "SELECT US_id, US_gang FROM userStats",
  );
  const gangByUser = new Map(membershipRows.map((r) => [r.US_id, r.US_gang]));

  // SPEC §1.2: gangPermissions has no gang column — derived from US_gang.
  const [permRows] = await pool.query<(PermissionRow & mysql.RowDataPacket)[]>(
    "SELECT GP_user, GP_access FROM gangPermissions",
  );
  for (const row of permRows) {
    bumpTable(report, "gangPermissions", "read");
    const playerId = await lookupV3Id(exec, "users", row.GP_user);
    if (!playerId) {
      recordOrphan(report, "gangPermissions", row.GP_user, `user ${row.GP_user} does not exist`);
      bumpTable(report, "gangPermissions", "skipped");
      continue;
    }
    const v2GangId = gangByUser.get(row.GP_user);
    if (!v2GangId) {
      recordOrphan(report, "gangPermissions", row.GP_user, `user ${row.GP_user} is gangless`);
      bumpTable(report, "gangPermissions", "skipped");
      continue;
    }
    const gangId = await lookupV3Id(exec, "gangs", v2GangId);
    if (!gangId) {
      recordOrphan(report, "gangPermissions", row.GP_user, `gang ${v2GangId} does not exist`);
      bumpTable(report, "gangPermissions", "skipped");
      continue;
    }
    await exec.insert(gangPermissions).values({ gangId, playerId, permission: row.GP_access })
      .onConflictDoNothing({ target: [gangPermissions.gangId, gangPermissions.playerId, gangPermissions.permission] });
    bumpTable(report, "gangPermissions", "written");
  }

  const [inviteRows] = await pool.query<(InviteRow & mysql.RowDataPacket)[]>(
    "SELECT GI_id, GI_gang, GI_user, GI_gangUser FROM gangInvites",
  );
  for (const row of inviteRows) {
    bumpTable(report, "gangInvites", "read");
    const gangId = await lookupV3Id(exec, "gangs", row.GI_gang);
    const invitedPlayerId = await lookupV3Id(exec, "users", row.GI_user);
    const invitedByPlayerId = await lookupV3Id(exec, "users", row.GI_gangUser);
    if (!gangId || !invitedPlayerId || !invitedByPlayerId) {
      const reason = !gangId ? `gang ${row.GI_gang} does not exist`
        : !invitedPlayerId ? `user ${row.GI_user} does not exist` : `user ${row.GI_gangUser} does not exist`;
      recordOrphan(report, "gangInvites", row.GI_id, reason);
      bumpTable(report, "gangInvites", "skipped");
      continue;
    }
    const { v3Id } = await getOrCreateV3Id(exec, "gangInvites", row.GI_id);
    // V2 keeps no invite timestamp — created_at takes the target default.
    const values = { id: v3Id, gangId, invitedPlayerId, invitedByPlayerId };
    await exec.insert(gangInvites).values(values).onConflictDoUpdate({ target: gangInvites.id, set: values });
    bumpTable(report, "gangInvites", "written");
  }

  const [logRows] = await pool.query<(LogRow & mysql.RowDataPacket)[]>(
    "SELECT GL_id, GL_gang, GL_user, GL_log, GL_time FROM gangLogs",
  );
  for (const row of logRows) {
    bumpTable(report, "gangLogs", "read");
    const gangId = await lookupV3Id(exec, "gangs", row.GL_gang);
    if (!gangId) {
      recordOrphan(report, "gangLogs", row.GL_id, `gang ${row.GL_gang} does not exist`);
      bumpTable(report, "gangLogs", "skipped");
      continue;
    }
    // GL_user 0 = a system log entry, not an orphan (gang_logs.player_id is nullable).
    const playerId = row.GL_user ? await lookupV3Id(exec, "users", row.GL_user) : null;
    if (row.GL_user && !playerId) {
      recordOrphan(report, "gangLogs", row.GL_id, `user ${row.GL_user} does not exist`);
    }
    const { v3Id } = await getOrCreateV3Id(exec, "gangLogs", row.GL_id);
    const values = { id: v3Id, gangId, playerId, message: row.GL_log, createdAt: unixToDate(row.GL_time)! };
    await exec.insert(gangLogs).values(values).onConflictDoUpdate({ target: gangLogs.id, set: values });
    bumpTable(report, "gangLogs", "written");
  }
}
