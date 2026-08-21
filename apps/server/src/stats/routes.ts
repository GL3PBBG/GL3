import { GameStatsResponseSchema, type GameStatsResponse } from "@gl3/shared";
import { gte, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import type { Db } from "../db/client.js";
import { crimeLog, gangs, players, playerStats, transactions } from "../db/schema/index.js";
import { PRESENCE_KEY, PRESENCE_ONLINE_WINDOW_MS } from "../presence/touch.js";

const CACHE_KEY = "stats:game";
const CACHE_TTL_SECONDS = 300;
const TREND_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` in UTC — the same bucket the SQL `date_trunc` below produces. */
function utcDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Every aggregate reads CORE tables only. A plugin's `p_*` tables are the
 * plugin's to expose; core cannot assume any of them exist (a deployment
 * chooses which plugins it loads), so nothing here joins one.
 */
async function computeStats(db: Db, redis: Redis, now: Date): Promise<GameStatsResponse> {
  const todayStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const windowStartMs = todayStartMs - (TREND_DAYS - 1) * DAY_MS;
  const windowStart = new Date(windowStartMs);
  const days = Array.from({ length: TREND_DAYS }, (_, i) => utcDayKey(windowStartMs + i * DAY_MS));

  // `count(*)` and `sum(...)` come back as Postgres bigint/numeric, and the
  // `::text` cast keeps them out of JS number range entirely — money never
  // touches Number, per NOTES.md rule 3. Both are factories rather than
  // shared instances, so no two of the nine concurrent queries below hand the
  // same builder object to the dialect.
  const countExpr = (): SQL<string> => sql<string>`count(*)::text`;
  const dayExpr = (column: PgColumn): SQL<string> =>
    sql<string>`to_char(date_trunc('day', ${column} at time zone 'UTC'), 'YYYY-MM-DD')`;

  const [
    playersRow, jailedRow, hospitalisedRow, gangsRow, supplyRow,
    newPlayerRows, crimeRows, ledgerRows, onlineNow,
  ] = await Promise.all([
    db.select({ n: countExpr() }).from(players),
    db.select({ n: countExpr() }).from(playerStats).where(sql`${playerStats.jailedUntil} > now()`),
    db.select({ n: countExpr() }).from(playerStats).where(sql`${playerStats.hospitalUntil} > now()`),
    db.select({ n: countExpr() }).from(gangs),
    db.select({
      cash: sql<string>`coalesce(sum(${playerStats.cash}), 0)::text`,
      bank: sql<string>`coalesce(sum(${playerStats.bank}), 0)::text`,
    }).from(playerStats),
    db.select({ day: dayExpr(players.createdAt), n: countExpr() })
      .from(players).where(gte(players.createdAt, windowStart)).groupBy(dayExpr(players.createdAt)),
    db.select({ day: dayExpr(crimeLog.createdAt), n: countExpr() })
      .from(crimeLog).where(gte(crimeLog.createdAt, windowStart)).groupBy(dayExpr(crimeLog.createdAt)),
    db.select({
      day: dayExpr(transactions.createdAt),
      total: sql<string>`coalesce(sum(abs(${transactions.amount})), 0)::text`,
    }).from(transactions).where(gte(transactions.createdAt, windowStart))
      .groupBy(dayExpr(transactions.createdAt)),
    redis.zcount(PRESENCE_KEY, now.getTime() - PRESENCE_ONLINE_WINDOW_MS, "+inf"),
  ]);

  // Postgres only returns rows for days that HAVE data; the response promises
  // one point per day including empty ones, so index by day and fill the gaps.
  const newPlayersByDay = new Map(newPlayerRows.map((row) => [row.day, Number(row.n)]));
  const crimesByDay = new Map(crimeRows.map((row) => [row.day, Number(row.n)]));
  const movedByDay = new Map(ledgerRows.map((row) => [row.day, row.total]));

  const cash = BigInt(supplyRow[0]?.cash ?? "0");
  const bank = BigInt(supplyRow[0]?.bank ?? "0");

  return {
    generatedAt: now.toISOString(),
    totals: {
      playersTotal: Number(playersRow[0]?.n ?? "0"),
      onlineNow,
      jailedNow: Number(jailedRow[0]?.n ?? "0"),
      hospitalisedNow: Number(hospitalisedRow[0]?.n ?? "0"),
      gangsTotal: Number(gangsRow[0]?.n ?? "0"),
      moneySupply: (cash + bank).toString(),
    },
    trends: {
      days,
      newPlayers: days.map((day) => newPlayersByDay.get(day) ?? 0),
      crimes: days.map((day) => crimesByDay.get(day) ?? 0),
      moneyMoved: days.map((day) => movedByDay.get(day) ?? "0"),
    },
  };
}

export function registerStatsRoutes(
  app: FastifyInstance, db: Db, redis: Redis,
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
): void {
  app.get("/api/stats", { preHandler: requireAuth }, async (_request, reply) => {
    // Read-through cache. This IS a check-then-act on Redis, which NOTES.md
    // rule 2 bans — but the rule guards *state*: a rate-limit bucket or a
    // one-shot ticket, where two racers must not both win. Nothing here is
    // state. A miss recomputes a pure aggregate over committed rows, so two
    // concurrent misses do the same read twice and write equivalent JSON; the
    // loser costs a duplicate query and nothing else. There is no correctness
    // claim to lose, so no SET NX / GETDEL / Lua is warranted.
    const cached = await redis.get(CACHE_KEY);
    if (cached !== null) {
      // Parsed, not trusted: an entry written by an older deploy has an older
      // shape, and serving it would break the client's own parse.
      const parsed = GameStatsResponseSchema.safeParse(JSON.parse(cached) as unknown);
      if (parsed.success) return reply.send(parsed.data);
    }

    const stats = await computeStats(db, redis, new Date());
    await redis.set(CACHE_KEY, JSON.stringify(stats), "EX", CACHE_TTL_SECONDS);
    return reply.send(stats);
  });
}
