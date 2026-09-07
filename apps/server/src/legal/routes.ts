import { hasPermission } from "@gl3/plugin-sdk";
import { LegalDocSchema, type LegalDocResponse } from "@gl3/shared";
import { eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { settings } from "../db/schema/index.js";
import { loadGrants } from "../plugins/routes.js";
import { GAME_NAME_KEY, resolveGameName } from "../theme/presets.js";
import { PRIVACY_TEMPLATE } from "./privacy.js";
import { LEGAL_KEYS, renderLegal, type LegalPlaceholder } from "./render.js";
import { TERMS_TEMPLATE } from "./terms.js";

const ParamsSchema = z.object({ doc: LegalDocSchema });

const TEMPLATES = { terms: { title: "Terms of Service", body: TERMS_TEMPLATE }, privacy: { title: "Privacy Policy", body: PRIVACY_TEMPLATE } } as const;

const PLACEHOLDERS = Object.keys(LEGAL_KEYS) as (keyof typeof LEGAL_KEYS)[];

const SettingsPostSchema = z.object({
  operatorName: z.string().max(120).default(""),
  contactEmail: z.string().max(254).default(""),
  jurisdiction: z.string().max(120).default(""),
  effectiveDate: z.string().max(10).default(""),
}).strict();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

async function readLegalValues(db: Db): Promise<Partial<Record<LegalPlaceholder, string>>> {
  const rows = await db.select({ key: settings.key, value: settings.value }).from(settings)
    .where(inArray(settings.key, [...Object.values(LEGAL_KEYS), GAME_NAME_KEY]));
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const values: Partial<Record<LegalPlaceholder, string>> = { gameName: resolveGameName(rows) };
  for (const name of PLACEHOLDERS) {
    const v = byKey.get(LEGAL_KEYS[name]);
    if (v !== undefined) values[name] = v;
  }
  return values;
}

/**
 * Public read of the two legal documents plus the admin form behind them.
 * Reads the settings TABLE live, not the boot snapshot (theme's pattern), so
 * an operator's edit is on the next page load with no restart.
 */
export function registerLegalRoutes(app: FastifyInstance, db: Db): void {
  app.get("/api/legal/:doc", async (request, reply) => {
    const params = ParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_request" });
    const values = await readLegalValues(db);
    const { title, body } = TEMPLATES[params.data.doc];
    const rendered = renderLegal(body, values);
    const response: LegalDocResponse = {
      title, markdown: rendered.markdown,
      effectiveDate: values.effectiveDate?.trim() || null,
      missing: rendered.missing,
    };
    return reply.send(response);
  });

  app.get("/api/admin/legal/settings", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const playerId = request.playerId;
    if (playerId === undefined) return reply.code(401).send({ error: "unauthorized" });
    const grants = await loadGrants(db, playerId);
    if (!hasPermission(grants, "legal")) return reply.code(403).send({ error: "forbidden" });
    const values = await readLegalValues(db);
    const rows = PLACEHOLDERS.map((name) => ({ setting: name, value: values[name] ?? "" }));
    const formValues: Record<string, string> = {};
    for (const row of rows) formValues[row.setting] = row.value;
    return reply.send({ rows, values: formValues });
  });

  app.post("/api/admin/legal/settings", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const playerId = request.playerId;
    if (playerId === undefined) return reply.code(401).send({ error: "unauthorized" });
    const grants = await loadGrants(db, playerId);
    if (!hasPermission(grants, "legal")) return reply.code(403).send({ error: "forbidden" });
    const body = SettingsPostSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });
    const email = body.data.contactEmail.trim();
    if (email !== "" && !z.string().email().safeParse(email).success) return reply.code(400).send({ error: "invalid_email" });
    const date = body.data.effectiveDate.trim();
    if (date !== "" && !ISO_DATE.test(date)) return reply.code(400).send({ error: "invalid_date" });

    await db.transaction(async (tx) => {
      for (const name of PLACEHOLDERS) {
        const value = body.data[name].trim();
        const key = LEGAL_KEYS[name];
        if (value === "") await tx.delete(settings).where(eq(settings.key, key));
        else await tx.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
      }
    });
    return reply.send({});
  });
}
