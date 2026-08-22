import { TableRowsResponseSchema } from "@gl3/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { players, roleModuleAccess, roles, settings } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * The facility-fee admin panel — `GET/POST /api/admin/facilities` under the
 * `facilities` grant. The GET shows EFFECTIVE values (parser output with
 * defaults), the POST upserts the six keys; the boot-time settings snapshot
 * makes both restart-to-apply, which the page states out loud.
 */

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;

async function registerPlayer(username: string): Promise<{ token: string; playerId: string }> {
  return registerVerifiedPlayer({ app, redis }, { username });
}

/** First-registered player auto-becomes Administrator (`*`). */
async function giveRole(playerId: string, moduleKey: string): Promise<void> {
  const roleId = uuidv7();
  await db.insert(roles).values({ id: roleId, name: `role-${moduleKey}-${roleId.slice(-6)}` });
  await db.insert(roleModuleAccess).values({ roleId, moduleKey });
  await db.update(players).set({ roleId }).where(eq(players.id, playerId));
}

const auth = (token: string): { authorization: string } => ({ authorization: `Bearer ${token}` });

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer, redis } = await bootTestServer());
});

afterAll(async () => { await closeServer(); await conn.end(); });

describe("admin facilities: authorization", () => {
  it("401s with no token", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/facilities/table" });
    expect(res.statusCode).toBe(401);
  });

  it("403s a role with no grant", async () => {
    await registerPlayer("FirstAdmin");
    const p = await registerPlayer("NoRole");
    for (const method of ["GET", "POST"]) {
      const res = await app.inject({ method, url: method === "GET" ? "/api/admin/facilities/table" : "/api/admin/facilities", headers: auth(p.token) });
      expect(res.statusCode).toBe(403);
    }
  });

  it("200s the facilities grant and lists the page under /api/admin/plugins", async () => {
    await registerPlayer("FirstAdmin");
    const p = await registerPlayer("FeesMod");
    await giveRole(p.playerId, "facilities");
    const res = await app.inject({ method: "GET", url: "/api/admin/facilities/table", headers: auth(p.token) });
    expect(res.statusCode, res.body).toBe(200);
    const sections = (await app.inject({ method: "GET", url: "/api/admin/plugins", headers: auth(p.token) })).json().sections as { pluginId: string }[];
    expect(sections.some((s) => s.pluginId === "facilities")).toBe(true);
  });
});

describe("admin facilities: GET /api/admin/facilities/table", () => {
  it("shows parser-effective defaults — not raw stored values — for unset keys", async () => {
    const founder = await registerPlayer("Founder");
    const res = await app.inject({ method: "GET", url: "/api/admin/facilities/table", headers: auth(founder.token) });
    expect(res.statusCode, res.body).toBe(200);
    const parsed = TableRowsResponseSchema.safeParse(res.json());
    expect(parsed.success, JSON.stringify(res.json())).toBe(true);

    const byLabel = new Map((res.json().rows as { label: string; value: string }[]).map((r) => [r.label, r.value]));
    expect(byLabel.get("Bail per second (flat floor)")).toBe("1000");
    expect(byLabel.get("Bail wealth percent (0 = flat)")).toBe("1");
    expect(byLabel.get("Bail cap multiple of flat")).toBe("10");
    expect(byLabel.get("Discharge per second (flat floor)")).toBe("1000");
    expect(byLabel.get("Discharge wealth percent (0 = flat)")).toBe("1");
    expect(byLabel.get("Discharge cap multiple of flat")).toBe("10");
  });

  it("normalises a stored value through the parser rather than echoing it", async () => {
    const founder = await registerPlayer("Founder");
    // 150 is out of range: the panel must show the CLAMPED 100, not "150",
    // because what the admin needs to see is what the next boot will charge.
    await db.insert(settings).values({ key: "jail.bail_wealth_percent", value: "150" });
    const res = await app.inject({ method: "GET", url: "/api/admin/facilities/table", headers: auth(founder.token) });
    const byLabel = new Map((res.json().rows as { label: string; value: string }[]).map((r) => [r.label, r.value]));
    expect(byLabel.get("Bail wealth percent (0 = flat)")).toBe("100");
  });
});

describe("admin facilities: POST /api/admin/facilities", () => {
  const payload = {
    jail_bail_cost_per_second: "2000",
    jail_bail_wealth_percent: 2,
    jail_bail_wealth_cap_multiplier: 5,
    hospital_discharge_cost_per_second: "1500",
    hospital_discharge_wealth_percent: 0,
    hospital_discharge_wealth_cap_multiplier: 8,
  };

  it("upserts all six keys and they read back through the parsers", async () => {
    const founder = await registerPlayer("Founder");
    const res = await app.inject({ method: "POST", url: "/api/admin/facilities", headers: auth(founder.token), payload });
    expect(res.statusCode, res.body).toBe(204);

    const [percent] = await db.select().from(settings).where(eq(settings.key, "jail.bail_wealth_percent"));
    expect(percent?.value).toBe("2");
    const list = await app.inject({ method: "GET", url: "/api/admin/facilities/table", headers: auth(founder.token) });
    const byLabel = new Map((list.json().rows as { label: string; value: string }[]).map((r) => [r.label, r.value]));
    expect(byLabel.get("Bail per second (flat floor)")).toBe("2000");
    expect(byLabel.get("Discharge wealth percent (0 = flat)")).toBe("0");

    // A second write updates in place rather than violating the key PK.
    const again = await app.inject({
      method: "POST", url: "/api/admin/facilities", headers: auth(founder.token),
      payload: { ...payload, jail_bail_wealth_percent: 3 },
    });
    expect(again.statusCode, again.body).toBe(204);
    const [updated] = await db.select().from(settings).where(eq(settings.key, "jail.bail_wealth_percent"));
    expect(updated?.value).toBe("3");
  });

  it("accepts all-strings — the admin form serialises every field that way", async () => {
    const founder = await registerPlayer("Founder");
    const res = await app.inject({
      method: "POST", url: "/api/admin/facilities", headers: auth(founder.token),
      payload: Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, String(v)])),
    });
    expect(res.statusCode, res.body).toBe(204);
  });

  it("400s a non-digit money floor, an out-of-range percent, a zero cap, and an unknown key", async () => {
    const founder = await registerPlayer("Founder");
    const bad = await app.inject({
      method: "POST", url: "/api/admin/facilities", headers: auth(founder.token),
      payload: { ...payload, jail_bail_cost_per_second: "12.50" },
    });
    expect(bad.statusCode).toBe(400);

    const percent = await app.inject({
      method: "POST", url: "/api/admin/facilities", headers: auth(founder.token),
      payload: { ...payload, hospital_discharge_wealth_percent: 101 },
    });
    expect(percent.statusCode).toBe(400);

    const cap = await app.inject({
      method: "POST", url: "/api/admin/facilities", headers: auth(founder.token),
      payload: { ...payload, hospital_discharge_wealth_cap_multiplier: 0 },
    });
    expect(cap.statusCode).toBe(400);

    const extra = await app.inject({
      method: "POST", url: "/api/admin/facilities", headers: auth(founder.token),
      payload: { ...payload, bogus: "field" },
    });
    expect(extra.statusCode).toBe(400);
  });
});
