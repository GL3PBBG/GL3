import { eq } from "drizzle-orm";
import type mysql from "mysql2/promise";
import { idMap } from "../../../server/src/db/schema/index.js";
import { coursesDone, coursesPlugin, educationProgress, housesPlugin, jobRanks, jobsPlugin, playerJobs } from "../pg/plugin-tables.js";
import { getOrCreateV3Id, lookupV3Id, setV3Id } from "../id-map.js";
import {
  bumpTable, recordAbsentTargetTable, recordDroppedProgress, recordOrdinalKeyedTable,
  type MigrationReport,
} from "../report.js";
import { targetHas } from "../pg/plugin-tables.js";
import type { Executor } from "../pg/types.js";

/**
 * MCCodes `houses`, `courses`/`coursesdone`, `jobs`/`jobranks` -> the
 * C-family's plugin tables (B3 Task 12, spec §4 phase 2 + §7). Catalogs are
 * the game's own content — a real dump's rows import, not the stock empty
 * lists. Progress imports where reconstructible (§7's correction of the
 * approved drop framing): `cdays` counts DOWN daily, so
 * started_at = now - (crdays_elapsed) days preserves progress to the day;
 * completed courses import on the ordinal key; current employment imports
 * with a fresh wage stamp — no retroactive wages (item 14's faucet guard).
 */
interface HouseRow { hID: number; hNAME: string; hPRICE: number; hWILL: number; }
interface CourseRow {
  crID: number; crNAME: string; crDESC: string; crCOST: number; crDAYS: number;
  crSTR: number; crGUARD: number; crLABOUR: number; crAGIL: number; crIQ: number;
}
interface CoursesDoneRow { userid: number; courseid: number; }
interface UserCourseRow { userid: number; course: number; cdays: number; }
interface JobRow { jID: number; jNAME: string; jFIRST: number; jDESC: string; }
interface JobRankRow {
  jrID: number; jrNAME: string; jrJOB: number; jrPAY: number;
  jrIQG: number; jrLABOURG: number; jrSTRG: number;
  jrIQN: number; jrLABOURN: number; jrSTRN: number;
}
interface UserJobRow { userid: number; jobrank: number; }

