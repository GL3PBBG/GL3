import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { coreHud, coreProfileView, definePlugin, isInsufficientFundsError, on, PluginError, route } from "@gl3/plugin-sdk";
import { MEMBERSHIP_MIGRATIONS } from "./migrations.js";
import { benefits, isMember, MEMBERSHIP_TIMER_KEY, membershipUntil } from "./api.js";
import { adminPage, membershipPage } from "./pages.js";
import { membershipPackages, players } from "./schema.js";

export { MEMBERSHIP_TIMER_KEY, benefits, isMember, membershipUntil, type BenefitDecl } from "./api.js";
export { adminPage, membershipPage } from "./pages.js";

/** V2's `PM_seconds`-derived display string, largest whole unit only. */
function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  if (days > 0) return days === 1 ? "1 day" : `${days} days`;
  const hours = Math.floor(seconds / 3600);
  if (hours > 0) return hours === 1 ? "1 hour" : `${hours} hours`;
  const minutes = Math.max(1, Math.floor(seconds / 60));
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

/**
 * The live status as a `TableRowsResponse`. A page visit is what drives the
 * lazy `membershipUntil` expiry — this is the one route every member's
 * client hits routinely, so an expired row is reliably swept without a cron.
 */
const statusRoute = route({
  method: "GET",
  path: "/api/membership/status",
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      const until = await membershipUntil(tx, player.id);
      return {
        status: 200,
        body: {
          rows: [
            until === null
              ? { status: "Not a member", expiresAt: "—" }
              : { status: "Active", expiresAt: until.toISOString() },
          ],
        },
      };
    });
  },
});

/**
 * The catalogue as a `TableRowsResponse`, ordered `PM_seconds ASC` (V2
 * parity) — cheapest/shortest package first. Doubles as the buy form's
 * `optionsSource`; `id` is its `valueKey` and is never rendered as a column.
 */
const packagesRoute = route({
  method: "GET",
  path: "/api/membership/packages",
  handler: async (ctx) => {
    const rows = await ctx.transaction(async (tx) =>
      tx.db.select().from(membershipPackages).orderBy(membershipPackages.durationSeconds),
    );
    return {
      status: 200,
      body: {
        rows: rows.map((p) => ({
          id: p.id,
          name: p.name,
          costPoints: p.costPoints.toString(),
          duration: formatDuration(p.durationSeconds),
        })),
      },
    };
  },
});

/**
 * Empty today — consumers subscribe via `on(benefits, ...)` in Tasks 7–9.
 * `title`/`description` are already strings, so no shaping is needed here.
 */
const benefitsRoute = route({
  method: "GET",
  path: "/api/membership/benefits",
  handler: async (ctx) => {
    const list = await ctx.filters.apply(benefits, []);
    return { status: 200, body: { rows: list } };
  },
});

/**
 * Buy or extend membership. Stacking is V2's exact rule: extend from the
 * live expiry when one exists, else from now.
 *
 * `economy.applyBalanceChange` above already holds this player FOR UPDATE,
 * so the timers upsert's FK (FOR KEY SHARE) nests under it — rule 6, no
 * separate lock call needed.
 */
const buyRoute = route({
  method: "POST",
  path: "/api/membership/buy",
  body: z.object({ packageId: z.string().uuid() }),
  handler: async (ctx, { body }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      const [pkg] = await tx.db.select().from(membershipPackages).where(eq(membershipPackages.id, body.packageId));
      if (pkg === undefined) throw new PluginError("package_not_found", 404);

      try {
        await tx.economy.applyBalanceChange({
          playerId: player.id,
          amount: -pkg.costPoints,
          kind: "points",
          reason: "membership.buy",
          refId: pkg.id,
        });
      } catch (error) {
        if (isInsufficientFundsError(error)) throw new PluginError("insufficient_points", 409);
        throw error;
      }

      const current = await tx.timers.get(player.id, MEMBERSHIP_TIMER_KEY);
      const base = current !== null && current.getTime() > Date.now() ? current.getTime() : Date.now();
      const until = new Date(base + pkg.durationSeconds * 1000);
      await tx.timers.set(player.id, MEMBERSHIP_TIMER_KEY, until);

      await tx.events.publish({
        name: "purchased",
        actorId: player.id,
        actorName: player.username,
        audience: { kind: "player", playerId: player.id },
        payload: { packageName: pkg.name, until: until.toISOString() },
      });

      return { status: 200, body: { until: until.toISOString() } };
    });
  },
});

