import type mysql from "mysql2/promise";
import { eq } from "drizzle-orm";
import { gangLogs, gangMembers, gangs as gangsTable, playerStats } from "../../../server/src/db/schema/index.js";
import { getOrCreateV3Id, lookupV3Id } from "../id-map.js";
import { bumpTable, recordDroppedColumns, type MigrationReport } from "../report.js";
import type { Executor } from "../pg/types.js";

/**
 * MCCodes `gangs` + `gangevents` -> GL3 `gangs` + `gang_members` +
 * `gang_logs` (B3 Task 13, spec §4 phase 4). gangMONEY -> bank (the vault;
 * cash stays 0 — MCCodes gangs have one treasury, item 11), gangCRYSTALS ->
 * points, gangRESPECT -> respect (data before mechanics — the wars wave is
 * deferred), president/vice-pres -> boss/underboss. gangwars/surrenders and
 * the in-flight OC drop with report entries: GL3 has no war model, and
 * `orgcrimes`' catalog shape fits neither p_oc_heists (a runtime session
 * table) nor any other surface — the spec's own misfit rule.
 */
interface GangRow {
  gangID: number; gangNAME: string; gangDESC: string;
  gangMONEY: number; gangCRYSTALS: number; gangRESPECT: number;
  gangPRESIDENT: number; gangVICEPRES: number; gangCAPACITY: number;
}
interface GangEventRow { gevID: number; gevGANG: number; gevTIME: number; gevTEXT: string; }

export async function migrateMcGangs(pool: mysql.Pool, exec: Executor, report: MigrationReport): Promise<void> {
  const [gangRows] = await pool.query<(GangRow & mysql.RowDataPacket)[]>(
    "SELECT gangID, gangNAME, gangDESC, gangMONEY, gangCRYSTALS, gangRESPECT, " +
    "gangPRESIDENT, gangVICEPRES, gangCAPACITY FROM gangs",
  );
  const [userGangRows] = await pool.query<(mysql.RowDataPacket & { userid: number; gang: number; daysingang: number })[]>(
    "SELECT userid, gang, daysingang FROM users WHERE gang > 0",
  );
  const membersByGang = new Map<number, { userid: number; daysingang: number }[]>();
  for (const row of userGangRows) {
    const bucket = membersByGang.get(row.gang) ?? [];
    bucket.push({ userid: row.userid, daysingang: row.daysingang });
    membersByGang.set(row.gang, bucket);
  }
  const now = new Date();

  for (const row of gangRows) {
    bumpTable(report, "gangs", "read");
    const { v3Id } = await getOrCreateV3Id(exec, "gangs", row.gangID);
    const bossPlayerId = await lookupV3Id(exec, "users", row.gangPRESIDENT);
    const underbossPlayerId = await lookupV3Id(exec, "users", row.gangVICEPRES);
    const values = {
      id: v3Id,
      name: row.gangNAME,
      description: row.gangDESC,
      bank: BigInt(row.gangMONEY),
      points: BigInt(row.gangCRYSTALS),
      respect: BigInt(row.gangRESPECT),
      bossPlayerId,
      underbossPlayerId,
    };
    await exec.insert(gangsTable).values(values)
      .onConflictDoUpdate({ target: gangsTable.id, set: values });
    bumpTable(report, "gangs", "written");

    for (const member of membersByGang.get(row.gangID) ?? []) {
      bumpTable(report, "users.gang", "read");
      const playerId = await lookupV3Id(exec, "users", member.userid);
      if (playerId === null) continue;
      // daysingang counts back from migration — joined_at is the same
      // reconstruction the education progress uses.
      const joinedAt = new Date(now.getTime() - member.daysingang * 86_400_000);
      await exec.insert(gangMembers).values({ gangId: v3Id, playerId, joinedAt })
        .onConflictDoUpdate({ target: [gangMembers.gangId, gangMembers.playerId], set: { joinedAt } });
      // The member's gang_id on player_stats — the players phase left it
      // null for exactly this migrator to fill.
      await exec.update(playerStats).set({ gangId: v3Id })
        .where(eq(playerStats.playerId, playerId));
      bumpTable(report, "users.gang", "written");
    }
  }

  // gangevents -> gang_logs (the per-gang feed).
  const [eventRows] = await pool.query<(GangEventRow & mysql.RowDataPacket)[]>(
    "SELECT gevID, gevGANG, gevTIME, gevTEXT FROM gangevents",
  );
  for (const row of eventRows) {
    bumpTable(report, "gangevents", "read");
    const gangId = await lookupV3Id(exec, "gangs", row.gevGANG);
    if (gangId === null) {
      bumpTable(report, "gangevents", "skipped");
      continue;
    }
    const { v3Id: logId } = await getOrCreateV3Id(exec, "gangevents", row.gevID);
    await exec.insert(gangLogs).values({
      id: logId, gangId, message: row.gevTEXT,
      createdAt: row.gevTIME > 0 ? new Date(row.gevTIME * 1000) : new Date(),
    }).onConflictDoUpdate({
      target: gangLogs.id,
      set: { message: row.gevTEXT },
    });
    bumpTable(report, "gangevents", "written");
  }

  // Drops: no GL3 surface for wars/surrenders (the documented deferred
  // wave), the affixes, capacity, or the in-flight OC clock. orgcrimes'
  // catalog fits no table (p_oc_heists is a runtime session shape).
  const [warCount] = await pool.query<(mysql.RowDataPacket & { n: number })[]>(
    "SELECT COUNT(*) AS n FROM gangwars");
  const [surrenderCount] = await pool.query<(mysql.RowDataPacket & { n: number })[]>(
    "SELECT COUNT(*) AS n FROM surrenders");
  const [ocCount] = await pool.query<(mysql.RowDataPacket & { n: number })[]>(
    "SELECT COUNT(*) AS n FROM orgcrimes");
  const [ocLogCount] = await pool.query<(mysql.RowDataPacket & { n: number })[]>(
    "SELECT COUNT(*) AS n FROM oclogs");
  // Applications don't fit gang_invites: an MCCodes application is
  // self-initiated (no inviter row to satisfy invited_by), the inverse flow.
  const [appCount] = await pool.query<(mysql.RowDataPacket & { n: number })[]>(
    "SELECT COUNT(*) AS n FROM applications");
  recordDroppedColumns(report, "gangs", [
    "gangPREF", "gangSUFF", "gangCAPACITY", "gangCRIME", "gangCHOURS", "gangAMENT",
  ], gangRows.length);
  recordDroppedColumns(report, "gangwars", ["*"], Number(warCount[0]?.n ?? 0));
  recordDroppedColumns(report, "surrenders", ["*"], Number(surrenderCount[0]?.n ?? 0));
  recordDroppedColumns(report, "orgcrimes", ["*"], Number(ocCount[0]?.n ?? 0));
  recordDroppedColumns(report, "oclogs", ["*"], Number(ocLogCount[0]?.n ?? 0));
  recordDroppedColumns(report, "applications", ["*"], Number(appCount[0]?.n ?? 0));
}
