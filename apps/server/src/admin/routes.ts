import { hasPermission, type PluginManifest } from "@gl3/plugin-sdk";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { clearBanned, markBanned } from "../auth/ban.js";
import { destroyAllSessions } from "../auth/session.js";
import type { Db } from "../db/client.js";
import { players, roleModuleAccess, rounds, roles } from "../db/schema/index.js";
import { collectAssetSlots, CORE_SCOPE, stampAssetBinderScope } from "../plugins/asset-slots.js";
import type { PagePayload } from "../plugins/manifest-endpoint.js";
import { loadGrants } from "../plugins/routes.js";
import { buildAssetsPage } from "./assets-page.js";
import { playersPage } from "./players-page.js";
import { rolesPage } from "./roles-page.js";
import { roundsPage } from "./rounds-page.js";

const AssignBodySchema = z.object({
  username: z.string().min(1),
  roleId: z.union([z.string().uuid(), z.literal(""), z.null()]).transform((v) => (v === "" ? null : v)),
}).strict();

const CreateRoleBodySchema = z.object({
  // Trimmed before the length check, not after: "   " is an empty name typed
  // into a text input, and a role listed as blank cannot be told apart from
  // any other blank role in the assign select.
  name: z.string().transform((v) => v.trim()).pipe(z.string().min(1)),
}).strict();

const GrantBodySchema = z.object({
  roleId: z.string().uuid(),
  moduleKey: z.string().min(1),
}).strict();

// `{ offset: true }` is not decoration: bare `.datetime()` accepts ONLY a `Z`
// suffix and rejects "2026-09-01T00:00:00+02:00" with the same
// `invalid_request` a malformed string gets — which looks fine in the web
// form (`toISOString()` is always `Z`) and fails only for the admin using
// `curl` from a non-UTC machine.
const RoundCreateBodySchema = z.object({
  name: z.string().transform((v) => v.trim()).pipe(z.string().min(1)),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }),
}).strict();

const RoundEditBodySchema = RoundCreateBodySchema.extend({ roundId: z.string().uuid() }).strict();

// The web form serializes EVERY field as a string ("" when blank); curl sends
// a number. Both shapes accepted; blank/absent expiry = permanent.
const BanBodySchema = z.object({
  username: z.string().min(1),
  reason: z.string().transform((v) => v.trim()).pipe(z.string().min(1)),
  expiresHours: z.union([z.number(), z.string()]).optional()
    .transform((v) => (v === undefined || v === "" ? null : Number(v)))
    .pipe(z.union([z.null(), z.number().int().positive()])),
}).strict();

/** Shared with `game/rounds/service.ts`'s settle() — an admin write and a
 *  rollover can then never interleave, so an edit cannot move `ends_at` out
 *  from under a finalize that has already frozen `final_*` against it. */
const ROUNDS_LOCK = 7461002;

/** Status is derived, never stored. */
function roundStatus(
  row: { startsAt: Date | null; endsAt: Date | null; finalizedAt: Date | null }, now: Date,
): string {
  if (row.finalizedAt !== null) return "finalized";
  if (row.startsAt === null || row.startsAt > now) return "scheduled";
  if (row.endsAt !== null && row.endsAt <= now) return "ended";
  return "active";
}

/** The `*` wildcard's label, kept out of the select's value — the value stays `*`. */
const WILDCARD_LABEL = "* (every module)";

/**
 * Every key `hasPermission` can be asked about: one per loaded plugin, plus
 * core's own `roles` module and the `*` wildcard.
 *
 * Derived from the loaded manifests rather than from the subset with
 * `adminPages`, because a grant is ABAC over the module — plugin routes call
 * `hasPermission(grants, <pluginId>)` whether or not the plugin also ships an
 * admin page, and a plugin gaining one later must not be the moment its key
 * first becomes grantable.
 */
