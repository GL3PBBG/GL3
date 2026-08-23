import { definePlugin, InsufficientFundsError, type PluginCtx, type PluginTx, PluginError, route } from "@gl3/plugin-sdk";
import { and, eq, inArray } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { OC_MIGRATIONS } from "./migrations.js";
import { ocHeists, ocMembers, players, playerStats } from "./schema.js";
import { readBigintSetting, readNumberSetting } from "./settings.js";

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
          leaderId: ocHeists.leaderId,
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
            leaderId: r.leaderId,
            leaderUsername: r.leaderUsername,
          })),
        },
      };
    });
  },
});

/**
 * The plugin's lock-order root (spec §5): the heist row FOR UPDATE, taken
 * FIRST by every transaction that reads slot state to decide. Player locks
 * (tx.locks.player) come after, never before.
 */
async function lockHeist(tx: PluginTx, heistId: string) {
  const [heist] = await tx.db
    .select()
    .from(ocHeists)
    .where(eq(ocHeists.id, heistId))
    .for("update");
  return heist ?? null;
}

const IdSchema = z.string().uuid();
const HeistParamsSchema = z.object({ heistId: IdSchema });
const InviteBodySchema = z.object({
  targetUsername: z.string().min(1).max(30),
  role: z.string().min(1).max(20),
});

const inviteRoute = route({
  method: "POST",
  path: "/api/oc/:heistId/invite",
  accessInJail: false,
  accessInHospital: false,
  params: HeistParamsSchema,
  body: InviteBodySchema,
  handler: async (ctx, { params, body }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    if (body.role === LEADER_ROLE || !ROLES.includes(body.role as (typeof ROLES)[number])) {
      throw new PluginError("invalid_role", 409);
    }

    return ctx.transaction(async (tx) => {
      const heist = await lockHeist(tx, params.heistId);
      if (!heist) throw new PluginError("heist_not_found", 404);
      if (heist.leaderId !== player.id) throw new PluginError("not_leader", 403);
      if (heist.status !== "open") throw new PluginError("heist_not_open", 409);

      const [target] = await tx.db
        .select({ id: players.id })
        .from(players)
        .where(eq(players.username, body.targetUsername));
      if (!target) throw new PluginError("target_not_found", 404);
      if (target.id === player.id) throw new PluginError("self_invite", 409);

      const existing = await tx.db
        .select()
        .from(ocMembers)
        .where(
          and(eq(ocMembers.heistId, heist.id), eq(ocMembers.playerId, target.id)),
        );
      if (existing.length > 0) throw new PluginError("already_invited", 409);

      // Role check against ACCEPTED rows only — overlapping invites for one
      // seat are deliberate (first to accept wins; see Task 7).
      const taken = await tx.db
        .select()
        .from(ocMembers)
        .where(
          and(
            eq(ocMembers.heistId, heist.id),
            eq(ocMembers.role, body.role),
            eq(ocMembers.state, "accepted"),
          ),
        );
      if (taken.length > 0) throw new PluginError("role_taken", 409);

      await tx.db.insert(ocMembers).values({
        heistId: heist.id,
        playerId: target.id,
        role: body.role,
        state: "invited",
      });

      await tx.notify(
        target.id,
        `${player.username} invited you to a heist as ${body.role} (buy-in $${heist.buyIn.toString()}).`,
      );

      return { status: 201, body: { invited: true } };
    });
  },
});

const declineRoute = route({
  method: "POST",
  path: "/api/oc/:heistId/decline",
  params: HeistParamsSchema,
  handler: async (ctx, { params }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      // No heist lock: decline reads no slot state to decide — it deletes
      // the caller's own invited row unconditionally (spec §5).
      const deleted = await tx.db
        .delete(ocMembers)
        .where(
          and(
            eq(ocMembers.heistId, params.heistId),
            eq(ocMembers.playerId, player.id),
            eq(ocMembers.state, "invited"),
          ),
        )
        .returning({ playerId: ocMembers.playerId });
      if (deleted.length === 0) throw new PluginError("not_invited", 404);
      return { status: 200, body: { declined: true } };
    });
  },
});

