import { eq } from "drizzle-orm";
import { bigint, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { definePlugin, type PluginTx } from "@gl3/plugin-sdk";

/** Read mirrors of core-owned tables (crimes' schema.ts pattern). */
const playerStats = pgTable("player_stats", {
  playerId: uuid("player_id").primaryKey(),
  exp: bigint("exp", { mode: "bigint" }).notNull(),
  level: integer("level").notNull(),
  health: integer("health").notNull(),
  healthMax: integer("health_max"),
  healthRegenAt: timestamp("health_regen_at", { withTimezone: true }),
});

const players = pgTable("players", {
  id: uuid("id").primaryKey(),
  username: text("username").notNull(),
});

/**
 * MCCodes' exp-needed curve, verbatim (`global_func.php:739-741`):
 * `(int)((level + 1)³ × 2.2)`, recomputed per level inside the loop.
 */
export function expNeeded(level: number): bigint {
  return BigInt(Math.trunc(Math.pow(level + 1, 3) * 2.2));
}

/**
 * The exp-routing claimant (C spec §4.3): applies exp to the LEVEL ladder,
 * never the rank ladder — the wrapper diverted here fires no rank rewards
 * and no rankedUp events, which is the economy guard. The level check is
 * lazy, inside the caller's transaction (the settlePool discipline), and
 * loops so one large grant applies every level it crosses — normalization
 * of MCCodes' next-page-load recheck.
 *
 * Per level-up (global_func.php:744-762): +2 energy and +2 brave, current
 * AND max, and +50 hp and max hp. The pools exist by construction —
 * `requires: ["mccodes-attributes"]` declares both — and `tx.attributes
 * .read` seeds an uninitialised max from the declaration first, so a player
 * who predates the anchor still grants correctly. Will does not grow.
 * `health_max` NULL means the progression plugin has never touched the
 * player; the first level-up adopts the cap from MCCodes' starting 100.
 */
export async function applyExpLevels(tx: PluginTx, playerId: string, expGain: bigint): Promise<void> {
  await tx.economy.addExp(playerId, expGain);
  if (expGain === 0n) return;

  const [row] = await tx.db
    .select({
      exp: playerStats.exp, level: playerStats.level,
      health: playerStats.health, healthMax: playerStats.healthMax,
      username: players.username,
    })
    .from(playerStats)
    .innerJoin(players, eq(players.id, playerStats.playerId))
    .where(eq(playerStats.playerId, playerId));
  if (!row) return;

  let exp = row.exp;
  let level = row.level;
  const levelsGained: number[] = [];
  // A guard, not a cap with meaning: a sane grant crosses at most a handful.
  for (let guard = 0; guard < 10_000; guard++) {
    const needed = expNeeded(level);
    if (exp < needed) break;
    exp -= needed;
    level += 1;
    levelsGained.push(level);
  }
  if (levelsGained.length === 0) return;

  const n = levelsGained.length;
  const attrs = await tx.attributes.read(playerId);
  await tx.attributes.setMax(playerId, "energy", attrs.energyMax + 2 * n);
  await tx.attributes.grant(playerId, "energy", 2 * n);
  await tx.attributes.setMax(playerId, "brave", attrs.braveMax + 2 * n);
  await tx.attributes.grant(playerId, "brave", 2 * n);

  const newMax = (row.healthMax ?? 100) + 50 * n;
  await tx.db
    .update(playerStats)
    .set({
      exp,
      level,
      health: Math.min(row.health + 50 * n, newMax),
      healthMax: newMax,
    })
    .where(eq(playerStats.playerId, playerId));

  for (const levelReached of levelsGained) {
    await tx.events.publishCore({
      type: "player.levelUp",
      actorId: playerId,
      actorName: row.username,
      audience: { kind: "player", playerId },
      level: levelReached,
    });
  }
}

/**
 * Progression (C spec §4.3): the exp destination for an MCCodes-profile
 * boot. Installing this plugin IS the routing claim — one claimant per
 * boot, enforced by `collectExpRouters`.
 */
export default definePlugin({
  id: "progression",
  version: "1.0.0",
  basePaths: ["/api/progression"],
  requires: ["mccodes-attributes"],
  applyExp: applyExpLevels,
});
