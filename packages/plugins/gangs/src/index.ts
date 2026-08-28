import {
  definePlugin, InsufficientFundsError, InsufficientGangFundsError, newId, PluginError, route,
  type PluginDbTx, type PluginTx,
} from "@gl3/plugin-sdk";
import { and, count, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  gangInvites, gangLogs, gangMembers, gangPermissions, gangs, players, playerStats,
} from "./schema.js";

/**
 * Ported from `apps/server/src/game/gangs/routes.ts`: paths, status codes,
 * error strings, response bodies and every `gang.*` / `notification.created`
 * event are byte-identical. The 8 gang test files are unchanged and are the
 * proof — they are entirely `app.inject`, and their only direct imports are
 * from `game/gangs/permissions.ts`, which stays in core.
 *
 * Five deliberate differences from core:
 *  - ONE `ctx.transaction` per route. Core split several routes into an
 *    unlocked pre-check outside a transaction and a locked mutation inside
 *    it; a plugin has only one database handle. The TOCTOU defence is about
 *    LOCK STATE, not transaction boundaries — the pre-checks below still run
 *    before any `tx.locks.*` call, and every recheck still runs after one, so
 *    the property core relied on survives intact (design §4.4).
 *  - No `AlreadyInGangError`-style private error classes. A `PluginError`
 *    thrown inside `ctx.transaction` rolls the transaction back and reaches
 *    the loader unwrapped, so the class-per-condition indirection core needed
 *    to carry a status out of `db.transaction` is unnecessary here.
 *  - `actorName` comes from `ctx.player.username` wherever the actor IS the
 *    caller (create, accept, leave) — no `players` read. Kick still reads
 *    `players`, because `gang.memberLeft`'s actor is the KICKED player.
 *  - `tx.notify` replaces `insertNotification` + a hand-built post-commit
 *    `notification.created` publish on the invite and transfer routes: it
 *    writes the row and buffers the event, with the recipient as actor —
 *    byte-identical to what core published (design §4.9).
 *  - A 400 from a bad body carries `{ error: "invalid_request" }` with no
 *    `issues` array, because the plugin route layer owns body validation
 *    (`apps/server/src/plugins/routes.ts`). Every gang test asserting a 400
 *    asserts only the status code.
 *
 * `@gl3/shared` is off-limits to a plugin package, so `IdSchema`,
 * `noNulByte`, the `MoneySchema` regex and `GANG_PERMISSIONS` are restated
 * below. Every bound is copied from `packages/shared/src/dto/gangs.ts`
 * verbatim: a wrong bound silently changes which inputs 400.
 */
const noNulByte = <T extends z.ZodString>(schema: T): z.ZodEffects<T, string, string> =>
  schema.refine((value) => !value.includes("\u0000"), { message: "must not contain a NUL byte" });

const IdSchema = z.string().uuid();

/** Mirrors core's tuple (`game/gangs/permissions.ts:6`) and `dto/gangs.ts:47`. */
const GANG_PERMISSIONS = [
  "invite", "kick", "bank.withdraw", "edit_info", "grant_permissions",
] as const;

const GangParamsSchema = z.object({ gangId: IdSchema });
const InviteParamsSchema = z.object({ inviteId: IdSchema });
const MemberParamsSchema = z.object({ gangId: IdSchema, playerId: IdSchema });
const PermissionParamsSchema = z.object({
  gangId: IdSchema, playerId: IdSchema, permission: z.enum(GANG_PERMISSIONS),
});