/**
 * Publish one oc.updated per accepted member (audience player —
 * AudienceSchema has no multi-player kind, the bounties-claim reasoning).
 */
async function publishHeistUpdate(
  tx: PluginTx,
  actor: { id: string; username: string },
  heistId: string,
  status: "open" | "executing" | "done" | "failed" | "cancelled",
  memberIds: string[],
): Promise<void> {
  for (const playerId of memberIds) {
    await tx.events.publishCore({
      type: "oc.updated",
      actorId: actor.id,
      actorName: actor.username,
      audience: { kind: "player", playerId },
      heistId,
      status,
    });
  }
}

const acceptRoute = route({
  method: "POST",
  path: "/api/oc/:heistId/accept",
  accessInJail: false,
  accessInHospital: false,
  params: HeistParamsSchema,
  handler: async (ctx, { params }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    // Cooldown gates JOINING the next heist (create and accept), set by the
    // resolve job post-commit. peek is advisory-read-only by design.
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
        // Heist lock FIRST (spec §5): player locks come after, via
        // applyBalanceChange internally. No explicit tx.locks.player here.
        const heist = await lockHeist(tx, params.heistId);
        if (!heist) throw new PluginError("heist_not_found", 404);
        if (heist.status !== "open") throw new PluginError("heist_not_open", 409);

        const [invite] = await tx.db
          .select()
          .from(ocMembers)
          .where(
            and(
              eq(ocMembers.heistId, heist.id),
              eq(ocMembers.playerId, player.id),
              eq(ocMembers.state, "invited"),
            ),
          );
        if (!invite) throw new PluginError("not_invited", 404);

        // Under the heist lock: is the seat still free among ACCEPTED rows?
        const taken = await tx.db
          .select()
          .from(ocMembers)
          .where(
            and(
              eq(ocMembers.heistId, heist.id),
              eq(ocMembers.role, invite.role),
              eq(ocMembers.state, "accepted"),
            ),
          );
        if (taken.length > 0) throw new PluginError("role_taken", 409);

        let cash: bigint;
        try {
          cash = await tx.economy.applyBalanceChange({
            playerId: player.id,
            amount: -heist.buyIn,
            kind: "cash",
            reason: "oc.buyin",
          });
        } catch (err) {
          if (err instanceof InsufficientFundsError) throw new PluginError("insufficient_funds", 409);
          throw err;
        }

        // Flipping to accepted arms the partial unique index.
        await tx.db
          .update(ocMembers)
          .set({ state: "accepted" })
          .where(
            and(
              eq(ocMembers.heistId, heist.id),
              eq(ocMembers.playerId, player.id),
            ),
          );

        // Accepting clears the player's other pending invites (gang precedent).
        await tx.db
          .delete(ocMembers)
          .where(
            and(
              eq(ocMembers.playerId, player.id),
              eq(ocMembers.state, "invited"),
            ),
          );

        const memberIds = (
          await tx.db
            .select({ playerId: ocMembers.playerId })
            .from(ocMembers)
            .where(
              and(eq(ocMembers.heistId, heist.id), eq(ocMembers.state, "accepted")),
            )
        ).map((r) => r.playerId);
        await publishHeistUpdate(tx, player, heist.id, "open", memberIds);

        return { status: 200, body: { cash: cash.toString() } };
      });
    } catch (err) {
      if (isActiveHeistConflict(err)) throw new PluginError("already_in_heist", 409);
      throw err;
    }
  },
});