/**
 * Gift a package to another player by username. Mirrors `buyRoute`'s
 * stacking rule, but debits the buyer and extends the RECIPIENT's timer.
 *
 * `players` is the read-only mirror (schema.ts) — this is the second
 * consumer after `combat`'s pattern of locking both sides via one sorted
 * call before any balance change (rule 6, player↔player edge).
 */
const giftRoute = route({
  method: "POST",
  path: "/api/membership/gift",
  body: z.object({ packageId: z.string().uuid(), recipientName: z.string().min(1).max(100) }),
  handler: async (ctx, { body }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      const [pkg] = await tx.db.select().from(membershipPackages)
        .where(eq(membershipPackages.id, body.packageId));
      if (!pkg) throw new PluginError("package_not_found", 404);
      const [recipient] = await tx.db.select({ id: players.id, username: players.username })
        .from(players).where(eq(players.username, body.recipientName));
      if (!recipient) throw new PluginError("player_not_found", 404);
      if (recipient.id === player.id) throw new PluginError("cannot_gift_self", 400);

      // BOTH players, sorted, in ONE call, BEFORE any balance change — the
      // player↔player edge combat owns (rule 6). No new lock-order test:
      // participants share the helper, so a test would prove only the
      // already-safe case (NOTES.md rule-6 corollary).
      await tx.locks.player([player.id, recipient.id]);

      try {
        await tx.economy.applyBalanceChange({
          playerId: player.id, amount: -pkg.costPoints, kind: "points",
          reason: "membership.gift", refId: recipient.id,
        });
      } catch (error) {
        if (isInsufficientFundsError(error)) throw new PluginError("insufficient_points", 409);
        throw error;
      }
      const current = await tx.timers.get(recipient.id, MEMBERSHIP_TIMER_KEY);
      const base = current !== null && current.getTime() > Date.now() ? current.getTime() : Date.now();
      const until = new Date(base + pkg.durationSeconds * 1000);
      await tx.timers.set(recipient.id, MEMBERSHIP_TIMER_KEY, until);
      await tx.notify(recipient.id, `${player.username} gifted you ${pkg.name}.`);
      // Spec: "Plugin event membership.gifted to both audiences" — actorId/
      // actorName stay the buyer on both (the actor is who acted), but each
      // publish carries a different audience so both clients' ["membership",
      // "me"] invalidation fires, not just the buyer's.
      await tx.events.publish({
        name: "gifted",
        actorId: player.id, actorName: player.username,
        audience: { kind: "player", playerId: player.id },
        payload: { packageName: pkg.name, recipientName: recipient.username },
      });
      await tx.events.publish({
        name: "gifted",
        actorId: player.id, actorName: player.username,
        audience: { kind: "player", playerId: recipient.id },
        payload: { packageName: pkg.name, recipientName: recipient.username },
      });
      return { status: 200, body: { until: until.toISOString() } };
    });
  },
});

// ---------------------------------------------------------------------------
// Admin routes
// ---------------------------------------------------------------------------

/**
 * The page renderer posts every field in a form, sending "" for the ones the
 * admin left blank (`PageRenderer.tsx`'s form `onSubmit`). Blank is
 * normalised to `undefined` here so an update that only changes cost/duration
 * leaves the name untouched — theft's admin routes' convention
 * (`packages/plugins/theft/src/index.ts`), reused rather than reinvented.
 */
function blankable<T extends z.ZodTypeAny>(inner: T): z.ZodEffects<z.ZodOptional<T>> {
  return z.preprocess((v) => (v === "" ? undefined : v), inner.optional()) as never;
}

const PackageCreateSchema = z.object({
  name: z.string().min(1).max(255),
  costPoints: z.coerce.number().int().min(0),
  durationSeconds: z.coerce.number().int().min(60),
}).strict();
const PackageUpdateSchema = z.object({
  id: z.string().uuid(),
  name: blankable(z.string().min(1).max(255)),
  costPoints: z.coerce.number().int().min(0),
  durationSeconds: z.coerce.number().int().min(60),
}).strict();

/**
 * The catalogue as a `TableRowsResponse`. `id` is the update form's select
 * `valueKey` and is never rendered as a column.
 */
const adminPackageListRoute = route({
  method: "GET",
  path: "/api/admin/membership/packages",
  auth: "admin",
  handler: async (ctx) => {
    const rows = await ctx.transaction(async (tx) => tx.db.select().from(membershipPackages));
    return {
      status: 200,
      body: {
        rows: rows.map((p) => ({
          id: p.id,
          name: p.name,
          costPoints: p.costPoints.toString(),
          durationSeconds: String(p.durationSeconds),
        })),
      },
    };
  },
});

