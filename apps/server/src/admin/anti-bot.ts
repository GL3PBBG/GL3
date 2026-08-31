import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";

/**
 * Every field a STRING, numbers included: these rows feed the admin `table`
 * view nodes, and the client's cell schema parses strings only (the same
 * boundary rule that makes form-fed routes take string bodies). A numeric
 * cell here took the whole anti-bot page down with a zod parse error.
 */
export interface SuspectRow {
  username: string;
  events: string;
  meanGapSeconds: string;
  gapStddev: string;
  activeHours: string;
  score: string;
}

export interface IpClusterRow {
  ip: string;
  accounts: string;
  usernames: string;
}

/**
 * Bot-likeness over the ledger, computed lazily per admin read — no cron, no
 * stored score, no new table. A script fires at cooldown-expiry with tiny
 * variance around the clock; a human plays in ragged bursts inside a few
 * hours. So: many events + low inter-event stddev + many distinct active
 * hours ranks high. `score = events * activeHours / (stddev + 1)` is an
 * ORDERING heuristic for a human reviewer, not a verdict — nothing automated
 * acts on it (spec: no auto-ban).
 */
export async function suspectRows(db: Db, hours: number): Promise<SuspectRow[]> {
  const result = await db.execute(sql`
    with gaps as (
      select t.player_id,
             t.created_at,
             extract(epoch from t.created_at
               - lag(t.created_at) over (partition by t.player_id order by t.created_at)) as gap
      from transactions t
      where t.player_id is not null
        and t.created_at > now() - make_interval(hours => ${hours})
    ),
    stats as (
      select player_id,
             count(*)::int as events,
             coalesce(avg(gap), 0)::float8 as mean_gap,
             coalesce(stddev_samp(gap), 0)::float8 as gap_stddev,
             count(distinct date_trunc('hour', created_at))::int as active_hours
      from gaps
      group by player_id
      having count(*) >= 5
    )
    select p.username,
           s.events,
           round(s.mean_gap)::float8 as mean_gap,
           round(s.gap_stddev)::float8 as gap_stddev,
           s.active_hours,
           (s.events * s.active_hours / (s.gap_stddev + 1))::float8 as score
    from stats s
    join players p on p.id = s.player_id
    order by score desc
    limit 100`);
  return [...result].map((row) => {
    const r = row as Record<string, unknown>;
    return {
      username: String(r.username),
      events: String(Number(r.events)),
      meanGapSeconds: String(Math.round(Number(r.mean_gap))),
      gapStddev: String(Math.round(Number(r.gap_stddev))),
      activeHours: String(Number(r.active_hours)),
      score: String(Math.round(Number(r.score))),
    };
  });
}

/**
 * Accounts sharing a last_ip or signup_ip — the layer-3 pair check's
 * population view. Singletons are noise and omitted.
 */
export async function ipClusterRows(db: Db): Promise<IpClusterRow[]> {
  const result = await db.execute(sql`
    with addressed as (
      select username, last_ip as ip from players where last_ip is not null
      union
      select username, signup_ip as ip from players where signup_ip is not null
    )
    select ip,
           count(distinct username)::int as accounts,
           string_agg(distinct username::text, ', ' order by username::text) as usernames
    from addressed
    group by ip
    having count(distinct username) >= 2
    order by accounts desc
    limit 100`);
  return [...result].map((row) => {
    const r = row as Record<string, unknown>;
    return { ip: String(r.ip), accounts: String(Number(r.accounts)), usernames: String(r.usernames) };
  });
}
