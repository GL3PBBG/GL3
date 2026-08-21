import {
  coreMenuBadges, coreProfileView, definePlugin, InsufficientFundsError, on, PluginError, route,
  type PageSchema, type PluginCtx,
} from "@gl3/plugin-sdk";
import { and, desc, eq, gt, isNull, lte, or } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { DETECTIVES_MIGRATIONS } from "./migrations.js";
import { detectiveSearches, locations, playerStats, players, settings } from "./schema.js";
export { activeReportTargetIds } from "./reports.js";

/**
 * V2's detectives module, GL3-shaped: the cross-location hunting layer.
 * Spec: docs/superpowers/specs/2026-08-12-detectives-design.md.
 * Owns and migrates `p_detectives_searches` (`migrations.ts`) — core held it
 * until `0007_relinquish_plugin_tables`. No combat coupling; no events, menu
 * or pages (plugin-manifest-endpoint.test.ts pins the no-arg boot payload) —
 * `adminPages` rides the separate `GET /api/admin/plugins` payload and is
 * outside that pin.
 */

// ---------------------------------------------------------------------------
// Settings, read at boot (restart to retune — system-wide limitation).
// Plugin-side keys are bare; the ctx prepends "detectives." (ctx.ts:289).
// Spec deviation recorded there: V2's shipped detectiveDuration default of
// `1` second is treated as a bug — GL3 defaults to a real hour.
// ---------------------------------------------------------------------------

const DEFAULT_COST = 125_000n;
const DEFAULT_DURATION_SECONDS = 3600;
const DEFAULT_EXPIRE_SECONDS = 600;

type Settings = { get(key: string): string | null };

function readCost(settings: Settings): bigint {
  const raw = settings.get("cost");
  if (raw === null) return DEFAULT_COST;
  return /^\d+$/.test(raw) ? BigInt(raw) : DEFAULT_COST;
}

