import { eq } from "drizzle-orm";
import type mysql from "mysql2/promise";
import { playerStats, playerTimers } from "../../../server/src/db/schema/index.js";
import { lookupV3Id } from "../id-map.js";
import { bumpTable, recordOrphan, recordUnknownTimerKey, type MigrationReport } from "../report.js";
import type { Executor } from "../pg/types.js";
import { unixToDate } from "../time.js";

// V2's timer key column is UT_desc (class/user.php writes UT_desc, not UT_key).
interface UserTimerRow { UT_user: number; UT_desc: string; UT_time: number; }

/** SPEC §1.2's observed keys. Anything else still migrates — just gets a report entry. */
const KNOWN_TIMER_KEYS = new Set([
  "jail", "hospital", "crime", "membership", "sentMail", "signup",
  "killed", "superMax", "laston", "forumMute", "forumTopic", "forumPost", "glDirVote", "count",
]);

export async function migrateTimers(pool: mysql.Pool, exec: Executor, report: MigrationReport): Promise<void> {
  const [rows] = await pool.query<(UserTimerRow & mysql.RowDataPacket)[]>(
    "SELECT UT_user, UT_desc, UT_time FROM userTimers",
  );
  const now = new Date();

  for (const row of rows) {
    bumpTable(report, "userTimers", "read");

    const playerId = await lookupV3Id(exec, "users", row.UT_user);
    if (!playerId) {
      recordOrphan(report, "userTimers", row.UT_user, `user ${row.UT_user} does not exist`);
      bumpTable(report, "userTimers", "skipped");
      continue;
    }

    const expiresAt = unixToDate(row.UT_time);
    if (!expiresAt || expiresAt <= now) {
      // §4.2 item 6: past timers are dropped, full stop — including 'jail'/'hospital'.
      bumpTable(report, "userTimers", "skipped");
      continue;
    }

    if (!KNOWN_TIMER_KEYS.has(row.UT_desc)) recordUnknownTimerKey(report, row.UT_desc);

    if (row.UT_desc === "jail") {
      await exec.update(playerStats).set({ jailedUntil: expiresAt }).where(eq(playerStats.playerId, playerId));
    } else if (row.UT_desc === "hospital") {
      await exec.update(playerStats).set({ hospitalUntil: expiresAt }).where(eq(playerStats.playerId, playerId));
    } else {
      await exec.insert(playerTimers).values({ playerId, key: row.UT_desc, expiresAt })
          .onConflictDoUpdate({ target: [playerTimers.playerId, playerTimers.key], set: { expiresAt } });
    }
    bumpTable(report, "userTimers", "written");
  }
}