const leaveRoute = route({
  method: "POST",
  path: "/api/oc/:heistId/leave",
  params: HeistParamsSchema,
  handler: async (ctx, { params }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      // Heist lock FIRST (spec §5): applyBalanceChange locks player stats
      // row internally after.
      const heist = await lockHeist(tx, params.heistId);
      if (!heist) throw new PluginError("heist_not_found", 404);
      if (heist.status !== "open") throw new PluginError("heist_not_open", 409);

      const [member] = await tx.db
        .select()
        .from(ocMembers)
        .where(
          and(
            eq(ocMembers.heistId, heist.id),
            eq(ocMembers.playerId, player.id),
            eq(ocMembers.state, "accepted"),
          ),
        );
      if (!member) throw new PluginError("not_member", 404);
      if (heist.leaderId === player.id) throw new PluginError("leader_cannot_leave", 403);

      const cash = await tx.economy.applyBalanceChange({
        playerId: player.id,
        amount: heist.buyIn,
        kind: "cash",
        reason: "oc.refund",
      });

      await tx.db
        .delete(ocMembers)
        .where(
          and(
            eq(ocMembers.heistId, heist.id),
            eq(ocMembers.playerId, player.id),
          ),
        );

      const remaining = (
        await tx.db
          .select({ playerId: ocMembers.playerId })
          .from(ocMembers)
          .where(
            and(eq(ocMembers.heistId, heist.id), eq(ocMembers.state, "accepted")),
          )
      ).map((r) => r.playerId);
      await publishHeistUpdate(tx, player, heist.id, "open", remaining);

      return { status: 200, body: { cash: cash.toString() } };
    });
  },
});

const cancelRoute = route({
  method: "POST",
  path: "/api/oc/:heistId/cancel",
  params: HeistParamsSchema,
  handler: async (ctx, { params }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      // Heist lock FIRST (spec §5): applyBalanceChange locks each player's
      // stats row internally after.
      const heist = await lockHeist(tx, params.heistId);
      if (!heist) throw new PluginError("heist_not_found", 404);
      if (heist.leaderId !== player.id) throw new PluginError("not_leader", 403);
      if (heist.status !== "open") throw new PluginError("heist_not_open", 409);

      const accepted = await tx.db
        .select()
        .from(ocMembers)
        .where(
          and(eq(ocMembers.heistId, heist.id), eq(ocMembers.state, "accepted")),
        );

      // Refund every accepted member including the leader.
      for (const m of accepted) {
        await tx.economy.applyBalanceChange({
          playerId: m.playerId,
          amount: heist.buyIn,
          kind: "cash",
          reason: "oc.refund",
        });
      }

      // Release all member rows.
      await tx.db
        .update(ocMembers)
        .set({ released: true })
        .where(eq(ocMembers.heistId, heist.id));

      // Mark heist cancelled.
      await tx.db
        .update(ocHeists)
        .set({ status: "cancelled" })
        .where(eq(ocHeists.id, heist.id));

      await publishHeistUpdate(
        tx,
        player,
        heist.id,
        "cancelled",
        accepted.map((m) => m.playerId),
      );

      return { status: 200, body: { cancelled: true } };
    });
  },
});

