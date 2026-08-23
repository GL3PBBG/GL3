import { and, eq } from "drizzle-orm";
import type mysql from "mysql2/promise";
import { gangMembers, gangs, playerStats } from "../../../server/src/db/schema/index.js";
import { getOrCreateV3Id, lookupV3Id } from "../id-map.js";
import { bumpTable, recordOrphan, type MigrationReport } from "../report.js";
import type { Executor } from "../pg/types.js";

interface GangRow {
  G_id: number; G_name: string | null; G_boss: number; G_underboss: number;
  G_bank: number; G_money: number; G_bullets: number; G_desc: string | null; G_info: string | null;
  G_level: number; G_location: number;
}
interface GangMembershipRow { US_id: number; US_gang: number; }

async function ensureMember(exec: Executor, gangId: string, playerId: string): Promise<boolean> {
  const [existing] = await exec.select().from(gangMembers)
    .where(and(eq(gangMembers.gangId, gangId), eq(gangMembers.playerId, playerId)));
  if (existing) return false;
  await exec.insert(gangMembers).values({ gangId, playerId })
    .onConflictDoNothing({ target: [gangMembers.gangId, gangMembers.playerId] });
  await exec.update(playerStats).set({ gangId }).where(eq(playerStats.playerId, playerId));
  return true;
}

export async function migrateGangs(pool: mysql.Pool, exec: Executor, report: MigrationReport): Promise<void> {
  const [gangRows] = await pool.query<(GangRow & mysql.RowDataPacket)[]>(
    "SELECT G_id, G_name, G_boss, G_underboss, G_bank, G_money, G_bullets, G_desc, G_info, G_level, G_location FROM gangs",
  );

  const gangIdByV2 = new Map<number, string>();
  for (const row of gangRows) {
    bumpTable(report, "gangs", "read");
    const { v3Id: gangId } = await getOrCreateV3Id(exec, "gangs", row.G_id);
    gangIdByV2.set(row.G_id, gangId);

    const bossPlayerId = await lookupV3Id(exec, "users", row.G_boss);
    if (!bossPlayerId) recordOrphan(report, "gangs", row.G_id, `boss ${row.G_boss} does not exist`);
    // G_underboss/G_location are NOT NULL DEFAULT 0 — 0 means "none".
    const underbossPlayerId = row.G_underboss ? await lookupV3Id(exec, "users", row.G_underboss) : null;
    if (row.G_underboss && !underbossPlayerId) {
      recordOrphan(report, "gangs", row.G_id, `underboss ${row.G_underboss} does not exist`);
    }
    const locationId = row.G_location ? await lookupV3Id(exec, "locations", row.G_location) : null;

    const values = {
      id: gangId, name: row.G_name ?? "", description: row.G_desc ?? "", info: row.G_info ?? "",
      bank: BigInt(row.G_bank), cash: BigInt(row.G_money), bullets: BigInt(row.G_bullets),
      level: row.G_level, locationId, bossPlayerId, underbossPlayerId,
    };
    await exec.insert(gangs).values(values).onConflictDoUpdate({ target: gangs.id, set: values });
    bumpTable(report, "gangs", "written");
  }

  // §4.2 item 5: US_gang > 0 becomes a gang_members row.
  const [membershipRows] = await pool.query<(GangMembershipRow & mysql.RowDataPacket)[]>(
    "SELECT US_id, US_gang FROM userStats WHERE US_gang > 0",
  );
  for (const row of membershipRows) {
    bumpTable(report, "US_gang", "read");
    const gangId = gangIdByV2.get(row.US_gang) ?? await lookupV3Id(exec, "gangs", row.US_gang);
    if (!gangId) {
      recordOrphan(report, "US_gang", row.US_id, `gang ${row.US_gang} does not exist`);
      bumpTable(report, "US_gang", "skipped");
      continue;
    }
    const playerId = await lookupV3Id(exec, "users", row.US_id);
    if (!playerId) { bumpTable(report, "US_gang", "skipped"); continue; }
    await ensureMember(exec, gangId, playerId);
    bumpTable(report, "US_gang", "written");
  }

  // §4.2 item 5 + "Known unknowns" item 4: a boss (or underboss) not in
  // their own gang gets a report entry AND a membership row created.
  for (const row of gangRows) {
    const gangId = gangIdByV2.get(row.G_id);
    if (!gangId) continue;

    const bossPlayerId = await lookupV3Id(exec, "users", row.G_boss);
    if (bossPlayerId && (await ensureMember(exec, gangId, bossPlayerId))) {
      report.bossNotInGang.push({ gangV2Id: row.G_id, bossV2Id: row.G_boss });
    }

    if (row.G_underboss) {
      const underbossPlayerId = await lookupV3Id(exec, "users", row.G_underboss);
      if (underbossPlayerId && (await ensureMember(exec, gangId, underbossPlayerId))) {
        report.underbossNotInGang.push({ gangV2Id: row.G_id, underbossV2Id: row.G_underboss });
      }
    }
  }
}
