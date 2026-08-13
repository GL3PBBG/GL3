import type mysql from "mysql2/promise";
import { playerCrimeSkill } from "../../../server/src/db/schema/index.js";
import { lookupV3Id } from "../id-map.js";
import { bumpTable, recordDroppedCrimePosition, type MigrationReport } from "../report.js";
import type { Executor } from "../pg/types.js";

interface UserStatsCrimesRow { US_id: number; US_crimes: string; }
interface CrimeIdRow { C_id: number; }
interface DefaultRow { COLUMN_DEFAULT: string | null; }

async function fetchBaseDefault(pool: mysql.Pool): Promise<string> {
  const [rows] = await pool.query<(DefaultRow & mysql.RowDataPacket)[]>(
    "SELECT COLUMN_DEFAULT FROM INFORMATION_SCHEMA.COLUMNS " +
    "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'userStats' AND COLUMN_NAME = 'US_crimes'",
  );
  const raw = rows[0]?.COLUMN_DEFAULT ?? "";
  // MariaDB/MySQL INFORMATION_SCHEMA returns string defaults wrapped in
  // single quotes (e.g. '35-25-15-5-5'). Strip them.
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  return raw;
}

export async function migrateCrimeSkill(pool: mysql.Pool, exec: Executor, report: MigrationReport): Promise<void> {
  const [crimeRows] = await pool.query<(CrimeIdRow & mysql.RowDataPacket)[]>("SELECT C_id FROM crimes");
  const crimeIdByPosition = new Map(crimeRows.map((c) => [c.C_id - 1, c.C_id]));

  const baseDefault = await fetchBaseDefault(pool);
  const baseParts = baseDefault.split("-");

  const [statsRows] = await pool.query<(UserStatsCrimesRow & mysql.RowDataPacket)[]>(
    "SELECT US_id, US_crimes FROM userStats",
  );

  for (const stats of statsRows) {
    const playerId = await lookupV3Id(exec, "users", stats.US_id);
    if (!playerId) continue; // orphan already reported by the players migrator (Task 20)

    const playerParts = stats.US_crimes.split("-");
    const written = new Set<number>(); // crime ids already handled from the player's own string

    // Positions in the player's own string. A position with no matching
    // crime id (an id gap from a deleted crime) is dropped and reported.
    for (const [index, value] of playerParts.entries()) {
      const crimeId = crimeIdByPosition.get(index);
      if (crimeId === undefined) {
        recordDroppedCrimePosition(report, stats.US_id, index);
        continue;
      }
      const crimeUuid = await lookupV3Id(exec, "crimes", crimeId);
      if (!crimeUuid) continue;
      await exec.insert(playerCrimeSkill).values({ playerId, crimeId: crimeUuid, chance: value })
        .onConflictDoUpdate({ target: [playerCrimeSkill.playerId, playerCrimeSkill.crimeId], set: { chance: value } });
      written.add(crimeId);
      bumpTable(report, "US_crimes", "written");
    }

    // Existing crimes whose position the player's own string never reached
    // (e.g. the crime was added after this player's row was last written)
    // fall back to the schema default's value at that same position.
    for (const [index, crimeId] of crimeIdByPosition.entries()) {
      if (written.has(crimeId) || index < playerParts.length) continue;
      const fallback = baseParts[index];
      if (fallback === undefined) continue; // neither the player's nor the base string reaches this far
      const crimeUuid = await lookupV3Id(exec, "crimes", crimeId);
      if (!crimeUuid) continue;
      await exec.insert(playerCrimeSkill).values({ playerId, crimeId: crimeUuid, chance: fallback })
        .onConflictDoUpdate({ target: [playerCrimeSkill.playerId, playerCrimeSkill.crimeId], set: { chance: fallback } });
      bumpTable(report, "US_crimes", "written");
    }
  }
}