const CreateGangBodySchema = z.object({
  // The regex allowlist already excludes NUL (not in the character class), so
  // `name` does not take noNulByte on top of it — matching dto/gangs.ts:5-6.
  name: z.string().min(3).max(50).regex(/^[A-Za-z0-9 _'-]+$/, "letters, digits, spaces, _ - ' only"),
  description: noNulByte(z.string().max(500)).optional(),
  info: noNulByte(z.string().max(2000)).optional(),
});
// Not persisted, but reaches Postgres as an `eq(players.username, ...)`
// parameter, and Postgres rejects an embedded NUL in ANY text parameter
// (SQLSTATE 22021) — so this needs the guard too.
const InviteBodySchema = z.object({ username: noNulByte(z.string().min(3).max(30)) });
const TransferBodySchema = z.object({ playerId: IdSchema });
const GrantBodySchema = z.object({ playerId: IdSchema, permission: z.enum(GANG_PERMISSIONS) });
// The `> 0` refine core carries on GangBankTransferRequestSchema lives in the
// handler instead: the loader answers every schema failure with
// `invalid_request`, which would silently drop the distinct error string.
// Same shape `packages/plugins/bank/src/index.ts:24` took.
const AmountBodySchema = z.object({
  amount: z.string().regex(/^-?\d+$/, "must be an integer string"),
});

/**
 * drizzle re-throws the driver's `PostgresError` either directly or wrapped
 * as an `Error` whose `cause` is it — the core route this was ported from
 * handled both shapes wherever it mapped a Postgres error code to a
 * `PluginError` (unique-name collisions, dangling foreign keys), and so must
 * this. Read as a duck-typed property rather than an `instanceof
 * postgres.PostgresError`: no plugin depends on `postgres`, which is an
 * `apps/server` transport concern. Guards, not casts (`packages/*`).
 */
function pgErrorCode(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("code" in value)) return null;
  const { code } = value;
  return typeof code === "string" ? code : null;
}

function isPgCode(error: unknown, code: string): boolean {
  if (pgErrorCode(error) === code) return true;
  return error instanceof Error && pgErrorCode(error.cause) === code;
}

const isUniqueViolation = (error: unknown): boolean => isPgCode(error, "23505");
const isForeignKeyViolation = (error: unknown): boolean => isPgCode(error, "23503");

async function loadGangDto(
  db: PluginDbTx, gangId: string, art?: Map<string, string>,
): Promise<Record<string, unknown> | null> {
  const [gang] = await db.select().from(gangs).where(eq(gangs.id, gangId));
  if (!gang) return null;
  const [memberCount] = await db.select({ n: count() }).from(gangMembers)
    .where(eq(gangMembers.gangId, gangId));
  const logo = art?.get(gang.id);
  return {
    id: gang.id, name: gang.name, description: gang.description, info: gang.info,
    bank: gang.bank.toString(), cash: gang.cash.toString(), level: gang.level,
    bossPlayerId: gang.bossPlayerId, underbossPlayerId: gang.underbossPlayerId,
    memberCount: memberCount?.n ?? 0,
    // Omitted rather than null when unbound: the DTO field is optional and
    // `exactOptionalPropertyTypes` makes the spread the honest way to say so.
    ...(logo === undefined ? {} : { imageUrl: logo }),
  };
}

/**
 * Deletes membership AND any permission rows, clears `player_stats.gang_id`,
 * appends the log. Caller must hold both locks via `tx.locks.gangAndPlayer`
 * first.
 *
 * The three statements are one sequence on purpose: core's three-layer
 * permission mask (`game/gangs/permissions.ts`) depends on
 * `gang_permissions` rows being cleared whenever a `gang_members` row is
 * deleted, so a dormant grant cannot go live on rejoin. Any future path here
 * that INSERTs a `gang_members` row must clear the matching permission rows
 * first — the accept route does.
 */
async function removeMember(
  tx: PluginTx, gangId: string, playerId: string, message: string,
): Promise<void> {
  await tx.db.delete(gangMembers)
    .where(and(eq(gangMembers.gangId, gangId), eq(gangMembers.playerId, playerId)));
  await tx.db.delete(gangPermissions)
    .where(and(eq(gangPermissions.gangId, gangId), eq(gangPermissions.playerId, playerId)));
  await tx.db.update(playerStats).set({ gangId: null })
    .where(eq(playerStats.playerId, playerId));
  await tx.gangLog({ gangId, playerId, message });
}

const getGangRoute = route({
  method: "GET",
  path: "/api/gangs/:gangId",
  params: GangParamsSchema,
  // The one gang read any authenticated player may make — no membership
  // gate. Kept public-to-members-and-outsiders alike because kick, invite,
  // PUT/DELETE permissions and both bank routes all answer 404 before 403 on
  // a nonexistent gang, which already makes existence observable.
  handler: async (ctx, { params }) => ctx.transaction(async (tx) => {
    const art = await ctx.assets.mine([params.gangId], "logo");
    const dto = await loadGangDto(tx.db, params.gangId, art);
    if (!dto) throw new PluginError("gang_not_found", 404);
    return { status: 200, body: dto };
  }),
});

const gangLogsRoute = route({
  method: "GET",
  path: "/api/gangs/:gangId/logs",
  params: GangParamsSchema,
  handler: async (ctx, { params }) => ctx.transaction(async (tx) => {
    const rows = await tx.db.select().from(gangLogs)
      .where(eq(gangLogs.gangId, params.gangId))
      .orderBy(desc(gangLogs.createdAt))
      .limit(50);
    return {
      status: 200,
      body: {
        logs: rows.map((l) => ({
          id: l.id, playerId: l.playerId, message: l.message,
          createdAt: l.createdAt.toISOString(),
        })),
      },
    };
  }),
});

const gangMembersRoute = route({
  method: "GET",
  path: "/api/gangs/:gangId/members",
  params: GangParamsSchema,
  handler: async (ctx, { params }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    const { gangId } = params;

    return ctx.transaction(async (tx) => {
      const [gang] = await tx.db
        .select({ boss: gangs.bossPlayerId, underboss: gangs.underbossPlayerId })
        .from(gangs).where(eq(gangs.id, gangId));
      if (!gang) throw new PluginError("gang_not_found", 404);

      // Members only. GET /api/gangs/:gangId is open to any authenticated
      // player, but this roster carries each member's permission grants — a
      // map of who can kick and who can empty the bank — and gangs are
      // invite-only, so no non-member has a use for it.
      const [membership] = await tx.db.select({ gangId: gangMembers.gangId }).from(gangMembers)
        .where(and(eq(gangMembers.gangId, gangId), eq(gangMembers.playerId, player.id)));
      if (!membership) throw new PluginError("not_a_member", 403);

      const rows = await tx.db.select({
        playerId: gangMembers.playerId, username: players.username, joinedAt: gangMembers.joinedAt,
      }).from(gangMembers).innerJoin(players, eq(players.id, gangMembers.playerId))
        .where(eq(gangMembers.gangId, gangId))
        .orderBy(gangMembers.joinedAt);

      // Permissions are attached by joining in memory against the member
      // list, which reproduces hasGangPermission's membership requirement: a
      // gang_permissions row naming someone with no gang_members row confers
      // nothing there and must not appear here either.
      const grants = await tx.db
        .select({ playerId: gangPermissions.playerId, permission: gangPermissions.permission })
        .from(gangPermissions).where(eq(gangPermissions.gangId, gangId));
      const byPlayer = new Map<string, string[]>();
      for (const g of grants) {
        const list = byPlayer.get(g.playerId);
        if (list) list.push(g.permission);
        else byPlayer.set(g.playerId, [g.permission]);
      }

      const rank = (id: string): number => (id === gang.boss ? 0 : id === gang.underboss ? 1 : 2);
      const members = rows
        .map((m) => ({
          playerId: m.playerId,
          username: m.username,
          role: m.playerId === gang.boss ? "boss" : m.playerId === gang.underboss ? "underboss" : "member",
          // Leadership holds every permission implicitly (hasGangPermission's
          // boss/underboss bypass) and holds no gang_permissions rows to
          // report, so send the whole set rather than an empty array a client
          // would read as "can do nothing".
          permissions: m.playerId === gang.boss || m.playerId === gang.underboss
            ? [...GANG_PERMISSIONS]
            : byPlayer.get(m.playerId) ?? [],
          joinedAt: m.joinedAt.toISOString(),
        }))
        // Array.prototype.sort is stable, so equal-rank members keep the
        // joinedAt ordering the query above established.
        .sort((a, b) => rank(a.playerId) - rank(b.playerId));

      return { status: 200, body: { members } };
    });
  },
});

// find-my-way prefers the static "invites" segment over :gangId, so this does
// not shadow — nor is it shadowed by — GET /api/gangs/:gangId.
// gang-invites.test.ts pins that.
const myInvitesRoute = route({
  method: "GET",
  path: "/api/gangs/invites",
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      const rows = await tx.db.select({
        id: gangInvites.id, gangId: gangInvites.gangId, gangName: gangs.name,
        invitedByPlayerId: gangInvites.invitedByPlayerId, invitedByUsername: players.username,
        createdAt: gangInvites.createdAt,
      }).from(gangInvites)
        .innerJoin(gangs, eq(gangs.id, gangInvites.gangId))
        .innerJoin(players, eq(players.id, gangInvites.invitedByPlayerId))
        .where(eq(gangInvites.invitedPlayerId, player.id))
        .orderBy(desc(gangInvites.createdAt))
        .limit(50);

      // No player_stats.gang_id filter. Accepting clears every invite the
      // joiner holds, and the invite route refuses a target already in a
      // gang, so an invite that would 409 already_in_a_gang normally cannot
      // exist — but it can be raced into being. Listing it is deliberate: the
      // accept route is the authority on whether an invite still works, and
      // filtering here would leave the invitee looking at a notification for
      // an invite that is nowhere.
      return {
        status: 200,
        body: { invites: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })) },
      };
    });
  },
});