export async function migrateMcHousesEducationJobs(
  pool: mysql.Pool, exec: Executor, report: MigrationReport,
  targetTables?: ReadonlySet<string>,
): Promise<void> {
  const familyPresent =
    targetHas(targetTables, "p_houses_houses") && targetHas(targetTables, "p_education_courses")
    && targetHas(targetTables, "p_jobs_jobs");
  if (!familyPresent) {
    for (const table of ["p_houses_houses", "p_education_courses", "p_education_progress", "p_education_courses_done", "p_jobs_jobs", "p_jobs_ranks", "p_jobs_players"]) {
      if (!targetHas(targetTables, table)) recordAbsentTargetTable(report, table);
    }
    return;
  }

  // --- houses: the catalog; ownership never existed to migrate (maxwill IS
  //     the house, audit §4.7 — the player's will/willMax carry the state).
  //     The plugin's own migration seeds a Default House (will 100), and the
  //     stock MCCodes dump ships the same row — so before generating a new
  //     uuid, adopt an existing target row no id_map entry claims yet,
  //     matched on `will` (the functional key: the plugin's currentHouse
  //     resolves a player's house by willMax, so two rows sharing a will
  //     value would be ambiguous at runtime, not just cosmetic).
  const [houseRows] = await pool.query<(HouseRow & mysql.RowDataPacket)[]>(
    "SELECT hID, hNAME, hPRICE, hWILL FROM houses",
  );
  const claimedHouseIds = new Set(
    (await exec.select({ v3Id: idMap.v3Id }).from(idMap).where(eq(idMap.v2Table, "houses")))
      .map((r) => r.v3Id),
  );
  const adoptableByWill = new Map<number, string>();
  for (const h of await exec.select().from(housesPlugin)) {
    if (!claimedHouseIds.has(h.id)) adoptableByWill.set(h.will, h.id);
  }
  for (const row of houseRows) {
    bumpTable(report, "houses", "read");
    let v3Id = await lookupV3Id(exec, "houses", row.hID);
    if (v3Id === null) {
      const adopted = adoptableByWill.get(row.hWILL);
      if (adopted !== undefined) {
        v3Id = adopted;
        await setV3Id(exec, "houses", row.hID, v3Id);
      } else {
        v3Id = (await getOrCreateV3Id(exec, "houses", row.hID)).v3Id;
      }
    }
    adoptableByWill.delete(row.hWILL);
    const values = { id: v3Id, name: row.hNAME, price: BigInt(row.hPRICE), will: row.hWILL };
    await exec.insert(housesPlugin).values(values)
      .onConflictDoUpdate({ target: housesPlugin.id, set: values });
    bumpTable(report, "houses", "written");
  }

  // --- courses catalog.
  const [courseRows] = await pool.query<(CourseRow & mysql.RowDataPacket)[]>(
    "SELECT crID, crNAME, crDESC, crCOST, crDAYS, crSTR, crGUARD, crLABOUR, crAGIL, crIQ FROM courses",
  );
  for (const row of courseRows) {
    bumpTable(report, "courses", "read");
    const { v3Id } = await getOrCreateV3Id(exec, "courses", row.crID);
    const values = {
      id: v3Id, name: row.crNAME, description: row.crDESC,
      cost: BigInt(row.crCOST), days: row.crDAYS,
      strengthGain: row.crSTR, agilityGain: row.crAGIL, guardGain: row.crGUARD,
      labourGain: row.crLABOUR, iqGain: row.crIQ,
    };
    await exec.insert(coursesPlugin).values(values)
      .onConflictDoUpdate({ target: coursesPlugin.id, set: values });
    bumpTable(report, "courses", "written");
  }

  // --- jobs: ranks first (jobs.first_rank_id is NOT NULL), then jobs, then
  //     employment with a fresh wage stamp. The source is circular — ranks
  //     reference jobs, jobs reference their first rank — so every job's
  //     id_map row exists before either write loop runs.
  const [rankRows] = await pool.query<(JobRankRow & mysql.RowDataPacket)[]>(
    "SELECT jrID, jrNAME, jrJOB, jrPAY, jrIQG, jrLABOURG, jrSTRG, jrIQN, jrLABOURN, jrSTRN FROM jobranks",
  );
  const [jobRows] = await pool.query<(JobRow & mysql.RowDataPacket)[]>(
    "SELECT jID, jNAME, jFIRST, jDESC FROM jobs",
  );
  for (const row of jobRows) {
    await getOrCreateV3Id(exec, "jobs", row.jID);
  }
  for (const row of rankRows) {
    bumpTable(report, "jobranks", "read");
    const { v3Id } = await getOrCreateV3Id(exec, "jobranks", row.jrID);
    const jobId = await lookupV3Id(exec, "jobs", row.jrJOB);
    if (jobId === null) {
      recordDroppedProgress(report, 0, "jobranks", `job ${row.jrJOB} was not migrated`);
      bumpTable(report, "jobranks", "skipped");
      continue;
    }
    const values = {
      id: v3Id, jobId, name: row.jrNAME, pay: BigInt(row.jrPAY),
      strengthGain: row.jrSTRG, labourGain: row.jrLABOURG, iqGain: row.jrIQG,
      strengthReq: row.jrSTRN, labourReq: row.jrLABOURN, iqReq: row.jrIQN,
    };
    await exec.insert(jobRanks).values(values)
      .onConflictDoUpdate({ target: jobRanks.id, set: values });
    bumpTable(report, "jobranks", "written");
  }

  for (const row of jobRows) {
    bumpTable(report, "jobs", "read");
    const { v3Id } = await getOrCreateV3Id(exec, "jobs", row.jID);
    const firstRankId = await lookupV3Id(exec, "jobranks", row.jFIRST);
    if (firstRankId === null) {
      recordDroppedProgress(report, 0, "jobs", `first rank ${row.jFIRST} was not migrated`);
      bumpTable(report, "jobs", "skipped");
      continue;
    }
    const values = { id: v3Id, name: row.jNAME, description: row.jDESC, firstRankId };
    await exec.insert(jobsPlugin).values(values)
      .onConflictDoUpdate({ target: jobsPlugin.id, set: values });
    bumpTable(report, "jobs", "written");
  }

}

/**
 * The progress half of Task 12 — completed courses, in-flight study, and
 * current employment. Runs AFTER the players phase: every row here resolves
 * a `users` id_map entry (and the plugin FKs need the players row to
 * exist), where the catalogs above must run BEFORE players so the
 * equipment classifier and these lookups both find their content.
 */
