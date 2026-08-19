import { hasPermission } from "@gl3/plugin-sdk";
import { THEME_VARS } from "@gl3/shared";
import { eq, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { settings } from "../db/schema/index.js";
import { loadGrants } from "../plugins/routes.js";
import { DEFAULT_PRESET, navKey, overrideKey, presetKey, resolveTheme, THEME_PRESETS } from "./presets.js";

/**
 * The admin form serializes every field as a string, blank included, and the
 * POST replaces the WHOLE override set — a blank field clears its override
 * (the row is deleted, not stored as ""). Validation order matters for the
 * error codes: an unknown preset answers invalid_preset even when an override
 * is also bad, because the preset select is the field an admin looks at first.
 */
const ThemePostSchema = z.object({
  preset: z.string(),
  // Defaulted so a client predating the layout field stays valid — the admin
  // form always submits it.
  navPosition: z.enum(["top", "left"]).default("top"),
  ...Object.fromEntries(THEME_VARS.map((v) => [v, z.string()])),
}).strict();

const HEX = /^#[0-9a-fA-F]{6}$/;

export function registerThemeRoutes(app: FastifyInstance, db: Db): void {
  // Public — the login page is themed too, so this must answer before any
  // session exists. Reads the settings TABLE live, not the boot snapshot:
  // that is what makes an admin's change land on the next page load with no
  // restart, the same table-not-snapshot choice detectives' admin settings
  // routes made.
  app.get("/api/theme", async (_request, reply) => {
    const rows = await db.select({ key: settings.key, value: settings.value })
      .from(settings).where(like(settings.key, "theme.%"));
    return reply.send(resolveTheme(rows));
  });

  // Feeds the admin form's preset select (`optionsSource`).
  app.get("/api/admin/theme/presets", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const playerId = request.playerId;
    if (playerId === undefined) return reply.code(401).send({ error: "unauthorized" });
    const grants = await loadGrants(db, playerId);
    if (!hasPermission(grants, "theme")) return reply.code(403).send({ error: "forbidden" });
    return reply.send({ rows: Object.keys(THEME_PRESETS).map((id) => ({ id, name: id })) });
  });

  // Feeds the admin form's nav-position select. Static rows through a route
  // because the field vocabulary has no inline options — only `optionsSource`.
  app.get("/api/admin/theme/nav-options", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const playerId = request.playerId;
    if (playerId === undefined) return reply.code(401).send({ error: "unauthorized" });
    const grants = await loadGrants(db, playerId);
    if (!hasPermission(grants, "theme")) return reply.code(403).send({ error: "forbidden" });
    return reply.send({ rows: [
      { id: "top", name: "top (bar under the header)" },
      { id: "left", name: "left (sidebar column)" },
    ] });
  });

  app.get("/api/admin/theme/table", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const playerId = request.playerId;
    if (playerId === undefined) return reply.code(401).send({ error: "unauthorized" });
    const grants = await loadGrants(db, playerId);
    if (!hasPermission(grants, "theme")) return reply.code(403).send({ error: "forbidden" });

    const rows = await db.select({ key: settings.key, value: settings.value })
      .from(settings).where(like(settings.key, "theme.%"));
    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    const stored = byKey.get(presetKey());
    const preset = stored !== undefined && stored in THEME_PRESETS ? stored : DEFAULT_PRESET;
    return reply.send({
      rows: [
        { setting: "preset", value: preset },
        { setting: "nav", value: byKey.get(navKey()) === "left" ? "left" : "top" },
        ...THEME_VARS.map((v) => ({ setting: v, value: byKey.get(overrideKey(v)) ?? "" })),
      ],
    });
  });

  app.post("/api/admin/theme", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const playerId = request.playerId;
    if (playerId === undefined) return reply.code(401).send({ error: "unauthorized" });
    const grants = await loadGrants(db, playerId);
    if (!hasPermission(grants, "theme")) return reply.code(403).send({ error: "forbidden" });

    const body = ThemePostSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });
    if (!(body.data.preset in THEME_PRESETS)) {
      return reply.code(400).send({ error: "invalid_preset" });
    }
    const overrides = THEME_VARS
      .map((v) => ({ v, value: (body.data as Record<string, string>)[v]!.trim() }));
    if (overrides.some((o) => o.value !== "" && !HEX.test(o.value))) {
      return reply.code(400).send({ error: "invalid_color" });
    }

    await db.transaction(async (tx) => {
      await tx.insert(settings).values({ key: presetKey(), value: body.data.preset })
        .onConflictDoUpdate({ target: settings.key, set: { value: body.data.preset } });
      await tx.insert(settings).values({ key: navKey(), value: body.data.navPosition })
        .onConflictDoUpdate({ target: settings.key, set: { value: body.data.navPosition } });
      for (const { v, value } of overrides) {
        if (value === "") {
          await tx.delete(settings).where(eq(settings.key, overrideKey(v)));
        } else {
          await tx.insert(settings).values({ key: overrideKey(v), value })
            .onConflictDoUpdate({ target: settings.key, set: { value } });
        }
      }
    });
    return reply.code(204).send();
  });
}