const createGangRoute = route({
  method: "POST",
  path: "/api/gangs",
  body: CreateGangBodySchema,
  handler: async (ctx, { body }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    const gangId = newId();
    let dto: Record<string, unknown> | null;
    try {
      dto = await ctx.transaction(async (tx) => {
        // Lock this player's stats row first, then recheck under that lock —
        // the window between an unlocked pre-check and commit is exactly what
        // let two concurrent POSTs from the same player both pass.
        //
        // This is the ONE membership path that does not go through
        // locks.gangAndPlayer, and it is exempt structurally rather than by
        // oversight: the gangs row it goes on to touch (implicitly, via
        // gang_members' and gang_logs' foreign keys) is one it INSERTs in
        // this same transaction under a freshly-minted id. No other
        // transaction can hold or want a lock on a row it cannot see, so this
        // path can never be one leg of a lock cycle.
        await tx.locks.player([player.id]);
        const [existing] = await tx.db.select({ gangId: playerStats.gangId }).from(playerStats)
          .where(eq(playerStats.playerId, player.id));
        if (existing?.gangId) throw new PluginError("already_in_a_gang", 409);

        await tx.db.insert(gangs).values({
          id: gangId, name: body.name, description: body.description ?? "",
          info: body.info ?? "", bossPlayerId: player.id,
        });
        await tx.db.insert(gangMembers).values({ gangId, playerId: player.id });
        await tx.db.update(playerStats).set({ gangId }).where(eq(playerStats.playerId, player.id));
        await tx.gangLog({ gangId, playerId: player.id, message: "founded the gang" });

        await tx.events.publishCore({
          type: "gang.created",
          actorId: player.id,
          actorName: player.username,
          audience: { kind: "gang", gangId },
          gangId,
          gangName: body.name,
        });

        return await loadGangDto(tx.db, gangId);
      });
    } catch (error) {
      // Outside the transaction, not inside: a failed statement aborts the
      // Postgres transaction, so there is nothing to catch and continue from
      // in there. `gangs_name_unique` is the only unique constraint reachable
      // on this insert path (name is the only unique column), so the
      // constraint-name check core made is redundant here — see the watch
      // item this port adds to docs/STATUS.md.
      if (isUniqueViolation(error)) throw new PluginError("gang_name_taken", 409);
      throw error;
    }
    return { status: 201, body: dto };
  },
});