function readSeconds(settings: Settings, key: string, fallback: number): number {
  const raw = settings.get(key);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const HireBodySchema = z.object({
  targetUsername: z.string().min(1).max(30),
  detectives: z.number().int().min(1).max(5),
  hours: z.number().int().min(1).max(5),
});

const hireRoute = route({
  method: "POST",
  path: "/api/detectives",
  // Explicit, though it is the SDK default: hiring from jail is allowed —
  // V2 gated only on login (spec §4).
  accessInJail: true,
  body: HireBodySchema,
  handler: async (ctx, { body }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    const cost = readCost(ctx.settings) * BigInt(body.detectives) * BigInt(body.hours);
    const durationSeconds = readSeconds(ctx.settings, "duration", DEFAULT_DURATION_SECONDS);
    const expireSeconds = readSeconds(ctx.settings, "expire", DEFAULT_EXPIRE_SECONDS);

    const result = await ctx.transaction(async (tx) => {
      // Plain SELECT, no lock: the username -> id mapping is immutable.
      const [target] = await tx.db
        .select({ id: players.id })
        .from(players)
        .where(eq(players.username, body.targetUsername));
      // 400s, not bounties' 404: the spec (§4) pins hire-input problems to 400.
      if (!target) throw new PluginError("target_not_found", 400);
      if (target.id === player.id) throw new PluginError("cannot_search_self", 400);

      // No pair lock, deliberately (spec §2 Locks): this debit locks only the
      // hirer's own player_stats row, and the INSERT's FKs take KEY SHARE on
      // `players` rows, which nothing in the codebase locks FOR UPDATE.
      let cash: bigint;
      try {
        cash = await tx.economy.applyBalanceChange({
          playerId: player.id, amount: -cost, kind: "cash", reason: "detectives.hire",
        });
      } catch (err) {
        if (err instanceof InsufficientFundsError) throw new PluginError("insufficient_funds", 409);
        throw err;
      }

      const id = uuidv7();
      const endsAt = new Date(Date.now() + durationSeconds * body.hours * 1000);
      await tx.db.insert(detectiveSearches).values({
        id, playerId: player.id, targetPlayerId: target.id,
        detectives: body.detectives, endsAt,
        // Snapshot at hire (read-at-boot posture): freezes this report's
        // window against later retuning, and lets combat read the deadline
        // without reaching into detectives' settings namespace.
        expiresAt: new Date(endsAt.getTime() + expireSeconds * 1000),
      });
      return { id, cash };
    });

    // Enqueue AFTER commit: inside the transaction a fast worker could claim
    // the job, find no row, and burn the idempotency slot before the commit
    // lands. If the enqueue itself fails the money stays gambled — the read
    // path treats NULL past ends_at as failed, so the row can never hang as
    // pending forever (spec §2).
    try {
      await ctx.jobs.enqueue("resolve", {
        searchId: result.id, detectives: body.detectives, hours: body.hours,
      });
    } catch (error) {
      ctx.log.error("failed to enqueue detectives resolve; search resolves as failed at ends_at", {
        err: String(error), searchId: result.id,
      });
    }

    return { status: 201, body: { searchId: result.id, cash: result.cash.toString() } };
  },
});

const listRoute = route({
  method: "GET",
  path: "/api/detectives",
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    const unitCost = readCost(ctx.settings);
    const durationSeconds = readSeconds(ctx.settings, "duration", DEFAULT_DURATION_SECONDS);
    const expireSeconds = readSeconds(ctx.settings, "expire", DEFAULT_EXPIRE_SECONDS);

    return ctx.transaction(async (tx) => {
      // Live tracking is this un-cached join (spec §2): the target's CURRENT
      // player_stats.location_id, resolved on every read. No state to keep.
      const rows = await tx.db
        .select({
          id: detectiveSearches.id,
          targetId: detectiveSearches.targetPlayerId,
          targetUsername: players.username,
          detectives: detectiveSearches.detectives,
          startedAt: detectiveSearches.startedAt,
          endsAt: detectiveSearches.endsAt,
          expiresAt: detectiveSearches.expiresAt,
          succeeded: detectiveSearches.succeeded,
          targetLocationId: playerStats.locationId,
          targetLocationName: locations.name,
        })
        .from(detectiveSearches)
        .innerJoin(players, eq(players.id, detectiveSearches.targetPlayerId))
        .leftJoin(playerStats, eq(playerStats.playerId, detectiveSearches.targetPlayerId))
        .leftJoin(locations, eq(locations.id, playerStats.locationId))
        .where(eq(detectiveSearches.playerId, player.id))
        // Bounded at 100 and NOT paginated — bounties' deliberate limitation.
        .orderBy(desc(detectiveSearches.startedAt), desc(detectiveSearches.id))
        .limit(100);

      const now = Date.now();
      return {
        status: 200,
        body: {
          // Unit cost so the client can preview cost x dets x hours.
          cost: unitCost.toString(),
          // Seconds per duration unit, so the client can label the 1–5
          // dropdown honestly ("1 hour" at 3600, "1 second" at V2's shipped
          // default of 1) instead of assuming hours.
          durationSeconds,
          searches: rows.map((r) => {
            const ended = now >= r.endsAt.getTime();
            const expiresAtMs = r.expiresAt?.getTime()
              ?? r.endsAt.getTime() + expireSeconds * 1000;
            // Time-gated reveal (spec §2): before ends_at the recorded roll
            // is never exposed. Past ends_at, NULL means the resolve job was
            // lost — the gamble reads as failed, never as pending forever.
            const succeeded = ended ? (r.succeeded ?? false) : null;
            const active = succeeded === true && now < expiresAtMs;
            return {
              id: r.id,
              targetId: r.targetId,
              targetUsername: r.targetUsername,
              detectives: r.detectives,
              startedAt: r.startedAt.toISOString(),
              endsAt: r.endsAt.toISOString(),
              expiresAt: new Date(expiresAtMs).toISOString(),
              succeeded,
              targetLocationId: active ? r.targetLocationId : null,
              targetLocationName: active ? r.targetLocationName : null,
            };
          }),
        },
      };
    });
  },
});

