import { sql } from "drizzle-orm";
import type mysql from "mysql2/promise";
import { gameNews, mailMessages, notifications } from "../../../server/src/db/schema/index.js";
import { forumPosts, forumTopics, forums, targetHas } from "../pg/plugin-tables.js";
import { getOrCreateV3Id, lookupV3Id } from "../id-map.js";
import {
  bumpTable, recordAbsentTargetTable, recordDroppedColumns, recordOrdinalKeyedTable, recordOrphan,
  type MigrationReport,
} from "../report.js";
import type { Executor } from "../pg/types.js";

/**
 * MCCodes social surfaces (B4 Task 15, spec §4 phase 6): `mail` ->
 * `mail_messages` (flat — MCCodes has no threads, so every message is its
 * own thread root), `events` -> `notifications`, `announcements` ->
 * `game_news` on ordinal id_map keys (the table has no PK and no author
 * column). `friendslist`/`blacklist` have no GL3 surface — the plugin
 * family's design lists friends/blacklists as explicit non-goals — so both
 * drop with counted report entries alongside `contactlist` (address-book
 * bookkeeping) and the poll/paper/vote/referral apparatus.
 */
interface MailRow {
  mail_id: number; mail_read: number; mail_from: number; mail_to: number;
  mail_time: number; mail_subject: string | null; mail_text: string | null;
}
interface EventRow { evID: number; evUSER: number; evTIME: number; evREAD: number; evTEXT: string | null; }
interface AnnouncementRow { a_text: string | null; a_time: number; }

function epoch(seconds: number): Date {
  return seconds > 0 ? new Date(seconds * 1000) : new Date();
}

async function dropWholesale(pool: mysql.Pool, report: MigrationReport, table: string): Promise<void> {
  const [rows] = await pool.query<(mysql.RowDataPacket & { n: number })[]>(
    `SELECT COUNT(*) AS n FROM \`${table}\``,
  );
  recordDroppedColumns(report, table, ["*"], Number(rows[0]?.n ?? 0));
}

export async function migrateMcSocial(pool: mysql.Pool, exec: Executor, report: MigrationReport): Promise<void> {
  const [mailRows] = await pool.query<(MailRow & mysql.RowDataPacket)[]>(
    "SELECT mail_id, mail_read, mail_from, mail_to, mail_time, mail_subject, mail_text FROM mail",
  );
  for (const row of mailRows) {
    bumpTable(report, "mail", "read");
    const recipientId = await lookupV3Id(exec, "users", row.mail_to);
    if (recipientId === null) {
      recordOrphan(report, "mail", row.mail_id, `recipient ${row.mail_to} does not exist`);
      bumpTable(report, "mail", "skipped");
      continue;
    }
    // mail_from 0 = system mail: no sender row to look up, not an orphan.
    const senderId = row.mail_from ? await lookupV3Id(exec, "users", row.mail_from) : null;
    const { v3Id } = await getOrCreateV3Id(exec, "mail", row.mail_id);
    const createdAt = epoch(row.mail_time);
    const values = {
      id: v3Id, threadId: v3Id, senderId, recipientId,
      subject: row.mail_subject ?? "", body: row.mail_text ?? "",
      readAt: row.mail_read ? createdAt : null, createdAt,
    };
    await exec.insert(mailMessages).values(values).onConflictDoUpdate({ target: mailMessages.id, set: values });
    bumpTable(report, "mail", "written");
  }

  const [eventRows] = await pool.query<(EventRow & mysql.RowDataPacket)[]>(
    "SELECT evID, evUSER, evTIME, evREAD, evTEXT FROM events",
  );
  for (const row of eventRows) {
    bumpTable(report, "events", "read");
    const playerId = await lookupV3Id(exec, "users", row.evUSER);
    if (playerId === null) {
      recordOrphan(report, "events", row.evID, `user ${row.evUSER} does not exist`);
      bumpTable(report, "events", "skipped");
      continue;
    }
    const { v3Id } = await getOrCreateV3Id(exec, "events", row.evID);
    const createdAt = epoch(row.evTIME);
    const values = {
      id: v3Id, playerId, body: row.evTEXT ?? "",
      readAt: row.evREAD ? createdAt : null, createdAt,
    };
    await exec.insert(notifications).values(values).onConflictDoUpdate({ target: notifications.id, set: values });
    bumpTable(report, "events", "written");
  }

  // announcements is PK-less AND author-less: ordinal id_map keys, null author.
  const [annRows] = await pool.query<(AnnouncementRow & mysql.RowDataPacket)[]>(
    "SELECT a_text, a_time FROM announcements",
  );
  recordOrdinalKeyedTable(report, "announcements");
  let annOrdinal = 0;
  for (const row of annRows) {
    bumpTable(report, "announcements", "read");
    annOrdinal += 1;
    const { v3Id } = await getOrCreateV3Id(exec, "announcements", annOrdinal);
    const values = {
      id: v3Id, authorId: null, title: "Announcement",
      body: row.a_text ?? "", createdAt: epoch(row.a_time),
    };
    await exec.insert(gameNews).values(values).onConflictDoUpdate({ target: gameNews.id, set: values });
    bumpTable(report, "announcements", "written");
  }

  for (const table of ["friendslist", "blacklist", "contactlist", "polls", "papercontent", "votes", "referals"]) {
    await dropWholesale(pool, report, table);
  }
}