const inviteRoute = route({
  method: "POST",
  path: "/api/gangs/:gangId/invites",
  params: GangParamsSchema,
  body: InviteBodySchema,
  handler: async (ctx, { params, body }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    const { gangId } = params;

    return ctx.transaction(async (tx) => {
      // Existence before permission: hasPermission returns false for a
      // nonexistent gang, which would otherwise mask a 404 as a 403.
      const [gang] = await tx.db.select({ name: gangs.name }).from(gangs)
        .where(eq(gangs.id, gangId));
      if (!gang) throw new PluginError("gang_not_found", 404);

      if (!(await tx.gangs.hasPermission(gangId, player.id, "invite"))) {
        throw new PluginError("forbidden", 403);
      }

      const [target] = await tx.db.select({ id: players.id, gangId: playerStats.gangId })
        .from(players).innerJoin(playerStats, eq(playerStats.playerId, players.id))
        .where(eq(players.username, body.username));
      if (!target) throw new PluginError("player_not_found", 404);
      if (target.gangId) throw new PluginError("already_in_a_gang", 409);

      const inviteId = newId();
      await tx.db.insert(gangInvites).values({
        id: inviteId, gangId, invitedPlayerId: target.id, invitedByPlayerId: player.id,
      });
      // Writes the notification row AND buffers notification.created with the
      // INVITEE as actor — byte-identical to what core published by hand, and
      // the actor awaitOwnEvent filters on (NOTES.md rule 4).
      await tx.notify(target.id, `${gang.name} invited you to join.`);
      await tx.gangLog({ gangId, playerId: player.id, message: `invited ${body.username}` });

      return { status: 201, body: { id: inviteId } };
    });
  },
});