function moduleKeysOf(manifests: readonly PluginManifest[]): { id: string; name: string }[] {
  const pluginIds = manifests.map((m) => m.id).sort((a, b) => a.localeCompare(b));
  return [
    { id: "*", name: WILDCARD_LABEL },
    { id: "roles", name: "roles" },
    // Grants the core art section: item, town and rank images. Named `core`
    // rather than `assets` because it IS the scope those slots are registered
    // under, and a second name for one thing is how the two drift apart.
    { id: CORE_SCOPE, name: "core (game art)" },
    { id: "rounds", name: "rounds" },
    { id: "players", name: "players (moderation)" },
    ...pluginIds.map((id) => ({ id, name: id })),
  ];
}

export function registerAdminRoutes(
  app: FastifyInstance, db: Db, redis: Redis, manifests: readonly PluginManifest[],
): void {
  // requireAuth is decorated by registerAuthRoutes, which app.ts runs first.
  // The grant check is two inline lines per handler on purpose: a helper
  // hiding reply.code(403) behind a return value reads worse than the
  // repetition.

  app.get("/api/admin/plugins", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const playerId = request.playerId;
    if (playerId === undefined) return reply.code(401).send({ error: "unauthorized" });
    const grants = await loadGrants(db, playerId);
    // Field-by-field copy, never a spread of the manifest page: the client
    // parses this with `AdminSectionsResponseSchema`, whose page schema is
    // `.strict()` and requires `pluginId` — which a `PageSchema` does not
    // carry, while its optional `menu` is a key strict would reject. Same
    // shape as manifest-endpoint.ts's `/api/plugins` pages.
    const sections: { pluginId: string; pages: PagePayload[] }[] = [];
    for (const manifest of manifests) {
      if (manifest.adminPages.length === 0) continue;
      if (!hasPermission(grants, manifest.id)) continue;
      sections.push({
        pluginId: manifest.id,
        pages: manifest.adminPages.map((p) => ({
          // The view is rewritten, not copied: `stampAssetBinderScope` fills
          // each upload widget's `scope` with this plugin's id so the widget
          // can only ever bind this plugin's own art.
          pluginId: manifest.id, id: p.id, path: p.path,
          view: stampAssetBinderScope(p.view, manifest.id),
        })),
      });
    }
    if (hasPermission(grants, "roles")) {
      sections.push({
        pluginId: "roles",
        pages: [{ pluginId: "roles", id: rolesPage.id, path: rolesPage.path, view: rolesPage.view }],
      });
    }
    if (hasPermission(grants, CORE_SCOPE)) {
      // Built per request from the live registry, so a newly installed plugin's
      // banner slot has a widget with no code change here. NOT stamped: each
      // binder already carries the scope of the slot it came from, and stamping
      // would rewrite every one of them to `core`.
      const assetsPage = buildAssetsPage(collectAssetSlots(manifests).values());
      sections.push({
        pluginId: CORE_SCOPE,
        pages: [{ pluginId: CORE_SCOPE, id: assetsPage.id, path: assetsPage.path, view: assetsPage.view }],
      });
    }
    if (hasPermission(grants, "rounds")) {
      sections.push({
        pluginId: "rounds",
        pages: [{ pluginId: "rounds", id: roundsPage.id, path: roundsPage.path, view: roundsPage.view }],
      });
    }
    if (hasPermission(grants, "players")) {
      sections.push({
        pluginId: "players",
        pages: [{ pluginId: "players", id: playersPage.id, path: playersPage.path, view: playersPage.view }],
      });
    }
    if (sections.length === 0) return reply.code(403).send({ error: "forbidden" });
    return reply.send({ sections });
  });

  app.get("/api/admin/roles", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const playerId = request.playerId;
    if (playerId === undefined) return reply.code(401).send({ error: "unauthorized" });
    const grants = await loadGrants(db, playerId);
    if (!hasPermission(grants, "roles")) return reply.code(403).send({ error: "forbidden" });
    const roleRows = await db.select().from(roles);
    const accessRows = await db.select().from(roleModuleAccess);
    const byRole = new Map<string, string[]>();
    for (const row of accessRows) {
      const list = byRole.get(row.roleId) ?? [];
      list.push(row.moduleKey);
      byRole.set(row.roleId, list);
    }
    return reply.send({
      roles: roleRows.map((r) => ({ id: r.id, name: r.name, moduleKeys: byRole.get(r.id) ?? [] })),
    });
  });

  // Table-source twin of GET /api/admin/roles: pre-stringified rows.
  app.get("/api/admin/roles/table", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const playerId = request.playerId;
    if (playerId === undefined) return reply.code(401).send({ error: "unauthorized" });
    const grants = await loadGrants(db, playerId);
    if (!hasPermission(grants, "roles")) return reply.code(403).send({ error: "forbidden" });
    const roleRows = await db.select().from(roles);
    const accessRows = await db.select().from(roleModuleAccess);
    const byRole = new Map<string, string[]>();
    for (const row of accessRows) {
      const list = byRole.get(row.roleId) ?? [];
      list.push(row.moduleKey);
      byRole.set(row.roleId, list);
    }
    return reply.send({
      rows: roleRows.map((r) => ({
        id: r.id, name: r.name, moduleKeys: (byRole.get(r.id) ?? []).join(", "),
      })),
    });
  });

  app.post("/api/admin/roles/assign", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const playerId = request.playerId;
    if (playerId === undefined) return reply.code(401).send({ error: "unauthorized" });
    const grants = await loadGrants(db, playerId);
    if (!hasPermission(grants, "roles")) return reply.code(403).send({ error: "forbidden" });
    const parsed = AssignBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });

    const [target] = await db.select({ id: players.id }).from(players)
      .where(eq(players.username, parsed.data.username));
    if (!target) return reply.code(404).send({ error: "player_not_found" });
    if (target.id === playerId) {
      return reply.code(400).send({ error: "cannot_demote_self" });
    }
    if (parsed.data.roleId !== null) {
      const [role] = await db.select({ id: roles.id }).from(roles)
        .where(eq(roles.id, parsed.data.roleId));
      if (!role) return reply.code(404).send({ error: "role_not_found" });
    }
    await db.update(players).set({ roleId: parsed.data.roleId }).where(eq(players.id, target.id));
    return reply.code(204).send();
  });

  // Table-source shape (`{ rows }`), not `{ modules }`: it feeds a `select`
  // field's `optionsSource`, which parses every response with
  // TableRowsResponseSchema regardless of what it is listing.
  app.get("/api/admin/roles/modules", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const playerId = request.playerId;
    if (playerId === undefined) return reply.code(401).send({ error: "unauthorized" });
    const grants = await loadGrants(db, playerId);
    if (!hasPermission(grants, "roles")) return reply.code(403).send({ error: "forbidden" });
    return reply.send({ rows: moduleKeysOf(manifests) });
  });

  app.post("/api/admin/roles", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const playerId = request.playerId;
    if (playerId === undefined) return reply.code(401).send({ error: "unauthorized" });
    const grants = await loadGrants(db, playerId);
    if (!hasPermission(grants, "roles")) return reply.code(403).send({ error: "forbidden" });
    const parsed = CreateRoleBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });

    const id = uuidv7();
    // Created with no grants on purpose: a role that could be born holding `*`
    // would make "create" a second, unaudited path to full admin.
    await db.insert(roles).values({ id, name: parsed.data.name });
    return reply.code(201).send({ id });
  });

  app.delete("/api/admin/roles/:id", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const playerId = request.playerId;
    if (playerId === undefined) return reply.code(401).send({ error: "unauthorized" });
    const grants = await loadGrants(db, playerId);
    if (!hasPermission(grants, "roles")) return reply.code(403).send({ error: "forbidden" });
    const parsed = z.object({ id: z.string().uuid() }).strict().safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });

    const [role] = await db.select({ id: roles.id }).from(roles).where(eq(roles.id, parsed.data.id));
    if (!role) return reply.code(404).send({ error: "role_not_found" });

    // Same lockout as `cannot_revoke_own_role`, one notch harder: deleting the
    // caller's own role strips admin from the account doing the deleting —
    // for the founder, from the only account that could restore it.
    const [self] = await db.select({ roleId: players.roleId }).from(players).where(eq(players.id, playerId));
    if (self?.roleId === parsed.data.id) {
      return reply.code(400).send({ error: "cannot_delete_own_role" });
    }

    // `players.role_id` is ON DELETE SET NULL, so the database would happily
    // demote every holder in silence. Refused instead: unassigning first makes
    // the demotion a deliberate act the admin performed, not a side effect.
    const [holder] = await db.select({ id: players.id }).from(players)
      .where(eq(players.roleId, parsed.data.id)).limit(1);
    if (holder !== undefined) return reply.code(409).send({ error: "role_in_use" });

    // Grants go with the role (`role_module_access.role_id` cascades).
    await db.delete(roles).where(eq(roles.id, parsed.data.id));
    return reply.code(204).send();
  });

  app.post("/api/admin/roles/grants", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const playerId = request.playerId;
    if (playerId === undefined) return reply.code(401).send({ error: "unauthorized" });
    const grants = await loadGrants(db, playerId);
    if (!hasPermission(grants, "roles")) return reply.code(403).send({ error: "forbidden" });
    const parsed = GrantBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });

    // Checked against the loaded manifests, not accepted as a free string: a
    // key no module ever asks about is a grant that silently does nothing,
    // indistinguishable from one that works until someone tests it.
    const known = moduleKeysOf(manifests).some((m) => m.id === parsed.data.moduleKey);
    if (!known) return reply.code(400).send({ error: "unknown_module" });

    const [role] = await db.select({ id: roles.id }).from(roles).where(eq(roles.id, parsed.data.roleId));
    if (!role) return reply.code(404).send({ error: "role_not_found" });

    await db.insert(roleModuleAccess)
      .values({ roleId: parsed.data.roleId, moduleKey: parsed.data.moduleKey })
      .onConflictDoNothing();
    return reply.code(204).send();
  });

  app.post("/api/admin/roles/grants/revoke", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const playerId = request.playerId;
    if (playerId === undefined) return reply.code(401).send({ error: "unauthorized" });
    const grants = await loadGrants(db, playerId);
    if (!hasPermission(grants, "roles")) return reply.code(403).send({ error: "forbidden" });
    const parsed = GrantBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });

    const [role] = await db.select({ id: roles.id }).from(roles).where(eq(roles.id, parsed.data.roleId));
    if (!role) return reply.code(404).send({ error: "role_not_found" });

    // The lockout this exists to stop: the only `*` grant sits on the founder's
    // own role, so revoking it strips admin from the one account that could
    // restore it. Rejecting the caller's *own role* — not just `*` — also keeps
    // an admin from cutting off the module they are standing in.
    const [self] = await db.select({ roleId: players.roleId }).from(players).where(eq(players.id, playerId));
    if (self?.roleId === parsed.data.roleId) {
      return reply.code(400).send({ error: "cannot_revoke_own_role" });
    }

    await db.delete(roleModuleAccess).where(and(
      eq(roleModuleAccess.roleId, parsed.data.roleId),
      eq(roleModuleAccess.moduleKey, parsed.data.moduleKey),
    ));
    return reply.code(204).send();
  });

  app.get("/api/admin/rounds", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const playerId = request.playerId;
    if (playerId === undefined) return reply.code(401).send({ error: "unauthorized" });
    const grants = await loadGrants(db, playerId);
    if (!hasPermission(grants, "rounds")) return reply.code(403).send({ error: "forbidden" });

    const now = new Date();
    const rows = await db.select().from(rounds).orderBy(sql`${rounds.startsAt} asc nulls last`);
    return reply.send({
      rounds: rows.map((r) => ({
        id: r.id,
        name: r.name,
        startsAt: r.startsAt?.toISOString() ?? null,
        endsAt: r.endsAt?.toISOString() ?? null,
        finalizedAt: r.finalizedAt?.toISOString() ?? null,
        status: roundStatus(r, now),
      })),
    });
  });

  // Table-source twin of GET /api/admin/rounds: pre-stringified rows. Never a
  // spread of the drizzle row — TableRowsResponseSchema requires every value
  // to be a string, and a raw Date/null fails the parse client-side, inside
  // PageRenderer, where it looks like a rendering bug rather than a handler one.
  app.get("/api/admin/rounds/table", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const playerId = request.playerId;
    if (playerId === undefined) return reply.code(401).send({ error: "unauthorized" });
    const grants = await loadGrants(db, playerId);
    if (!hasPermission(grants, "rounds")) return reply.code(403).send({ error: "forbidden" });

    const now = new Date();
    const rows = await db.select().from(rounds).orderBy(sql`${rounds.startsAt} asc nulls last`);
    return reply.send({
      rows: rows.map((r) => ({
        id: r.id,
        name: r.name,
        startsAt: r.startsAt?.toISOString() ?? "",
        endsAt: r.endsAt?.toISOString() ?? "",
        status: roundStatus(r, now),
      })),
    });
  });

  app.post("/api/admin/rounds", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const playerId = request.playerId;
    if (playerId === undefined) return reply.code(401).send({ error: "unauthorized" });
    const grants = await loadGrants(db, playerId);
    if (!hasPermission(grants, "rounds")) return reply.code(403).send({ error: "forbidden" });
    const parsed = RoundCreateBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });

    const startsAt = new Date(parsed.data.startsAt);
    const endsAt = new Date(parsed.data.endsAt);
    if (endsAt <= startsAt) return reply.code(400).send({ error: "invalid_window" });

    // Computed inside the transaction, replied after it commits — never
    // `reply.send()` from inside the callback. A reply sent before COMMIT can
    // report success for a row that a failed commit then rolls back, and
    // Fastify logs a "reply already sent" rejection when the callback's own
    // return races the already-sent reply. Every other transactional route in
    // this codebase binds the transaction's result first
    // (`game/hospital/routes.ts`, `game/rounds/service.ts`); this matches that.
    const result = await db.transaction(async (tx) => {
      // First statement — see ROUNDS_LOCK's comment. On its own, "SELECT for
      // an overlap, then INSERT" is a textbook check-then-act with no unique
      // index to fall back on, because an overlap is a predicate over two rows.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${ROUNDS_LOCK})`);

      // Half-open intervals: COALESCE(ends_at, 'infinity') so an open-ended
      // round conflicts with everything after its start. starts_at IS NULL
      // rows are excluded — they can never be active. Finalized rows are
      // excluded — a settled round is history.
      // Interpolated as ISO strings, not raw JS `Date`s: postgres.js's wire
      // encoder throws on a bare `Date` parameter with no column-derived type
      // to map it through (`ERR_INVALID_ARG_TYPE`), which the raw JS values
      // on this predicate's right-hand sides are — unlike `rounds.startsAt`
      // itself, whose column type carries the mapping. An ISO string needs no
      // such mapping; Postgres compares it against `timestamptz` untyped.
      const [clash] = await tx.select({ id: rounds.id }).from(rounds)
        .where(sql`${rounds.finalizedAt} is null
                   and ${rounds.startsAt} is not null
                   and ${rounds.startsAt} < ${endsAt.toISOString()}
                   and ${startsAt.toISOString()} < coalesce(${rounds.endsAt}, 'infinity'::timestamptz)`)
        .limit(1);
      if (clash) return { kind: "overlap" as const };

      const id = uuidv7();
      await tx.insert(rounds).values({ id, name: parsed.data.name, startsAt, endsAt });
      return { kind: "created" as const, id };
    });

    if (result.kind === "overlap") return reply.code(400).send({ error: "round_overlap" });
    return reply.code(201).send({ id: result.id });
  });

  app.post("/api/admin/rounds/edit", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const playerId = request.playerId;
    if (playerId === undefined) return reply.code(401).send({ error: "unauthorized" });
    const grants = await loadGrants(db, playerId);
    if (!hasPermission(grants, "rounds")) return reply.code(403).send({ error: "forbidden" });
    const parsed = RoundEditBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });

    const startsAt = new Date(parsed.data.startsAt);
    const endsAt = new Date(parsed.data.endsAt);
    if (endsAt <= startsAt) return reply.code(400).send({ error: "invalid_window" });

    // Computed inside the transaction, replied after it commits — see the
    // create route's comment on the same shape.
    const result = await db.transaction(async (tx) => {
      // Same lock, first statement, as the create route — see ROUNDS_LOCK's
      // comment: an admin write and a rollover can then never interleave.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${ROUNDS_LOCK})`);

      const [target] = await tx.select().from(rounds).where(eq(rounds.id, parsed.data.roundId));
      if (!target) return { kind: "not_found" as const };
      if (target.finalizedAt !== null) return { kind: "finalized" as const };

      // Same ISO-string interpolation as the create route's overlap check —
      // a bare `Date` here throws inside postgres.js's wire encoder.
      const [clash] = await tx.select({ id: rounds.id }).from(rounds)
        .where(sql`${rounds.finalizedAt} is null
                   and ${rounds.startsAt} is not null
                   and ${rounds.startsAt} < ${endsAt.toISOString()}
                   and ${startsAt.toISOString()} < coalesce(${rounds.endsAt}, 'infinity'::timestamptz)
                   and ${rounds.id} <> ${parsed.data.roundId}`)
        .limit(1);
      if (clash) return { kind: "overlap" as const };

      await tx.update(rounds)
        .set({ name: parsed.data.name, startsAt, endsAt })
        .where(eq(rounds.id, parsed.data.roundId));
      return { kind: "ok" as const };
    });

    switch (result.kind) {
      case "not_found": return reply.code(404).send({ error: "round_not_found" });
      case "finalized": return reply.code(400).send({ error: "round_finalized" });
      case "overlap": return reply.code(400).send({ error: "round_overlap" });
      case "ok": return reply.code(204).send();
    }
  });

  app.delete("/api/admin/rounds/:id", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const playerId = request.playerId;
    if (playerId === undefined) return reply.code(401).send({ error: "unauthorized" });
    const grants = await loadGrants(db, playerId);
    if (!hasPermission(grants, "rounds")) return reply.code(403).send({ error: "forbidden" });
    const parsed = z.object({ id: z.string().uuid() }).strict().safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });

    const result = await db.transaction(async (tx) => {
      // Same lock, first statement, as create and edit: a delete and a
      // rollover must never interleave — `ensureCurrentRound` could otherwise
      // be mid-settle onto the round this removes.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${ROUNDS_LOCK})`);

      const [target] = await tx.select().from(rounds).where(eq(rounds.id, parsed.data.id));
      if (!target) return "not_found" as const;
      // Only a round that never ran is deletable. An active or ended round is
      // owed a settle, and a finalized one IS the hall of fame — its
      // `round_entries` cascade, so deleting it erases the record.
      if (roundStatus(target, new Date()) !== "scheduled") return "started" as const;

      await tx.delete(rounds).where(eq(rounds.id, parsed.data.id));
      return "ok" as const;
    });

    if (result === "not_found") return reply.code(404).send({ error: "round_not_found" });
    if (result === "started") return reply.code(409).send({ error: "round_not_scheduled" });
    return reply.code(204).send();
  });

  // ── Player moderation ────────────────────────────────────────────────────
  // Gated on the `players` grant. Ban state lives on the players row (truth)
  // mirrored into a `banned:<id>` Redis flag (cache) read by requireAuth on
  // every request — see auth/ban.ts.

  // Table-source: pre-stringified rows, like the rounds table above. The 50
  // most recently seen players, PLUS every currently banned one regardless of
  // recency — a moderator lifting an old ban must be able to see it.
  app.get("/api/admin/players/table", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const playerId = request.playerId;
    if (playerId === undefined) return reply.code(401).send({ error: "unauthorized" });
    const grants = await loadGrants(db, playerId);
    if (!hasPermission(grants, "players")) return reply.code(403).send({ error: "forbidden" });

    const now = new Date();
    const activeBan = sql`${players.bannedAt} is not null
      and (${players.banExpiresAt} is null or ${players.banExpiresAt} > now())`;
    const rows = await db.select({
      id: players.id, username: players.username, roleName: roles.name,
      lastSeenAt: players.lastSeenAt, emailVerifiedAt: players.emailVerifiedAt, email: players.email,
      bannedAt: players.bannedAt, banReason: players.banReason, banExpiresAt: players.banExpiresAt,
    }).from(players).leftJoin(roles, eq(players.roleId, roles.id))
      .where(sql`(${activeBan}) or ${players.id} in (
        select id from players order by last_seen_at desc nulls last limit 50)`)
      .orderBy(sql`${players.lastSeenAt} desc nulls last`);

    return reply.send({
      rows: rows.map((r) => {
        const banActive = r.bannedAt !== null && (r.banExpiresAt === null || r.banExpiresAt > now);
        return {
          id: r.id,
          username: r.username,
          role: r.roleName ?? "",
          lastSeen: r.lastSeenAt?.toISOString() ?? "",
          // Mirrors login's grandfathering: a row with no email is never gated.
          verified: r.emailVerifiedAt !== null || r.email === null ? "yes" : "no",
          banned: banActive
            ? `${r.banReason ?? ""}${r.banExpiresAt ? ` (until ${r.banExpiresAt.toISOString()})` : ""}`.trim()
            : "",
        };
      }),
    });
  });

  app.post("/api/admin/players/ban", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const playerId = request.playerId;
    if (playerId === undefined) return reply.code(401).send({ error: "unauthorized" });
    const grants = await loadGrants(db, playerId);
    if (!hasPermission(grants, "players")) return reply.code(403).send({ error: "forbidden" });
    const parsed = BanBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });

    const [target] = await db.select({ id: players.id }).from(players)
      .where(eq(players.username, parsed.data.username));
    if (!target) return reply.code(404).send({ error: "player_not_found" });
    // Counterpart of cannot_demote_self: a moderator locking themselves out
    // is never what the click meant.
    if (target.id === playerId) return reply.code(409).send({ error: "cannot_ban_self" });

    const expiresAt = parsed.data.expiresHours === null
      ? null : new Date(Date.now() + parsed.data.expiresHours * 3600_000);
    await db.update(players)
      .set({ bannedAt: sql`now()`, banReason: parsed.data.reason, banExpiresAt: expiresAt })
      .where(eq(players.id, target.id));
    // Row first, then flag, then sessions: if the process dies mid-way the
    // row already holds the ban and the next login re-asserts the rest.
    await markBanned(redis, target.id, expiresAt);
    await destroyAllSessions(redis, target.id);
    return reply.code(200).send({ banned: true });
  });

  app.post("/api/admin/players/:id/unban", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const playerId = request.playerId;
    if (playerId === undefined) return reply.code(401).send({ error: "unauthorized" });
    const grants = await loadGrants(db, playerId);
    if (!hasPermission(grants, "players")) return reply.code(403).send({ error: "forbidden" });
    const parsed = z.object({ id: z.string().uuid() }).strict().safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });

    const [target] = await db.select({ id: players.id }).from(players)
      .where(eq(players.id, parsed.data.id));
    if (!target) return reply.code(404).send({ error: "player_not_found" });

    await db.update(players)
      .set({ bannedAt: null, banReason: null, banExpiresAt: null })
      .where(eq(players.id, target.id));
    await clearBanned(redis, target.id);
    return reply.code(200).send({ banned: false });
  });
}
