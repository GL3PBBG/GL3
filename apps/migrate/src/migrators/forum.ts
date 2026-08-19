import type mysql from "mysql2/promise";
import { sql } from "drizzle-orm";
import { forumPosts, forumTopics, forums } from "../pg/plugin-tables.js";
import { getOrCreateV3Id, lookupV3Id } from "../id-map.js";
import { bumpTable, recordOrphan, type MigrationReport } from "../report.js";
import type { Executor } from "../pg/types.js";
import { unixToDate } from "../time.js";

interface ForumRow { F_id: number; F_name: string; F_sort: number; }
interface TopicRow {
  T_id: number; T_date: number; T_user: number; T_subject: string;
  T_forum: number; T_status: number; T_type: number;
}
interface PostRow { P_id: number; P_date: number; P_user: number; P_body: string | null; P_topic: number; }

// T_type bitmask (SPEC §1.2 line 81 names sticky/important as separate V2
// concepts). GL3's `p_forum_topics.type` CHECK only allows 'normal'/'sticky',
// so a row with either bit — or both — collapses to 'sticky'.
const TOPIC_TYPE_STICKY = 1;
const TOPIC_TYPE_IMPORTANT = 2;

/** Gang forums use negative `F_id` by V2 convention. Deferred cluster-wide
 * (see the SDD plan) — skipped here along with everything filed under them. */
function isGangForum(fId: number): boolean {
  return fId < 0;
}

export async function migrateForum(pool: mysql.Pool, exec: Executor, report: MigrationReport): Promise<void> {
  const [gangForumCountRows] = await pool.query<({ n: number } & mysql.RowDataPacket)[]>(
    "SELECT count(*) AS n FROM forums WHERE F_id < 0",
  );
  const gangForumCount = gangForumCountRows[0]!.n;
  for (let i = 0; i < gangForumCount; i++) bumpTable(report, "forums", "skipped");

  const [forumRows] = await pool.query<(ForumRow & mysql.RowDataPacket)[]>(
    "SELECT F_id, F_name, F_sort FROM forums WHERE F_id > 0",
  );
  const forumV3ById = new Map<number, string>();
  for (const row of forumRows) {
    bumpTable(report, "forums", "read");
    const { v3Id } = await getOrCreateV3Id(exec, "forums", row.F_id);
    forumV3ById.set(row.F_id, v3Id);
    const values = { id: v3Id, name: row.F_name, sort: row.F_sort };
    await exec.insert(forums).values(values).onConflictDoUpdate({ target: forums.id, set: values });
    bumpTable(report, "forums", "written");
  }

  const [topicRows] = await pool.query<(TopicRow & mysql.RowDataPacket)[]>(
    "SELECT T_id, T_date, T_user, T_subject, T_forum, T_status, T_type FROM topics",
  );
  const topicV3ById = new Map<number, string>();
  for (const row of topicRows) {
    if (isGangForum(row.T_forum) || !forumV3ById.has(row.T_forum)) {
      // Cascade skip: either a gang forum directly, or a forum row this run
      // never saw (dangling T_forum in real V2 data — no FK enforcement).
      bumpTable(report, "topics", "skipped");
      continue;
    }
    bumpTable(report, "topics", "read");
    const authorId = await lookupV3Id(exec, "users", row.T_user);
    if (!authorId) recordOrphan(report, "topics", row.T_id, `author ${row.T_user} does not exist`);

    const { v3Id } = await getOrCreateV3Id(exec, "topics", row.T_id);
    topicV3ById.set(row.T_id, v3Id);
    const isSticky = (row.T_type & (TOPIC_TYPE_STICKY | TOPIC_TYPE_IMPORTANT)) !== 0;
    const createdAt = unixToDate(row.T_date)!;
    // post_count/last_post_at are placeholders overwritten by the recompute
    // below, once every post has been inserted — never trusted from V2.
    const values = {
      id: v3Id, forumId: forumV3ById.get(row.T_forum)!, authorId,
      subject: row.T_subject, status: row.T_status === 1 ? "locked" : "open",
      type: isSticky ? "sticky" : "normal",
      createdAt, lastPostAt: createdAt, postCount: 0,
    };
    await exec.insert(forumTopics).values(values).onConflictDoUpdate({ target: forumTopics.id, set: values });
    bumpTable(report, "topics", "written");
  }

  const [postRows] = await pool.query<(PostRow & mysql.RowDataPacket)[]>(
    "SELECT P_id, P_date, P_user, P_body, P_topic FROM posts",
  );
  for (const row of postRows) {
    if (!topicV3ById.has(row.P_topic)) {
      // Cascade skip: topic under a gang forum, or otherwise not migrated.
      bumpTable(report, "posts", "skipped");
      continue;
    }
    bumpTable(report, "posts", "read");
    const authorId = await lookupV3Id(exec, "users", row.P_user);
    if (!authorId) recordOrphan(report, "posts", row.P_id, `author ${row.P_user} does not exist`);

    const { v3Id } = await getOrCreateV3Id(exec, "posts", row.P_id);
    const values = {
      id: v3Id, topicId: topicV3ById.get(row.P_topic)!, authorId,
      body: row.P_body ?? "", createdAt: unixToDate(row.P_date)!,
    };
    await exec.insert(forumPosts).values(values).onConflictDoUpdate({ target: forumPosts.id, set: values });
    bumpTable(report, "posts", "written");
  }

  // post_count/last_post_at are derived, not read from V2 (V2 kept no such
  // columns on `topics` at all) — recompute from the posts just migrated. A
  // topic with zero posts falls back to its own created_at via `coalesce`.
  await exec.execute(sql`
    UPDATE p_forum_topics t SET
      post_count   = coalesce(p.n, 0),
      last_post_at = coalesce(p.latest, t.created_at)
    FROM (SELECT topic_id, count(*)::int AS n, max(created_at) AS latest
          FROM p_forum_posts GROUP BY topic_id) p
    WHERE p.topic_id = t.id`);
}