const acceptInviteRoute = route({
  method: "POST",
  path: "/api/gangs/invites/:inviteId/accept",
  params: InviteParamsSchema,
  handler: async (ctx, { params }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      const [invite] = await tx.db.select().from(gangInvites)
        .where(eq(gangInvites.id, params.inviteId));
      if (!invite || invite.invitedPlayerId !== player.id) {
        throw new PluginError("invite_not_found", 404);
      }

      // Both rows through gangAndPlayer, not player alone: this transaction
      // touches the gangs row regardless — Postgres takes FOR KEY SHARE on it
      // when the player_stats.gang_id update, the gang_members insert and the
      // gang log each check their foreign key — so taking player_stats first
      // would put this path in the opposite order from the bank routes and
      // reopen the 40P01 deadlock M3 shipped (test/gang-lock-order.test.ts).
      await tx.locks.gangAndPlayer(invite.gangId, player.id);
      const [stats] = await tx.db.select({ gangId: playerStats.gangId }).from(playerStats)
        .where(eq(playerStats.playerId, player.id));
      if (stats?.gangId) throw new PluginError("already_in_a_gang", 409);

      await tx.db.update(playerStats).set({ gangId: invite.gangId })
        .where(eq(playerStats.playerId, player.id));
      await tx.db.insert(gangMembers).values({ gangId: invite.gangId, playerId: player.id });
      // Joining is the moment a dormant gang_permissions row for this
      // (gang, player) would silently go live, because the permission mask
      // only hides such a row while there is no gang_members row to join
      // against. PUT /permissions refuses a non-member target, so no route
      // can plant one — but rows predating that fix, or written out of band,
      // would still activate here. Clearing them mirrors removeMember, which
      // clears them on the way out.
      await tx.db.delete(gangPermissions).where(and(
        eq(gangPermissions.gangId, invite.gangId), eq(gangPermissions.playerId, player.id),
      ));
      await tx.db.delete(gangInvites).where(eq(gangInvites.invitedPlayerId, player.id));
      await tx.gangLog({ gangId: invite.gangId, playerId: player.id, message: "joined the gang" });

      await tx.events.publishCore({
        type: "gang.memberJoined",
        actorId: player.id,
        actorName: player.username,
        audience: { kind: "gang", gangId: invite.gangId },
        gangId: invite.gangId,
      });

      return { status: 200, body: await loadGangDto(tx.db, invite.gangId) };
    });
  },
});

const declineInviteRoute = route({
  method: "POST",
  path: "/api/gangs/invites/:inviteId/decline",
  params: InviteParamsSchema,
  handler: async (ctx, { params }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      const [deleted] = await tx.db.delete(gangInvites)
        .where(and(
          eq(gangInvites.id, params.inviteId),
          eq(gangInvites.invitedPlayerId, player.id),
        ))
        .returning({ id: gangInvites.id });
      if (!deleted) throw new PluginError("invite_not_found", 404);
      return { status: 204, body: null };
    });
  },
});

const leaveRoute = route({
  method: "POST",
  path: "/api/gangs/:gangId/leave",
  params: GangParamsSchema,
  handler: async (ctx, { params }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    const { gangId } = params;

    return ctx.transaction(async (tx) => {
      // Lock the gang row and the leaving player's stats row before
      // rechecking boss status under them. An unlocked pre-check followed by
      // the mutation would let a concurrent boss-transfer race this leave
      // (NOTES.md rule 2). gangAndPlayer, not player: removeMember ends in a
      // gang log whose insert takes FOR KEY SHARE on this gangs row anyway.
      await tx.locks.gangAndPlayer(gangId, player.id);
      const [gang] = await tx.db.select({ boss: gangs.bossPlayerId }).from(gangs)
        .where(eq(gangs.id, gangId));
      if (!gang) throw new PluginError("gang_not_found", 404);
      const [stats] = await tx.db.select({ gangId: playerStats.gangId }).from(playerStats)
        .where(eq(playerStats.playerId, player.id));
      if (stats?.gangId !== gangId) throw new PluginError("not_a_member", 404);
      if (gang.boss === player.id) throw new PluginError("boss_must_transfer_first", 409);
      await removeMember(tx, gangId, player.id, "left the gang");

      // gang.memberLeft's actor is the member who left — here, the caller, so
      // ctx.player.username replaces core's players read.
      await tx.events.publishCore({
        type: "gang.memberLeft",
        actorId: player.id,
        actorName: player.username,
        audience: { kind: "gang", gangId },
        gangId,
      });

      return { status: 204, body: null };
    });
  },
});