const executeRoute = route({
  method: "POST",
  path: "/api/oc/:heistId/execute",
  accessInJail: false,
  accessInHospital: false,
  params: HeistParamsSchema,
  handler: async (ctx, { params }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    await ctx.transaction(async (tx) => {
      const heist = await lockHeist(tx, params.heistId);            // heist FIRST
      if (!heist) throw new PluginError("heist_not_found", 404);
      if (heist.leaderId !== player.id) throw new PluginError("not_leader", 403);
      // "executing" is allowed: re-fire after a commit-then-crash (crash recovery).
      if (heist.status !== "open" && heist.status !== "executing") {
        throw new PluginError("heist_not_open", 409);
      }

      const members = await tx.db.select().from(ocMembers).where(and(
        eq(ocMembers.heistId, heist.id), eq(ocMembers.state, "accepted"),
      ));
      if (members.length !== CREW_SIZE) throw new PluginError("crew_incomplete", 409);

      // players SECOND — the declared heist→player order (spec §5).
      const memberIds = members.map((m) => m.playerId);
      await tx.locks.player(memberIds);

      const stats = await tx.db
        .select({
          playerId: playerStats.playerId, locationId: playerStats.locationId,
          jailedUntil: playerStats.jailedUntil, hospitalUntil: playerStats.hospitalUntil,
          username: players.username,
        })
        .from(playerStats)
        .innerJoin(players, eq(players.id, playerStats.playerId))
        .where(inArray(playerStats.playerId, memberIds));

      const now = new Date();
      const absent = stats
        .filter((s) =>
          s.locationId !== heist.locationId ||
          (s.jailedUntil !== null && s.jailedUntil > now) ||
          (s.hospitalUntil !== null && s.hospitalUntil > now))
        .map((s) => s.username);
      if (absent.length > 0) {
        throw new PluginError("crew_not_assembled", 409, { absent });
      }

      await tx.db.update(ocHeists).set({ status: "executing" }).where(eq(ocHeists.id, heist.id));
      await publishHeistUpdate(tx, player, heist.id, "executing", memberIds);
    });

    // Enqueue AFTER commit — a job that ran before commit would read status
    // "open" and no-op, stranding the heist. On enqueue failure, compensate
    // by reverting to open (the crimes cooldown-release shape); the re-fire
    // rule above covers the crash-between-commit-and-enqueue window.
    try {
      const jobId = await ctx.jobs.enqueue("resolve", { heistId: params.heistId });
      return { status: 202, body: { jobId } };
    } catch (error) {
      try {
        await ctx.transaction(async (tx) => {
          await tx.db.update(ocHeists).set({ status: "open" })
            .where(and(eq(ocHeists.id, params.heistId), eq(ocHeists.status, "executing")));
        });
      } catch (revertError) {
        ctx.log.error("failed to revert heist to open after enqueue failure",
          { err: String(revertError), heistId: params.heistId });
      }
      throw error;
    }
  },
});

// ---------------------------------------------------------------------------
// Resolve job — seeded roll, shared fate for all crew
// ---------------------------------------------------------------------------

