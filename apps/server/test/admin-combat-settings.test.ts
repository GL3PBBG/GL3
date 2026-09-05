import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { settings } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * The combat admin settings form, driven the way the declared-form renderer
 * drives it: the fields are read off the PRUNED admin page payload (the server
 * drops the `when: { progression }` field for the other model before the view
 * reaches the wire), prefilled from `GET /api/admin/combat/settings`, and
 * every surviving field is posted as a string. The default gl3 boot is a
 * routed (level) boot, so `newbie_exp_threshold` is never in the body — the
 * route must accept that rather than 400 on a key no client can send.
 */

const { db, sql: conn } = testDb();

let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;
let adminToken: string;

interface FormField { name: string; type: string; value?: string }
interface ViewNode { kind: string; children?: ViewNode[]; action?: string; fields?: FormField[] }
interface SectionsResponse { sections: { pluginId: string; pages: { view: ViewNode }[] }[] }

function findForm(node: ViewNode, action: string): ViewNode | null {
  if (node.kind === "form" && node.action === action) return node;
  for (const child of node.children ?? []) {
    const hit = findForm(child, action);
    if (hit !== null) return hit;
  }
  return null;
}

/** What `FormBlock` posts: every field on the pruned form, prefilled, as strings. */
async function clientBody(overrides: Record<string, string> = {}): Promise<Record<string, string>> {
  const sections = await app.inject({
    method: "GET", url: "/api/admin/plugins", headers: { authorization: `Bearer ${adminToken}` },
  });
  expect(sections.statusCode).toBe(200);
  const combat = (sections.json() as SectionsResponse).sections.find((s) => s.pluginId === "combat");
  expect(combat).toBeDefined();
  const form = findForm(combat!.pages[0]!.view, "POST /api/admin/combat/settings");
  expect(form).not.toBeNull();

  const prefill = await app.inject({
    method: "GET", url: "/api/admin/combat/settings", headers: { authorization: `Bearer ${adminToken}` },
  });
  expect(prefill.statusCode).toBe(200);
  const values = (prefill.json() as { values: Record<string, string> }).values;

  const body: Record<string, string> = {};
  for (const field of form!.fields ?? []) {
    body[field.name] = field.type === "hidden" ? (field.value ?? "") : (values[field.name] ?? "");
  }
  return { ...body, ...overrides };
}

const post = (body: Record<string, string>) =>
  app.inject({
    method: "POST", url: "/api/admin/combat/settings",
    headers: { authorization: `Bearer ${adminToken}` }, payload: body,
  });

const stored = async (key: string): Promise<string | null> => {
  const rows = await db.select().from(settings).where(eq(settings.key, `combat.${key}`));
  return rows[0]?.value ?? null;
};

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer, redis } = await bootTestServer());
  ({ token: adminToken } = await registerVerifiedPlayer({ app, redis }, { username: "Boss" }));
});

afterAll(async () => {
  await closeServer();
  await conn.end();
  redis.disconnect();
});

describe("admin combat settings form on the default (level) boot", () => {
  it("the pruned form omits the exp threshold and the route still accepts it", async () => {
    const body = await clientBody({ cooldown_seconds: "45" });
    expect(body).not.toHaveProperty("newbie_exp_threshold");
    expect(body).toHaveProperty("newbie_level_threshold");

    const res = await post(body);
    expect(res.statusCode, res.body).toBe(204);
    expect(await stored("cooldown_seconds")).toBe("45");
  });

  it("a blank deletes the stored row; an omitted key leaves its row alone", async () => {
    await db.insert(settings).values([
      { key: "combat.newbie_exp_threshold", value: "12345" },
      { key: "combat.hospital_seconds", value: "900" },
    ]);

    const res = await post(await clientBody({ hospital_seconds: "" }));
    expect(res.statusCode, res.body).toBe(204);
    expect(await stored("hospital_seconds")).toBeNull();
    // The other model's threshold is dormant on this boot, not the form's to
    // erase: it must survive a save untouched.
    expect(await stored("newbie_exp_threshold")).toBe("12345");
  });

  it("still rejects a malformed value", async () => {
    const res = await post(await clientBody({ cooldown_seconds: "-5" }));
    expect(res.statusCode).toBe(400);
  });

  it("stores the unarmed model from its select and refuses anything outside the enum", async () => {
    const ok = await post(await clientBody({ "unarmed.model": "melee", "unarmed.power": "3" }));
    expect(ok.statusCode, ok.body).toBe(204);
    expect(await stored("unarmed.model")).toBe("melee");
    expect(await stored("unarmed.power")).toBe("3");
    const bad = await post(await clientBody({ "unarmed.model": "bazooka" }));
    expect(bad.statusCode).toBe(400);
    // The select's options come from the admin route the form names.
    const options = await app.inject({
      method: "GET", url: "/api/admin/combat/unarmed-models", headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(options.statusCode).toBe(200);
    expect(options.json().map((o: { id: string }) => o.id)).toEqual(["firearm", "melee"]);
  });
});