const transferRoute = route({
  method: "POST",
  path: "/api/gangs/:gangId/transfer",
  params: GangParamsSchema,
  body: TransferBodySchema,
  handler: async (ctx, { params, body }) => {
    const requester = ctx.player;
    if (requester === null) throw new PluginError("unauthorized", 401);
    const { gangId } = params;
    const targetId = body.playerId;

    return ctx.transaction(async (tx) => {
      // Same (gang, TARGET-player) pair and same helper as leave and kick.
      // Every check below reads under these locks rather than from an earlier
      // unlocked select: this route is precisely the concurrent writer that
      // leave's boss check defends against, so it must not itself act on a
      // stale boss id.
      await tx.locks.gangAndPlayer(gangId, targetId);
      const [gang] = await tx.db
        .select({ boss: gangs.bossPlayerId, underboss: gangs.underbossPlayerId, name: gangs.name })
        .from(gangs).where(eq(gangs.id, gangId));
      if (!gang) throw new PluginError("gang_not_found", 404);
      if (gang.boss !== requester.id) throw new PluginError("forbidden", 403);
      if (targetId === gang.boss) throw new PluginError("already_boss", 409);
      const [stats] = await tx.db.select({ gangId: playerStats.gangId }).from(playerStats)
        .where(eq(playerStats.playerId, targetId));
      if (stats?.gangId !== gangId) throw new PluginError("not_a_member", 404);

      await tx.db.update(gangs)
        // Promoting the underboss would otherwise leave one player holding
        // both offices, and the permission bypass reads either field —
        // harmless today, but it would make "demote the underboss" unable to
        // remove their bypass. Clear it in the same statement.
        .set(gang.underboss === targetId
          ? { bossPlayerId: targetId, underbossPlayerId: null }
          : { bossPlayerId: targetId })
        .where(eq(gangs.id, gangId));

      const [target] = await tx.db.select({ username: players.username }).from(players)
        .where(eq(players.id, targetId));
      await tx.gangLog({
        gangId, playerId: requester.id,
        message: `transferred leadership to ${target?.username ?? targetId}`,
      });
      // notification.created, not a new gang.* type: GameEventSchema is
      // consumed by exhaustive switches in the web client, so a new type
      // would be a client change too — and the new boss learning of it
      // privately is exactly what a notification is for. tx.notify writes the
      // row and buffers the event with the NEW BOSS as actor.
      await tx.notify(targetId, `You are now the boss of ${gang.name}.`);

      return { status: 204, body: null };
    });
  },
});

const kickRoute = route({
  method: "DELETE",
  path: "/api/gangs/:gangId/members/:playerId",
  params: MemberParamsSchema,
  handler: async (ctx, { params }) => {
    const requester = ctx.player;
    if (requester === null) throw new PluginError("unauthorized", 401);
    const { gangId, playerId: targetId } = params;

    return ctx.transaction(async (tx) => {
      // Existence before permission: a nonexistent gang must 404, not 403.
      // This pre-check is only ever the value used to answer 404; the boss
      // comparison below still trusts only the row re-read under the lock.
      const [gangExists] = await tx.db.select({ id: gangs.id }).from(gangs)
        .where(eq(gangs.id, gangId));
      if (!gangExists) throw new PluginError("gang_not_found", 404);

      if (!(await tx.gangs.hasPermission(gangId, requester.id, "kick"))) {
        throw new PluginError("forbidden", 403);
      }

      await tx.locks.gangAndPlayer(gangId, targetId);
      const [gang] = await tx.db.select({ boss: gangs.bossPlayerId }).from(gangs)
        .where(eq(gangs.id, gangId));
      if (!gang) throw new PluginError("gang_not_found", 404);
      const [stats] = await tx.db.select({ gangId: playerStats.gangId }).from(playerStats)
        .where(eq(playerStats.playerId, targetId));
      if (stats?.gangId !== gangId) throw new PluginError("not_a_member", 404);
      if (gang.boss === targetId) throw new PluginError("cannot_kick_boss", 409);
      await removeMember(tx, gangId, targetId,
        `kicked by ${requester.id === gang.boss ? "the boss" : "a permitted member"}`);

      // gang.memberLeft's actor is the member who left (events.ts) — for a
      // kick that is the KICKED player, not the kicker, matching
      // gang.memberJoined's actor being the joiner rather than whoever sent
      // the invite. So this one route still reads `players`. Pinned by
      // gang-membership.test.ts's "publishes gang.memberLeft with the
      // kicked player, not the kicker, as actor".
      const [actor] = await tx.db.select({ username: players.username }).from(players)
        .where(eq(players.id, targetId));
      await tx.events.publishCore({
        type: "gang.memberLeft",
        actorId: targetId,
        actorName: actor?.username ?? "unknown",
        audience: { kind: "gang", gangId },
        gangId,
      });

      return { status: 204, body: null };
    });
  },
});