export async function migrateMcProgress(
  pool: mysql.Pool, exec: Executor, report: MigrationReport,
  targetTables?: ReadonlySet<string>,
): Promise<void> {
  const familyPresent =
    targetHas(targetTables, "p_education_courses") && targetHas(targetTables, "p_jobs_jobs");
  if (!familyPresent) return; // absence already reported by the catalog pass

  // --- completed courses (PK-less: ordinal id_map keys).
  const [doneRows] = await pool.query<(CoursesDoneRow & mysql.RowDataPacket)[]>(
    "SELECT userid, courseid FROM coursesdone",
  );
  recordOrdinalKeyedTable(report, "coursesdone");
  let doneOrdinal = 0;
  for (const row of doneRows) {
    bumpTable(report, "coursesdone", "read");
    doneOrdinal += 1;
    const playerId = await lookupV3Id(exec, "users", row.userid);
    const courseId = await lookupV3Id(exec, "courses", row.courseid);
    if (playerId === null || courseId === null) {
      recordDroppedProgress(report, row.userid, "coursesdone",
        `user ${row.userid} or course ${row.courseid} was not migrated`);
      bumpTable(report, "coursesdone", "skipped");
      continue;
    }
    // The id_map row exists so a re-run resolves the same ordinal; the
    // target row is keyed (player, course) and conflict-ignored either way.
    await getOrCreateV3Id(exec, "coursesdone", doneOrdinal);
    await exec.insert(coursesDone).values({ playerId, courseId })
      .onConflictDoNothing({ target: [coursesDone.playerId, coursesDone.courseId] });
    bumpTable(report, "coursesdone", "written");
  }

  // --- in-flight courses: started_at reconstructed from cdays.
  const [inFlightRows] = await pool.query<(UserCourseRow & mysql.RowDataPacket)[]>(
    "SELECT userid, course, cdays FROM users WHERE course > 0 AND cdays > 0",
  );
  const [courseDayRows] = await pool.query<(mysql.RowDataPacket & { crID: number; crDAYS: number })[]>(
    "SELECT crID, crDAYS FROM courses",
  );
  const totalDaysByCourse = new Map(courseDayRows.map((r) => [r.crID, r.crDAYS]));
  const now = new Date();
  for (const row of inFlightRows) {
    bumpTable(report, "users.course", "read");
    const playerId = await lookupV3Id(exec, "users", row.userid);
    const courseId = await lookupV3Id(exec, "courses", row.course);
    const totalDays = totalDaysByCourse.get(row.course);
    if (playerId === null || courseId === null || totalDays === undefined) {
      recordDroppedProgress(report, row.userid, "course",
        `course ${row.course} was not migrated (user's in-flight study lost)`);
      bumpTable(report, "users.course", "skipped");
      continue;
    }
    const elapsedDays = Math.max(0, totalDays - row.cdays);
    const values = {
      playerId, courseId,
      startedAt: new Date(now.getTime() - elapsedDays * 86_400_000),
    };
    await exec.insert(educationProgress).values(values)
      .onConflictDoUpdate({ target: educationProgress.playerId, set: values });
    bumpTable(report, "users.course", "written");
  }

  // --- current employment with a fresh wage stamp.
  const [employedRows] = await pool.query<(UserJobRow & mysql.RowDataPacket)[]>(
    "SELECT userid, jobrank FROM users WHERE jobrank > 0",
  );
  for (const row of employedRows) {
    bumpTable(report, "users.jobrank", "read");
    const playerId = await lookupV3Id(exec, "users", row.userid);
    const rankId = await lookupV3Id(exec, "jobranks", row.jobrank);
    if (playerId === null || rankId === null) {
      recordDroppedProgress(report, row.userid, "job",
        `jobrank ${row.jobrank} was not migrated (employment lost)`);
      bumpTable(report, "users.jobrank", "skipped");
      continue;
    }
    // last_wage_at = now: the lazy whole-days settle grants nothing until a
    // real day passes — no retroactive faucet (audit §7 item 14).
    const values = { playerId, rankId, lastWageAt: now };
    await exec.insert(playerJobs).values(values)
      .onConflictDoUpdate({ target: playerJobs.playerId, set: values });
    bumpTable(report, "users.jobrank", "written");
  }
}
