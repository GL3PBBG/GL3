import { randomInt } from "node:crypto";
import { eq } from "drizzle-orm";
import { pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { z } from "zod";
import { definePlugin, PluginError, route, type TrainedAttr } from "@gl3/plugin-sdk";
import { gymPage } from "./pages.js";

/**
 * Read mirror of the two sentence columns gym gates on (crimes' schema.ts
 * pattern — core owns and migrates the table, nothing here is declared in
 * this plugin's manifest).
 */
const playerStats = pgTable("player_stats", {
  playerId: uuid("player_id").primaryKey(),
  jailedUntil: timestamp("jailed_until", { withTimezone: true }),
  hospitalUntil: timestamp("hospital_until", { withTimezone: true }),
});

/** The four gym-trained stats. IQ is NOT here: it is bought and studied
 * (courses, jobs, crystal temple), never ground — MCCodes parity. */
const TRAINABLE = ["strength", "agility", "guard", "labour"] as const;
type Trainable = (typeof TRAINABLE)[number];

/** int(min, maxExclusive) — node:crypto randomInt's shape, so the route can
 * hand `randomInt` itself and tests can hand a scripted sequence. */
export interface SessionRng {
  int(minInclusive: number, maxExclusive: number): number;
}

/**
 * One training session, pure (audit §4.3, `gym.php:46-61` verbatim): per rep
 * the gain is `rand(1,3)/rand(800,1000)*rand(800,1000) × ((will+20)/150)`
 * against the LIVE will value — the drain compounds within the session —
 * and each rep drains `rand(1,3)` will, floored at zero. MCCodes stores
 * stats as float; GL3's are bigint, so the caller rounds once at the end
 * (per-rep rounding would drift).
 */
export function trainSession(
  rng: SessionRng,
  currentWill: number,
  reps: number,
): { gain: number; willDrained: number } {
  let will = currentWill;
  let gain = 0;
  let willDrained = 0;
  for (let i = 0; i < reps; i++) {
    // rand(1,3) inclusive → int(1, 4); rand(800,1000) inclusive → int(800, 1001).
    const r1 = rng.int(1, 4);
    const r2 = rng.int(800, 1001);
    const r3 = rng.int(800, 1001);
    gain += (r1 / r2) * r3 * ((will + 20) / 150);
    const drain = Math.min(rng.int(1, 4), will);
    will -= drain;
    willDrained += drain;
  }
  return { gain, willDrained };
}

// `reps` is a digit STRING, not z.number(): the page's form renderer
// submits every field as a string (PageRenderer builds
// Record<string,string>), so a numeric schema rejects the route's own
// declared form. Temple's PointsSchema is the same convention. Bounds
// checked after parse; coercion is explicit, not zod-magic.
const TrainBodySchema = z.object({
  stat: z.enum(TRAINABLE),
  reps: z.string().regex(/^\d+$/, "must be a nonnegative integer string"),
}).strict();

/** The gym page's data feed — the meter and the four trained stats,
 * all values stringified (`FormValuesResponseSchema`'s shape). */
const feedRoute = route({
  method: "GET",
  path: "/api/gym",
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      await tx.locks.player([player.id]);
      const attrs = await tx.attributes.read(player.id);
      return {
        status: 200,
        body: {
          values: {
            energy: attrs.energy.toString(),
            energyMax: attrs.energyMax.toString(),
            strength: attrs.strength.toString(),
            agility: attrs.agility.toString(),
            guard: attrs.guard.toString(),
            labour: attrs.labour.toString(),
          },
        },
      };
    });
  },
});

/** Static options feed for the train form's stat select — the four
 * trainable stats never change at runtime, so this is a fixed row set,
 * same shape as travel's `/api/admin/travel/combat-modes`. */
const statsRoute = route({
  method: "GET",
  path: "/api/gym/stats",
  handler: async () => ({
    status: 200,
    body: {
      rows: TRAINABLE.map((stat) => ({ id: stat, name: stat[0]!.toUpperCase() + stat.slice(1) })),
    },
  }),
});

const trainRoute = route({
  method: "POST",
  path: "/api/gym/train",
  body: TrainBodySchema,
  handler: async (ctx, { body }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    const reps = Number(body.reps);
    if (reps < 1 || reps > 1000) throw new PluginError("invalid_reps", 400);

    return ctx.transaction(async (tx) => {
      await tx.locks.player([player.id]);

      const [status] = await tx.db
        .select({ jailedUntil: playerStats.jailedUntil, hospitalUntil: playerStats.hospitalUntil })
        .from(playerStats)
        .where(eq(playerStats.playerId, player.id));
      const now = Date.now();
      if ((status?.hospitalUntil?.getTime() ?? 0) > now) {
        throw new PluginError("in_hospital", 423);
      }
      // MCCodes trains FROM jail at half gain (gym.php:58-61); only hospital
      // blocks outright.
      const jailed = (status?.jailedUntil?.getTime() ?? 0) > now;

      const attrs = await tx.attributes.read(player.id);
      if (attrs.energy < reps) throw new PluginError("insufficient_energy", 409);

      const session = trainSession({ int: (min, max) => randomInt(min, max) }, attrs.will, reps);
      const gain = jailed ? session.gain / 2 : session.gain;
      const applied = BigInt(Math.round(gain));

      await tx.attributes.spend(player.id, "energy", reps);
      if (session.willDrained > 0) await tx.attributes.spend(player.id, "will", session.willDrained);
      const next = await tx.attributes.train(player.id, body.stat satisfies TrainedAttr, applied);

      return {
        status: 200,
        body: {
          stat: body.stat,
          gain: applied.toString(),
          next: next.toString(),
          energySpent: reps,
          willDrained: session.willDrained,
        },
      };
    });
  },
});

/**
 * The gym (C spec §4.1): one energy and rand(1,3) will per rep, no money, no
 * cooldown — energy is the throttle, exactly MCCodes. Synchronous route
 * (the jail-bust precedent): instant outcome, no queue, one roll made once.
 * `requires` the anchor so the pools exist wherever the gym loads.
 */
export default definePlugin({
  id: "gym",
  version: "1.0.0",
  basePaths: ["/api/gym"],
  requires: ["mccodes-attributes"],
  routes: [feedRoute, statsRoute, trainRoute],
  pages: [gymPage],
});

export { TRAINABLE, trainRoute, feedRoute, statsRoute };