const grantPermissionRoute = route({
  method: "PUT",
  path: "/api/gangs/:gangId/permissions",
  params: GangParamsSchema,
  body: GrantBodySchema,
  handler: async (ctx, { params, body }) => {
    const requester = ctx.player;
    if (requester === null) throw new PluginError("unauthorized", 401);
    const { gangId } = params;

    try {
      return await ctx.transaction(async (tx) => {
        const [gangExists] = await tx.db.select({ id: gangs.id }).from(gangs)
          .where(eq(gangs.id, gangId));
        if (!gangExists) throw new PluginError("gang_not_found", 404);

        if (!(await tx.gangs.hasPermission(gangId, requester.id, "grant_permissions"))) {
          throw new PluginError("forbidden", 403);
        }

        await tx.locks.gangAndPlayer(gangId, body.playerId);
        // Granting to a non-member used to be accepted and stored. The row
        // conferred nothing while the target was outside the gang, because
        // the permission mask inner-joins gang_members — but nothing deleted
        // it, so it lay dormant and went live the moment they joined, which
        // is a backdoor-planting primitive for anyone holding
        // grant_permissions. Refusing the grant means no dormant row is ever
        // created; accept-invite's cleanup handles rows this check cannot.
        const [member] = await tx.db.select({ gangId: gangMembers.gangId }).from(gangMembers)
          .where(and(eq(gangMembers.gangId, gangId), eq(gangMembers.playerId, body.playerId)));
        if (!member) throw new PluginError("not_a_member", 404);

        await tx.db.insert(gangPermissions)
          .values({ gangId, playerId: body.playerId, permission: body.permission })
          .onConflictDoNothing();
        await tx.gangLog({
          gangId, playerId: requester.id,
          message: `granted ${body.permission} to ${body.playerId}`,
        });
        return { status: 204, body: null };
      });
    } catch (error) {
      // body.playerId is only shape-validated (uuid), never checked for
      // existence. The membership check above intercepts a nonexistent player
      // id before it can reach gang_permissions.player_id's FK, but this
      // stays as a backstop so any future relaxation of that check still
      // returns a clean 4xx rather than an uncaught 500.
      if (isForeignKeyViolation(error)) throw new PluginError("player_not_found", 404);
      throw error;
    }
  },
});

const revokePermissionRoute = route({
  method: "DELETE",
  path: "/api/gangs/:gangId/permissions/:playerId/:permission",
  params: PermissionParamsSchema,
  handler: async (ctx, { params }) => {
    const requester = ctx.player;
    if (requester === null) throw new PluginError("unauthorized", 401);
    const { gangId, playerId: targetId, permission } = params;

    return ctx.transaction(async (tx) => {
      const [gangExists] = await tx.db.select({ id: gangs.id }).from(gangs)
        .where(eq(gangs.id, gangId));
      if (!gangExists) throw new PluginError("gang_not_found", 404);

      if (!(await tx.gangs.hasPermission(gangId, requester.id, "grant_permissions"))) {
        throw new PluginError("forbidden", 403);
      }

      await tx.db.delete(gangPermissions).where(and(
        eq(gangPermissions.gangId, gangId),
        eq(gangPermissions.playerId, targetId),
        eq(gangPermissions.permission, permission),
      ));
      await tx.gangLog({
        gangId, playerId: requester.id,
        message: `revoked ${permission} from ${targetId}`,
      });
      return { status: 204, body: null };
    });
  },
});

const depositRoute = route({
  method: "POST",
  path: "/api/gangs/:gangId/bank/deposit",
  params: GangParamsSchema,
  body: AmountBodySchema,
  handler: async (ctx, { params, body }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    const { gangId } = params;
    const amount = BigInt(body.amount);
    if (amount <= 0n) throw new PluginError("amount_must_be_positive", 400);

    return ctx.transaction(async (tx) => {
      const [gangExists] = await tx.db.select({ id: gangs.id }).from(gangs)
        .where(eq(gangs.id, gangId));
      if (!gangExists) throw new PluginError("gang_not_found", 404);

      const [membership] = await tx.db.select({ gangId: gangMembers.gangId }).from(gangMembers)
        .where(and(eq(gangMembers.gangId, gangId), eq(gangMembers.playerId, player.id)));
      if (!membership) throw new PluginError("not_a_member", 403);

      await tx.locks.gangAndPlayer(gangId, player.id);
      // Recheck under the lock: the unlocked membership check above can race
      // a concurrent kick/leave, which commits without contending for the
      // gang/player rows this transaction now holds. Lower stakes than
      // withdraw (money moving INTO the gang), but rechecked for consistency:
      // a route that is racy here and safe there is worse than either choice
      // made consistently.
      const [stillMember] = await tx.db.select({ gangId: gangMembers.gangId }).from(gangMembers)
        .where(and(eq(gangMembers.gangId, gangId), eq(gangMembers.playerId, player.id)));
      if (!stillMember) throw new PluginError("not_a_member", 403);

      try {
        await tx.economy.applyBalanceChange({
          playerId: player.id, amount: -amount, kind: "cash",
          reason: "gang.bank.deposit", refId: gangId,
        });
      } catch (error) {
        if (error instanceof InsufficientFundsError) {
          throw new PluginError("insufficient_cash", 400);
        }
        throw error;
      }
      const next = await tx.economy.applyGangBalanceChange({
        gangId, amount, kind: "bank", reason: "gang.bank.deposit", refId: player.id,
      });
      await tx.gangLog({
        gangId, playerId: player.id, message: `deposited ${amount} to the gang bank`,
      });

      return { status: 200, body: { bank: next.toString() } };
    });
  },
});

