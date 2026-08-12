import { definePlugin, InsufficientFundsError, PluginError, route } from "@gl3/plugin-sdk";
import { and, eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { OC_MIGRATIONS } from "./migrations.js";
import { ocHeists, ocMembers, players, playerStats } from "./schema.js";
import { readBigintSetting } from "./settings.js";

export const ROLES = ["mastermind", "driver", "gunman", "hacker"] as const;
export const LEADER_ROLE = "mastermind";
export const CREW_SIZE = 4;

const DEFAULT_BUY_IN_MIN = 1000n;
const DEFAULT_SUCCESS_CHANCE = 0.35;
const DEFAULT_PAYOUT_MULTIPLIER = 3n;
const DEFAULT_JAIL_SECONDS = 600;
const DEFAULT_COOLDOWN_SECONDS = 1800;

/**
 * Duck-typed 23505 check narrowed by constraint name.
 * Drizzle wraps the pg error as `.cause`; the pg driver's error fields are
 * `code` (SQLSTATE) and `constraint_name` (the index/constraint name).
 */
function isActiveHeistConflict(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  // Direct check (pg error unwrapped)
  const e = err as { code?: string; constraint_name?: string };
  if (e.code === "23505" && e.constraint_name === "p_oc_members_active_player") return true;
  // Drizzle wraps the pg error as `.cause`
  if (err instanceof Error) return isActiveHeistConflict(err.cause);
  return false;
}

const CreateBodySchema = z.object({
  buyIn: z.string().regex(/^-?\d+$/, "must be an integer string"),
});

const createRoute = route({
  method: "POST",
  path: "/api/oc",
  accessInJail: false,
  accessInHospital: false,
  body: CreateBodySchema,
  handler: async (ctx, { body }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    const buyIn = BigInt(body.buyIn);
    if (buyIn <= 0n) throw new PluginError("amount_must_be_positive", 400);
    if (buyIn < readBigintSetting(ctx.settings, "buy_in_min", DEFAULT_BUY_IN_MIN)) {
      throw new PluginError("below_minimum", 409);
    }

    // Cooldown gates JOINING the next heist (create and accept), set by the
    // resolve job post-commit. peek is advisory-read-only by design: the
    // worst race lets a player in a second early, it cannot lock anyone out
    // (the rule-2 shapes to avoid are lost-update/permanent-lockout).
    const cd = await ctx.cooldown.peek("oc", player.id);
    if (cd > 0) {
      throw new PluginError(
        "on_cooldown",
        429,
        { retryAfter: cd },
        { "retry-after": String(Math.max(cd, 1)) },
      );
    }

    try {
      return await ctx.transaction(async (tx) => {
        // No heist lock: this INSERTs its own heist row under a fresh
        // uuidv7 — the POST /api/gangs exemption (Global Constraints).
        const [stats] = await tx.db
          .select({ locationId: playerStats.locationId })
          .from(playerStats)
          .where(eq(playerStats.playerId, player.id));
        if (!stats?.locationId) throw new PluginError("no_location", 409);

        let cash: bigint;
        try {
          cash = await tx.economy.applyBalanceChange({
            playerId: player.id,
            amount: -buyIn,
            kind: "cash",
            reason: "oc.buyin",
          });
        } catch (err) {
          if (err instanceof InsufficientFundsError) throw new PluginError("insufficient_funds", 409);
          throw err;
        }

        const heistId = uuidv7();
        await tx.db.insert(ocHeists).values({
          id: heistId,
          leaderId: player.id,
          locationId: stats.locationId,
          status: "open",
          buyIn,
        });
        // The partial unique index fires HERE if the player already has an
        // accepted, unreleased row anywhere — rolling back the debit above.
        await tx.db.insert(ocMembers).values({
          heistId,
          playerId: player.id,
          role: LEADER_ROLE,
          state: "accepted",
        });

        await tx.events.publishCore({
          type: "oc.updated",
          actorId: player.id,
          actorName: player.username,
          audience: { kind: "player", playerId: player.id },
          heistId,
          status: "open",
        });

        return { status: 201, body: { heistId, cash: cash.toString() } };
      });
    } catch (err) {
      if (isActiveHeistConflict(err)) throw new PluginError("already_in_heist", 409);
      throw err;
    }
  },
});

const stateRoute = route({
  method: "GET",
  path: "/api/oc",
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      // My accepted, unreleased membership (unique by the partial index).
      const [mine] = await tx.db
        .select()
        .from(ocMembers)
        .where(
          and(
            eq(ocMembers.playerId, player.id),
            eq(ocMembers.state, "accepted"),
            eq(ocMembers.released, false),
          ),
        );

      let heist = null;
      if (mine) {
        const [h] = await tx.db
          .select()
          .from(ocHeists)
          .where(eq(ocHeists.id, mine.heistId));
        if (h) {
          const members = await tx.db
            .select({
              playerId: ocMembers.playerId,
              role: ocMembers.role,
              state: ocMembers.state,
              username: players.username,
            })
            .from(ocMembers)
            .innerJoin(players, eq(players.id, ocMembers.playerId))
            .where(eq(ocMembers.heistId, h.id));
          heist = {
            id: h.id,
            status: h.status,
            buyIn: h.buyIn.toString(),
            locationId: h.locationId,
            leaderId: h.leaderId,
            members,
          };
        }
      }

      const inviteRows = await tx.db
        .select({
          heistId: ocMembers.heistId,
          role: ocMembers.role,
          buyIn: ocHeists.buyIn,
          leaderUsername: players.username,
        })
        .from(ocMembers)
        .innerJoin(ocHeists, eq(ocHeists.id, ocMembers.heistId))
        .innerJoin(players, eq(players.id, ocHeists.leaderId))
        .where(
          and(
            eq(ocMembers.playerId, player.id),
            eq(ocMembers.state, "invited"),
            eq(ocMembers.released, false),
            eq(ocHeists.status, "open"),
          ),
        );

      return {
        status: 200,
        body: {
          heist,
          invites: inviteRows.map((r) => ({
            heistId: r.heistId,
            role: r.role,
            buyIn: r.buyIn.toString(),
            leaderUsername: r.leaderUsername,
          })),
        },
      };
    });
  },
});

export default definePlugin({
  id: "oc",
  version: "1.0.0",
  basePaths: ["/api/oc"],
  routes: [createRoute, stateRoute],
  migrations: OC_MIGRATIONS,
  // No menu, pages or events: plugin-manifest-endpoint.test.ts asserts a
  // no-arg boot answers GET /api/plugins with exactly
  // { menu: [], pages: [], events: [] }.
});
