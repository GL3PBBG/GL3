import type mysql from "mysql2/promise";
import { parseSuccessFormula } from "@gl3/plugin-crimes";
import { crimes } from "../../../server/src/db/schema/index.js";
import { getOrCreateV3Id } from "../id-map.js";
import { bumpTable, recordDroppedColumns, recordPercformReject, type MigrationReport } from "../report.js";
import type { Executor } from "../pg/types.js";

/**
 * MCCodes `crimes` + `crimegroups` -> GL3 `crimes` (B3 Task 11, spec §4
 * phase 2 + §5). The column mapping is audit §7 items 4/5/13: payout is
 * MCCodes' static figure (min = max), exp is the per-success formula
 * trunc(muny/8) — exact, because the payout is static — crime_exp_reward
 * carries crimeXP, jail is the 50/50 coin-flip landed as
 * jail_chance_percent 50 with crimeJAILTIME minutes as seconds, cooldown 0
 * (a pure-MCCodes profile: brave is the throttle), min_rank 0 (an MCCodes
 * crime's level gate, if any, lives inside its formula), and sort comes
 * from the group ordering.
 *
 * The PERCFORM rule (§5): validate with the SAME parser the resolve job
 * evaluates — one grammar, two consumers. Fits -> verbatim (the five tokens
 * are already the dialect's). Doesn't -> NULL + a report entry carrying the
 * original verbatim. Never fail a migration over a formula; never guess.
 */
interface CrimeRow {
  crimeID: number; crimeNAME: string; crimeBRAVE: number; crimePERCFORM: string;
  crimeSUCCESSMUNY: number; crimeSUCCESSCRYS: number; crimeSUCCESSITEM: number;
  crimeGROUP: number; crimeITEXT: string; crimeJAILTIME: number; crimeXP: number;
}
interface CrimeGroupRow { cgID: number; cgORDER: number; }

export async function migrateMcCrimes(pool: mysql.Pool, exec: Executor, report: MigrationReport): Promise<void> {
  const [groupRows] = await pool.query<(CrimeGroupRow & mysql.RowDataPacket)[]>(
    "SELECT cgID, cgORDER FROM crimegroups",
  );
  const orderByGroup = new Map(groupRows.map((r) => [r.cgID, r.cgORDER]));

  const [rows] = await pool.query<(CrimeRow & mysql.RowDataPacket)[]>(
    "SELECT crimeID, crimeNAME, crimeBRAVE, crimePERCFORM, crimeSUCCESSMUNY, crimeSUCCESSCRYS, " +
    "crimeSUCCESSITEM, crimeGROUP, crimeITEXT, crimeJAILTIME, crimeXP FROM crimes",
  );
  for (const row of rows) {
    bumpTable(report, "crimes", "read");
    const { v3Id } = await getOrCreateV3Id(exec, "crimes", row.crimeID);

    let successFormula: string | null = null;
    try {
      parseSuccessFormula(row.crimePERCFORM);
      successFormula = row.crimePERCFORM;
    } catch {
      // The overwhelmingly common case fits; PHP-isms and randomness
      // (rand is MCCodes' outcome roll, not a chance input) do not.
      recordPercformReject(report, row.crimeID, row.crimePERCFORM);
    }

    const payout = BigInt(row.crimeSUCCESSMUNY);
    const values = {
      id: v3Id,
      name: row.crimeNAME,
      description: row.crimeITEXT,
      cooldownSeconds: 0,
      minPayout: payout,
      maxPayout: payout,
      expReward: BigInt(Math.trunc(row.crimeSUCCESSMUNY / 8)),
      crimeExpReward: BigInt(row.crimeXP),
      jailChancePercent: 50,
      jailSeconds: row.crimeJAILTIME * 60,
      braveCost: row.crimeBRAVE,
      minRank: 0,
      // Group order, then the source id: crimes in one group list together
      // without colliding on sort.
      sort: (orderByGroup.get(row.crimeGROUP) ?? 0) * 1000 + row.crimeID,
      successFormula,
    };
    await exec.insert(crimes).values(values).onConflictDoUpdate({ target: crimes.id, set: values });
    bumpTable(report, "crimes", "written");
  }

  // No GL3 surface: crystals/item rewards (crimes pay cash, bullets, exp,
  // crime exp) and the outcome texts (GL3 renders its own).
  recordDroppedColumns(report, "crimes", [
    "crimeSUCCESSCRYS", "crimeSUCCESSITEM", "crimeSTEXT", "crimeFTEXT", "crimeJTEXT", "crimeJREASON",
  ], rows.length);
}