async function resolveJob(ctx: PluginCtx, data: Record<string, unknown>): Promise<void> {
  const heistId = String(data["heistId"]);
  const rng = ctx.job?.rng;
  if (rng === undefined) throw new Error("resolve job ran without a seeded rng");

  const successChance = readNumberSetting(ctx.settings, "success_chance", DEFAULT_SUCCESS_CHANCE);
  const multiplier = readBigintSetting(ctx.settings, "payout_multiplier", DEFAULT_PAYOUT_MULTIPLIER);
  const jailSeconds = Math.trunc(readNumberSetting(ctx.settings, "jail_seconds", DEFAULT_JAIL_SECONDS));
  const cooldownSeconds = Math.trunc(readNumberSetting(ctx.settings, "cooldown_seconds", DEFAULT_COOLDOWN_SECONDS));

  let cooldownIds: string[] = [];

  // ONE ctx.transaction — a second self-collides on plugin_job_runs
  // (the crimes-port finding).
  await ctx.transaction(async (tx) => {
    const heist = await lockHeist(tx, heistId);                     // heist FIRST
    if (!heist || heist.status !== "executing") return;             // stale job: no-op

    const members = await tx.db.select().from(ocMembers).where(and(
      eq(ocMembers.heistId, heist.id), eq(ocMembers.state, "accepted"),
    ));
    if (members.length !== CREW_SIZE) return;                       // defensive; execute proved it

    const memberIds = members.map((m) => m.playerId);
    await tx.locks.player(memberIds);                               // players SECOND

    const namedRows = await tx.db.select({ id: players.id, username: players.username })
      .from(players).where(inArray(players.id, memberIds));
    const nameById = new Map(namedRows.map((r) => [r.id, r.username]));
    const leaderName = nameById.get(heist.leaderId) ?? "unknown";

    // One shared roll (same scale as crimes': 0..10_000).
    const roll = rng.int(0, 10_000);
    const success = roll < Math.round(successChance * 10_000);

    if (success) {
      const pot = heist.buyIn * BigInt(CREW_SIZE);
      const total = pot * multiplier;
      const share = total / BigInt(CREW_SIZE);
      // Remainder is provably 0 for integer multipliers (pot = buyIn*4 is
      // always divisible by 4, and 4*k/4 = k). The line exists so a future
      // fractional-multiplier setting cannot silently burn money — bigint
      // division truncates.
      const remainder = total - share * BigInt(CREW_SIZE);
      for (const m of members) {
        const amount = m.playerId === heist.leaderId ? share + remainder : share;
        await tx.economy.applyBalanceChange({
          playerId: m.playerId, amount, kind: "cash", reason: "oc.payout", refId: heist.id,
        });
      }
    } else {
      for (const m of members) {
        await tx.jail.sendToJail(m.playerId, jailSeconds);
      }
    }

    const status = success ? "done" : "failed";
    await tx.db.update(ocHeists)
      .set({ status, executedAt: new Date() })
      .where(eq(ocHeists.id, heist.id));
    await tx.db.update(ocMembers).set({ released: true }).where(eq(ocMembers.heistId, heist.id));

    // Per-member resolved event
    if (success) {
      const pot = heist.buyIn * BigInt(CREW_SIZE);
      const total = pot * multiplier;
      const share = total / BigInt(CREW_SIZE);
      for (const m of members) {
        await tx.events.publishCore({
          type: "oc.resolved",
          actorId: heist.leaderId, actorName: leaderName,
          audience: { kind: "player", playerId: m.playerId },
          heistId: heist.id, success,
          share: share.toString(),
          jailSeconds: 0,
        });
      }
    } else {
      for (const m of members) {
        await tx.events.publishCore({
          type: "oc.resolved",
          actorId: heist.leaderId, actorName: leaderName,
          audience: { kind: "player", playerId: m.playerId },
          heistId: heist.id, success,
          share: "0",
          jailSeconds,
        });
      }
    }

    cooldownIds = memberIds;
  });

  // Post-commit, best-effort: SET NX EX per member (rule 2 — atomic, no
  // check-then-act). A crash here loses at most some cooldowns — a
  // convenience guard, never money.
  for (const id of cooldownIds) {
    await ctx.cooldown.acquire("oc", id, cooldownSeconds);
  }
}

export default definePlugin({
  id: "oc",
  version: "1.0.0",
  basePaths: ["/api/oc"],
  pages: [{
    id: "oc.index",
    path: "/oc",
    menu: { label: "Heists", order: 18, category: "crimes" },
    // Stub view: the client renders a hand-written override (apps/web
    // PAGE_OVERRIDES) for this id; the schema view exists because a
    // page declaration requires one.
    view: { kind: "list", items: [] },
  }],
  // One image per ROLE, not per heist: a heist row is a live instance a player
  // created, while the four roles are the fixed content of the feature. They
  // are singletons because a role is not a row — `ROLES` is a constant, so
  // there is nothing to bind an entity id to.
  providesAssets: [
    { slot: "role-mastermind", label: "Mastermind", singleton: true },
    { slot: "role-driver", label: "Driver", singleton: true },
    { slot: "role-gunman", label: "Gunman", singleton: true },
    { slot: "role-hacker", label: "Hacker", singleton: true },
  ],
  routes: [createRoute, stateRoute, inviteRoute, declineRoute, acceptRoute, leaveRoute, cancelRoute, executeRoute],
  jobs: { resolve: resolveJob },
  migrations: OC_MIGRATIONS,
  // No menu, pages or events: plugin-manifest-endpoint.test.ts asserts a
  // no-arg boot answers GET /api/plugins with exactly
  // { menu: [], pages: [], events: [] }.
});