const RemoveParamsSchema = z.object({ searchId: z.string().uuid() });

const removeRoute = route({
  method: "DELETE",
  path: "/api/detectives/:searchId",
  params: RemoveParamsSchema,
  handler: async (ctx, { params }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      const removed = await tx.db.delete(detectiveSearches)
        .where(and(
          eq(detectiveSearches.id, params.searchId),
          eq(detectiveSearches.playerId, player.id),
        ))
        .returning({ id: detectiveSearches.id });
      // Foreign and nonexistent answer identically (spec §4): the ownership
      // predicate is in the DELETE itself, so there is no existence probe.
      if (removed.length === 0) throw new PluginError("not_found", 404);
      return { status: 200, body: { removed: true } };
    });
  },
});

// ---------------------------------------------------------------------------
// Admin — V2's detectives.admin.php, GL3-shaped after bullets' options panel.
// Reads and writes the settings TABLE, not `ctx.settings`: the snapshot is
// boot-time, so the panel shows what the next boot will read, and an edit
// takes effect on restart (which the panel says out loud).
// ---------------------------------------------------------------------------

const SETTING_LABELS = [
  ["cost", "Cost per detective per unit"],
  ["duration", "Seconds one duration unit lasts (V2's detectiveDuration; 3600 = real hours)"],
  ["expire", "Seconds a successful report stays live (V2's detectiveExpire)"],
] as const;

const AdminSettingsBodySchema = z.object({
  cost: z.string().regex(/^\d+$/),
  // The admin form serialises every field as a string (PageRenderer.tsx's
  // `body: Record<string, string>`), so these must coerce — bullets' options
  // panel is the same shape.
  duration: z.coerce.number().int().min(1),
  expire: z.coerce.number().int().min(1),
}).strict();

const adminSettingsListRoute = route({
  method: "GET", path: "/api/admin/detectives/settings", auth: "admin",
  handler: async (ctx) => {
    const rows = await ctx.transaction(async (tx) => tx.db.select().from(settings));
    const stored = new Map(rows.map((r) => [r.key, r.value]));
    const read: Settings = { get: (key) => stored.get(`detectives.${key}`) ?? null };

    const values: Record<(typeof SETTING_LABELS)[number][0], string> = {
      cost: readCost(read).toString(),
      duration: String(readSeconds(read, "duration", DEFAULT_DURATION_SECONDS)),
      expire: String(readSeconds(read, "expire", DEFAULT_EXPIRE_SECONDS)),
    };
    return {
      status: 200,
      body: { rows: SETTING_LABELS.map(([key, label]) => ({ key, label, value: values[key] })) },
    };
  },
});

const adminSettingsWriteRoute = route({
  method: "POST", path: "/api/admin/detectives/settings", auth: "admin",
  body: AdminSettingsBodySchema,
  handler: async (ctx, { body }) => {
    const values = [
      { key: "detectives.cost", value: body.cost },
      { key: "detectives.duration", value: String(body.duration) },
      { key: "detectives.expire", value: String(body.expire) },
    ];
    await ctx.transaction(async (tx) => {
      for (const row of values) {
        await tx.db.insert(settings).values(row)
          .onConflictDoUpdate({ target: settings.key, set: { value: row.value } });
      }
    });
    return { status: 204 };
  },
});

