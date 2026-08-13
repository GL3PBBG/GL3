import type mysql from "mysql2/promise";
import { gameNews, mailMessages, notifications } from "../../../server/src/db/schema/index.js";
import { getOrCreateV3Id, lookupV3Id } from "../id-map.js";
import { bumpTable, recordOrphan, type MigrationReport } from "../report.js";
import type { Executor } from "../pg/types.js";
import { unixToDate } from "../time.js";

interface MailRow {
  M_id: number; M_parent: number | null; M_sender: number | null; M_recipient: number;
  M_subject: string; M_body: string | null; M_time: number;
}
interface NotificationRow { N_id: number; N_user: number; N_body: string; N_time: number; }
interface NewsRow { GN_id: number; GN_author: number | null; GN_title: string; GN_body: string | null; GN_time: number; }

/** "Known unknowns" item 7: GL3's thread_id is a flat grouping key; V2's
 * M_parent is a parent pointer that can chain to arbitrary depth. Walks to
 * the ultimate root once per message, memoized, with cycle protection
 * (V2 has no FK enforcement, so a malformed parent cycle is possible). */
function resolveRootId(
  id: number,
  parentById: Map<number, number | null>,
  memo: Map<number, number>,
  visiting: Set<number> = new Set(),
): number {
  const cached = memo.get(id);
  if (cached !== undefined) return cached;
  if (visiting.has(id)) return id; // cycle guard: treat as its own root
  visiting.add(id);
  const parent = parentById.get(id) ?? null;
  const root = parent === null || !parentById.has(parent) ? id : resolveRootId(parent, parentById, memo, visiting);
  memo.set(id, root);
  return root;
}

export async function migrateSocial(pool: mysql.Pool, exec: Executor, report: MigrationReport): Promise<void> {
  const [mailRows] = await pool.query<(MailRow & mysql.RowDataPacket)[]>(
    "SELECT M_id, M_parent, M_sender, M_recipient, M_subject, M_body, M_time FROM mail",
  );
  const parentById = new Map(mailRows.map((r) => [r.M_id, r.M_parent]));
  const rootMemo = new Map<number, number>();
  const threadV3ByRootV2 = new Map<number, string>();

  for (const row of mailRows) {
    bumpTable(report, "mail", "read");
    const recipientId = await lookupV3Id(exec, "users", row.M_recipient);
    if (!recipientId) {
      recordOrphan(report, "mail", row.M_id, `recipient ${row.M_recipient} does not exist`);
      bumpTable(report, "mail", "skipped");
      continue;
    }
    const senderId = row.M_sender !== null ? await lookupV3Id(exec, "users", row.M_sender) : null;

    const rootV2Id = resolveRootId(row.M_id, parentById, rootMemo);
    const { v3Id: messageId } = await getOrCreateV3Id(exec, "mail", row.M_id);
    let threadId = threadV3ByRootV2.get(rootV2Id);
    if (!threadId) {
      threadId = (await getOrCreateV3Id(exec, "mail", rootV2Id)).v3Id;
      threadV3ByRootV2.set(rootV2Id, threadId);
    }

    const values = {
      id: messageId, threadId, senderId, recipientId,
      subject: row.M_subject, body: row.M_body ?? "", createdAt: unixToDate(row.M_time)!,
    };
    await exec.insert(mailMessages).values(values).onConflictDoUpdate({ target: mailMessages.id, set: values });
    bumpTable(report, "mail", "written");
  }

  const [notifRows] = await pool.query<(NotificationRow & mysql.RowDataPacket)[]>(
    "SELECT N_id, N_user, N_body, N_time FROM notifications",
  );
  for (const row of notifRows) {
    bumpTable(report, "notifications", "read");
    const playerId = await lookupV3Id(exec, "users", row.N_user);
    if (!playerId) {
      recordOrphan(report, "notifications", row.N_user, `user ${row.N_user} does not exist`);
      bumpTable(report, "notifications", "skipped");
      continue;
    }
    const { v3Id } = await getOrCreateV3Id(exec, "notifications", row.N_id);
    const values = { id: v3Id, playerId, body: row.N_body, createdAt: unixToDate(row.N_time)! };
    await exec.insert(notifications).values(values).onConflictDoUpdate({ target: notifications.id, set: values });
    bumpTable(report, "notifications", "written");
  }

  const [newsRows] = await pool.query<(NewsRow & mysql.RowDataPacket)[]>(
    "SELECT GN_id, GN_author, GN_title, GN_body, GN_time FROM gameNews",
  );
  for (const row of newsRows) {
    bumpTable(report, "gameNews", "read");
    const authorId = row.GN_author !== null ? await lookupV3Id(exec, "users", row.GN_author) : null;
    const { v3Id } = await getOrCreateV3Id(exec, "gameNews", row.GN_id);
    const values = { id: v3Id, authorId, title: row.GN_title, body: row.GN_body ?? "", createdAt: unixToDate(row.GN_time)! };
    await exec.insert(gameNews).values(values).onConflictDoUpdate({ target: gameNews.id, set: values });
    bumpTable(report, "gameNews", "written");
  }
}