const adminPackageCreateRoute = route({
  method: "POST",
  path: "/api/admin/membership/packages",
  auth: "admin",
  body: PackageCreateSchema,
  handler: async (ctx, { body }) => {
    const id = uuidv7();
    await ctx.transaction(async (tx) => {
      await tx.db.insert(membershipPackages).values({
        id,
        name: body.name,
        costPoints: BigInt(body.costPoints),
        durationSeconds: body.durationSeconds,
      });
    });
    return { status: 201, body: { id } };
  },
});

const adminPackageUpdateRoute = route({
  method: "POST",
  path: "/api/admin/membership/packages/update",
  auth: "admin",
  body: PackageUpdateSchema,
  handler: async (ctx, { body }) => {
    const updated = await ctx.transaction(async (tx) => {
      const result = await tx.db
        .update(membershipPackages)
        .set({
          costPoints: BigInt(body.costPoints),
          durationSeconds: body.durationSeconds,
          ...(body.name !== undefined && { name: body.name }),
        })
        .where(eq(membershipPackages.id, body.id))
        .returning({ id: membershipPackages.id });
      return result.length > 0;
    });
    if (!updated) throw new PluginError("package_not_found", 404);
    return { status: 204 };
  },
});

const adminPackageDeleteRoute = route({
  method: "DELETE",
  path: "/api/admin/membership/packages/:id",
  auth: "admin",
  params: z.object({ id: z.string().uuid() }),
  handler: async (ctx, { params }) => {
    const deleted = await ctx.transaction(async (tx) => {
      const result = await tx.db.delete(membershipPackages)
        .where(eq(membershipPackages.id, params.id)).returning({ id: membershipPackages.id });
      return result.length > 0;
    });
    if (!deleted) throw new PluginError("package_not_found", 404);
    return { status: 204 };
  },
});

// ---------------------------------------------------------------------------
// core.hud / core.profileView (bounties'/detectives' subscriber shape).
// Both read `membershipUntil`/`isMember` — its lazy expiry-notification
// DELETE-as-claim is DESIGNED to be called from hot reads like these, so a
// caller's HUD load is what reliably sweeps their own expired timer with no
// cron. Never swap it for a raw select (api.ts).
// ---------------------------------------------------------------------------

const hudCountdown = on(coreHud, async (ctx, value) => {
  const player = ctx.player;
  if (player === null) return value;
  const until = await ctx.transaction(async (tx) => membershipUntil(tx, player.id));
  if (until === null) return value;
  return [...value, {
    pluginId: ctx.pluginId, label: "Membership", value: "Member", countdownTo: until.toISOString(),
  }];
});

const profileMemberStat = on(coreProfileView, async (ctx, value) => {
  const member = await ctx.transaction(async (tx) => isMember(tx, value.targetId));
  if (!member) return value;
  return {
    ...value,
    extras: [...value.extras, { kind: "stat" as const, pluginId: ctx.pluginId, label: "Membership", value: "Member" }],
  };
});

const purchasedEvent = {
  name: "purchased",
  payload: z.object({ packageName: z.string(), until: z.string() }),
  describe: "{actorName} bought {packageName}",
  invalidates: ["membership", "me"],
};

const giftedEvent = {
  name: "gifted",
  payload: z.object({ packageName: z.string(), recipientName: z.string() }),
  describe: "{actorName} gifted {packageName} to {recipientName}",
  invalidates: ["membership", "me"],
};

export default definePlugin({
  id: "membership",
  version: "1.0.0",
  basePaths: ["/api/membership", "/api/admin/membership"],
  tables: { packages: "p_membership_packages" },
  migrations: MEMBERSHIP_MIGRATIONS,
  routes: [
    statusRoute, packagesRoute, benefitsRoute, buyRoute, giftRoute,
    adminPackageListRoute, adminPackageCreateRoute, adminPackageUpdateRoute, adminPackageDeleteRoute,
  ],
  events: [purchasedEvent, giftedEvent],
  filters: [hudCountdown, profileMemberStat],
  // Documentation parity with casino's `provides: [games]`: nothing reads
  // `PluginManifest.provides` today, but this is the point a consumer
  // subscribes to via `on(benefits, ...)` to add display copy.
  provides: [benefits],
  pages: [membershipPage],
  adminPages: [adminPage],
});