const adminPage: PageSchema = {
  id: "detectives-admin",
  path: "/admin/detectives",
  view: {
    kind: "panel", title: "Detectives",
    children: [
      { kind: "text", value: "The 1–5 \"hours\" dropdown is a unit count; the duration setting is how many real seconds one unit lasts (V2's detectiveDuration — 1 for fast testing, 3600 for real hours). Cost and success odds are per unit, not per real second. Edits take effect on the next server restart." },
      { kind: "table", source: "GET /api/admin/detectives/settings", columns: [
        { key: "label", label: "Setting" },
        { key: "value", label: "Value" },
      ] },
      { kind: "form", action: "POST /api/admin/detectives/settings", submitLabel: "Update settings", fields: [
        { name: "cost", label: "Cost per detective per unit", type: "money" },
        { name: "duration", label: "Seconds per duration unit", type: "number" },
        { name: "expire", label: "Report lifetime (seconds)", type: "number" },
      ] },
    ],
  },
};

// ---------------------------------------------------------------------------
// Resolve job — the roll happens HERE, seeded, not at hire time (spec §2):
// a BullMQ retry replays the same seed and the plugin_job_runs claim aborts
// it anyway. The outcome sits hidden in the row until ends_at (time-gated
// reveal) — no delayed job needed.
// ---------------------------------------------------------------------------

async function resolveJob(ctx: PluginCtx, data: Record<string, unknown>): Promise<void> {
  const searchId = String(data["searchId"]);
  const detectives = Number(data["detectives"]);
  const hours = Number(data["hours"]);
  const rng = ctx.job?.rng;
  if (rng === undefined) throw new Error("resolve job ran without a seeded rng");

  // One ctx.transaction per handler: the plugin_job_runs claim is structural
  // (first insert inside it), so a retry throws JobAlreadyAppliedError before
  // this callback runs.
  await ctx.transaction(async (tx) => {
    const [row] = await tx.db.select({ id: detectiveSearches.id })
      .from(detectiveSearches).where(eq(detectiveSearches.id, searchId));
    if (!row) return; // removed between enqueue and resolve

    // V2's formula: dets × 4 × hours percent (1–5 × 1–5 → 4%..100%).
    // rng.int is max-exclusive, so a draw of 0..99 against 100 always wins.
    const chancePercent = detectives * 4 * hours;
    const succeeded = rng.int(0, 100) < chancePercent;
    await tx.db.update(detectiveSearches).set({ succeeded })
      .where(eq(detectiveSearches.id, searchId));
  });
}

// ---------------------------------------------------------------------------
// core.profileView / core.menuBadges (spec deviation record above's shape,
// bounties' subscriber is the reference): an unconditional "Hire detective"
// link on any profile, and a nav badge counting the caller's OWN
// time-gated-reveal reports that are ready but not yet stale — same
// pending/failed/succeeded-expired/succeeded-active state machine listRoute
// computes, collapsed to "is there a live reveal waiting".
// ---------------------------------------------------------------------------

const profileExtras = on(coreProfileView, async (ctx, value) => ({
  ...value,
  extras: [...value.extras,
    { kind: "link" as const, pluginId: ctx.pluginId, label: "Hire detective", to: `/detectives?target=${value.targetId}` }],
}));

const menuBadge = on(coreMenuBadges, async (ctx, value) => {
  const player = ctx.player;
  if (player === null) return value;

  const now = new Date();
  const ready = await ctx.transaction(async (tx) => {
    const rows = await tx.db.select({ id: detectiveSearches.id })
      .from(detectiveSearches)
      .where(and(
        eq(detectiveSearches.playerId, player.id),
        lte(detectiveSearches.endsAt, now),
        or(isNull(detectiveSearches.expiresAt), gt(detectiveSearches.expiresAt, now)),
      ));
    return rows.length;
  });

  return ready > 0 ? [...value, { path: "/detectives", count: ready }] : value;
});

export default definePlugin({
  id: "detectives",
  version: "1.0.0",
  basePaths: ["/api/detectives", "/api/admin/detectives"],
  migrations: DETECTIVES_MIGRATIONS,
  routes: [hireRoute, listRoute, removeRoute, adminSettingsListRoute, adminSettingsWriteRoute],
  adminPages: [adminPage],
  jobs: { resolve: resolveJob },
  filters: [profileExtras, menuBadge],
});