/**
 * The MCCodes forum trilogy -> `p_forum_*` (spec §4 phase 6). `ff_auth`
 * gates the import: only `public` forums migrate. GL3's forum tables carry
 * no per-forum permission column, so a `staff` or `gang` forum imported
 * anyway would publish restricted content — the V2 gang-forum precedent
 * (skip wholesale, report) applies to both restricted classes.
 */
interface McForumRow { ff_id: number; ff_name: string; ff_auth: string; }
interface McTopicRow {
  ft_id: number; ft_forum_id: number; ft_name: string; ft_owner_id: number;
  ft_start_time: number; ft_pinned: number; ft_locked: number;
}
interface McPostRow { fp_id: number; fp_topic_id: number; fp_poster_id: number; fp_time: number; fp_text: string | null; }

export async function migrateMcForum(
  pool: mysql.Pool, exec: Executor, report: MigrationReport,
  targetTables?: ReadonlySet<string>,
): Promise<void> {
  const missing = ["p_forum_forums", "p_forum_topics", "p_forum_posts"]
    .filter((t) => !targetHas(targetTables, t));
  if (missing.length > 0) {
    for (const t of missing) recordAbsentTargetTable(report, t);
    return;
  }

  const [forumRows] = await pool.query<(McForumRow & mysql.RowDataPacket)[]>(
    "SELECT ff_id, ff_name, ff_auth FROM forum_forums",
  );
  const restricted = forumRows.filter((r) => r.ff_auth !== "public");
  if (restricted.length > 0) {
    recordDroppedColumns(report, "forum_forums (ff_auth != public)", ["*"], restricted.length);
  }
  const forumV3ById = new Map<number, string>();
  let sort = 0;
  for (const row of forumRows) {
    if (row.ff_auth !== "public") {
      bumpTable(report, "forum_forums", "skipped");
      continue;
    }
    bumpTable(report, "forum_forums", "read");
    const { v3Id } = await getOrCreateV3Id(exec, "forum_forums", row.ff_id);
    forumV3ById.set(row.ff_id, v3Id);
    const values = { id: v3Id, name: row.ff_name, sort: sort++ };
    await exec.insert(forums).values(values).onConflictDoUpdate({ target: forums.id, set: values });
    bumpTable(report, "forum_forums", "written");
  }

  const [topicRows] = await pool.query<(McTopicRow & mysql.RowDataPacket)[]>(
    "SELECT ft_id, ft_forum_id, ft_name, ft_owner_id, ft_start_time, ft_pinned, ft_locked FROM forum_topics",
  );
  const topicV3ById = new Map<number, string>();
  for (const row of topicRows) {
    if (!forumV3ById.has(row.ft_forum_id)) {
      // Cascade skip: a restricted forum's topic, or a dangling ft_forum_id.
      bumpTable(report, "forum_topics", "skipped");
      continue;
    }
    bumpTable(report, "forum_topics", "read");
    const authorId = await lookupV3Id(exec, "users", row.ft_owner_id);
    if (authorId === null) recordOrphan(report, "forum_topics", row.ft_id, `author ${row.ft_owner_id} does not exist`);
    const { v3Id } = await getOrCreateV3Id(exec, "forum_topics", row.ft_id);
    topicV3ById.set(row.ft_id, v3Id);
    const createdAt = epoch(row.ft_start_time);
    // post_count/last_post_at are placeholders overwritten by the recompute
    // below, once every post has been inserted — never trusted from MCCodes.
    const values = {
      id: v3Id, forumId: forumV3ById.get(row.ft_forum_id)!, authorId,
      subject: row.ft_name, status: row.ft_locked ? "locked" : "open",
      type: row.ft_pinned ? "sticky" : "normal",
      createdAt, lastPostAt: createdAt, postCount: 0,
    };
    await exec.insert(forumTopics).values(values).onConflictDoUpdate({ target: forumTopics.id, set: values });
    bumpTable(report, "forum_topics", "written");
  }

  const [postRows] = await pool.query<(McPostRow & mysql.RowDataPacket)[]>(
    "SELECT fp_id, fp_topic_id, fp_poster_id, fp_time, fp_text FROM forum_posts",
  );
  for (const row of postRows) {
    if (!topicV3ById.has(row.fp_topic_id)) {
      bumpTable(report, "forum_posts", "skipped");
      continue;
    }
    bumpTable(report, "forum_posts", "read");
    const authorId = await lookupV3Id(exec, "users", row.fp_poster_id);
    if (authorId === null) recordOrphan(report, "forum_posts", row.fp_id, `author ${row.fp_poster_id} does not exist`);
    const { v3Id } = await getOrCreateV3Id(exec, "forum_posts", row.fp_id);
    const values = {
      id: v3Id, topicId: topicV3ById.get(row.fp_topic_id)!, authorId,
      body: row.fp_text ?? "", createdAt: epoch(row.fp_time),
    };
    await exec.insert(forumPosts).values(values).onConflictDoUpdate({ target: forumPosts.id, set: values });
    bumpTable(report, "forum_posts", "written");
  }

  // Derived, not read from the source's own ff_/ft_ counters (stale in real
  // dumps) — the V2 forum migrator's recompute, verbatim.
  await exec.execute(sql`
    UPDATE p_forum_topics t SET
      post_count   = coalesce(p.n, 0),
      last_post_at = coalesce(p.latest, t.created_at)
    FROM (SELECT topic_id, count(*)::int AS n, max(created_at) AS latest
          FROM p_forum_posts GROUP BY topic_id) p
    WHERE p.topic_id = t.id`);

  recordDroppedColumns(report, "forum_forums", ["ff_desc", "ff_posts", "ff_topics", "ff_lp_*", "ff_owner"], forumRows.length);
}
