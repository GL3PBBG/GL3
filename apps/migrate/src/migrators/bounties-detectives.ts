import type mysql from "mysql2/promise";
import { bounties, detectiveSearches } from "../pg/plugin-tables.js";
import { getOrCreateV3Id, lookupV3Id } from "../id-map.js";
import { bumpTable, recordOrphan, type MigrationReport } from "../report.js";
import type { Executor } from "../pg/types.js";
import { unixToDate } from "../time.js";

// V2's bounties table carries no timestamp (B_id/B_user/B_userToKill/B_cost
// only) — created_at takes the target default. Detectives does carry the
// hired count (D_detectives) alongside D_userToFind for the target.
interface BountyRow { B_id: number; B_user: number; B_userToKill: number; B_cost: number; }
interface DetectiveRow { D_id: number; D_user: number; D_userToFind: number; D_detectives: number; D_start: number; D_end: number; D_success: number | null; }

export async function migrateBountiesAndDetectives(pool: mysql.Pool, exec: Executor, report: MigrationReport): Promise<void> {
  const [bountyRows] = await pool.query<(BountyRow & mysql.RowDataPacket)[]>(
    "SELECT B_id, B_user, B_userToKill, B_cost FROM bounties",
  );
  for (const row of bountyRows) {
    bumpTable(report, "bounties", "read");
    const placedBy = await lookupV3Id(exec, "users", row.B_user);
    const target = await lookupV3Id(exec, "users", row.B_userToKill);
    if (!placedBy || !target) {
      const reason = !placedBy ? `placer ${row.B_user} does not exist` : `target ${row.B_userToKill} does not exist`;
      recordOrphan(report, "bounties", row.B_id, reason);
      bumpTable(report, "bounties", "skipped");
      continue;
    }
    const { v3Id } = await getOrCreateV3Id(exec, "bounties", row.B_id);
    // "Known unknowns" item 5: V2 has no claimant column — every migrated row is open.
    const values = { id: v3Id, placedBy, target, amount: BigInt(row.B_cost), claimedBy: null };
    await exec.insert(bounties).values(values).onConflictDoUpdate({ target: bounties.id, set: values });
    bumpTable(report, "bounties", "written");
  }

  const [detectiveRows] = await pool.query<(DetectiveRow & mysql.RowDataPacket)[]>(
    "SELECT D_id, D_user, D_userToFind, D_detectives, D_start, D_end, D_success FROM detectives",
  );
  for (const row of detectiveRows) {
    bumpTable(report, "detectives", "read");
    const playerId = await lookupV3Id(exec, "users", row.D_user);
    const targetPlayerId = await lookupV3Id(exec, "users", row.D_userToFind);
    if (!playerId || !targetPlayerId) {
      const reason = !playerId ? `searcher ${row.D_user} does not exist` : `target ${row.D_userToFind} does not exist`;
      recordOrphan(report, "detectives", row.D_id, reason);
      bumpTable(report, "detectives", "skipped");
      continue;
    }
    const { v3Id } = await getOrCreateV3Id(exec, "detectives", row.D_id);
    // D_success is decided at insert time (0/1), never updated — a plain
    // boolean, not a pending state.
    const values = {
      id: v3Id, playerId, targetPlayerId, detectives: row.D_detectives,
      startedAt: unixToDate(row.D_start)!, endsAt: unixToDate(row.D_end)!,
      succeeded: row.D_success === null ? null : Boolean(row.D_success),
    };
    await exec.insert(detectiveSearches).values(values).onConflictDoUpdate({ target: detectiveSearches.id, set: values });
    bumpTable(report, "detectives", "written");
  }
}