const withdrawRoute = route({
  method: "POST",
  path: "/api/gangs/:gangId/bank/withdraw",
  params: GangParamsSchema,
  body: AmountBodySchema,
  handler: async (ctx, { params, body }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    const { gangId } = params;
    const amount = BigInt(body.amount);
    if (amount <= 0n) throw new PluginError("amount_must_be_positive", 400);

    return ctx.transaction(async (tx) => {
      // Existence before permission: hasPermission returns false for a
      // nonexistent gang, which would otherwise mask a 404 as a 403.
      const [gangExists] = await tx.db.select({ id: gangs.id }).from(gangs)
        .where(eq(gangs.id, gangId));
      if (!gangExists) throw new PluginError("gang_not_found", 404);

      if (!(await tx.gangs.hasPermission(gangId, player.id, "bank.withdraw"))) {
        throw new PluginError("forbidden", 403);
      }

      await tx.locks.gangAndPlayer(gangId, player.id);
      // The TOCTOU defence, and the reason tx.gangs.hasPermission exists: the
      // unlocked pre-check above can race a concurrent DELETE /permissions,
      // which touches only gang_permissions (and gang_logs) — neither of
      // which gangAndPlayer locks — so it commits freely in the gap and would
      // otherwise let money move for a player who had no permission at the
      // instant it moved. This call reads through `tx`, so it observes
      // post-lock, post-commit state.
      if (!(await tx.gangs.hasPermission(gangId, player.id, "bank.withdraw"))) {
        throw new PluginError("forbidden", 403);
      }

      let next: bigint;
      try {
        next = await tx.economy.applyGangBalanceChange({
          gangId, amount: -amount, kind: "bank",
          reason: "gang.bank.withdraw", refId: player.id,
        });
      } catch (error) {
        if (error instanceof InsufficientGangFundsError) {
          throw new PluginError("insufficient_gang_funds", 400);
        }
        throw error;
      }
      await tx.economy.applyBalanceChange({
        playerId: player.id, amount, kind: "cash",
        reason: "gang.bank.withdraw", refId: gangId,
      });
      await tx.gangLog({
        gangId, playerId: player.id, message: `withdrew ${amount} from the gang bank`,
      });

      return { status: 200, body: { bank: next.toString() } };
    });
  },
});


/**
 * Every gang, for the admin art picker.
 *
 * `gangs` had no admin surface at all before this, which is why its logo slot
 * needs one: a per-row slot is bindable only if something can list the rows,
 * and core cannot enumerate a plugin's table on its behalf.
 *
 * `id` travels as the picker's `valueKey` and is never rendered — the rule
 * `test/admin-ids-hidden.test.ts` enforces across every admin surface.
 */
const adminGangListRoute = route({
  method: "GET", path: "/api/admin/gangs/list", auth: "admin",
  handler: async (ctx) => {
    return ctx.transaction(async (tx) => {
      const rows = await tx.db
        .select({ id: gangs.id, name: gangs.name })
        .from(gangs)
        .orderBy(gangs.name);
      return { status: 200, body: { rows } };
    });
  },
});

export default definePlugin({
  id: "gangs",
  version: "1.0.0",
  apiVersion: 1,
  basePaths: ["/api/gangs", "/api/admin/gangs"],
  pages: [{
    id: "gangs.index",
    path: "/gang",
    menu: { label: "Gang", order: 44, category: "social" },
    // Stub view: the client renders a hand-written override (apps/web
    // PAGE_OVERRIDES) for this id; the schema view exists because a
    // page declaration requires one.
    view: { kind: "list", items: [] },
  }],
  routes: [
    // Reads
    getGangRoute, gangLogsRoute, gangMembersRoute, myInvitesRoute,
    // Membership + invites
    createGangRoute, inviteRoute, acceptInviteRoute, declineInviteRoute,
    leaveRoute, transferRoute, kickRoute,
    // Permissions
    grantPermissionRoute, revokePermissionRoute,
    // Money
    depositRoute, withdrawRoute,
    adminGangListRoute,
  ],
  // A gang's crest. Admin-bound rather than player-uploaded: the whole asset
  // cluster is admin-only art, and letting members upload their own would be
  // the UGC path — moderation, quotas, takedowns — that is deliberately out of
  // scope.
  providesAssets: [
    { slot: "logo", label: "Gang logos", entitySource: "GET /api/admin/gangs/list", entityLabelKey: "name" },
  ],
  // No `menu`, `pages` or `events`: plugin-manifest-endpoint.test.ts:87
  // asserts a no-arg boot answers GET /api/plugins with exactly
  // { menu: [], pages: [], events: [] }. No `jobs`: buildApp throws at boot
  // if a core plugin declares any.
});
