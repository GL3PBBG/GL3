import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { settings } from "../src/db/schema/index.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { resetDb, testDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, redis, close: closeServer } = await bootTestServer());
});
afterAll(async () => { await closeServer(); await conn.end(); });

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe("GET /api/legal/:doc", () => {
  it("is public and lists unset placeholders", async () => {
    const res = await app.inject({ method: "GET", url: "/api/legal/terms" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.title).toBe("Terms of Service");
    expect(body.markdown).toContain("[operator name not set]");
    expect(body.effectiveDate).toBeNull();
    expect(body.missing).toEqual(expect.arrayContaining(["operatorName", "contactEmail", "jurisdiction", "effectiveDate"]));
    expect(body.missing).not.toContain("gameName"); // branding falls back to "GL3"
  });

  it("renders settings when set", async () => {
    await db.insert(settings).values([
      { key: "legal.operator_name", value: "Acme Games" },
      { key: "legal.contact_email", value: "legal@acme.test" },
      { key: "legal.jurisdiction", value: "Ohio, USA" },
      { key: "legal.effective_date", value: "2026-09-07" },
    ]);
    const res = await app.inject({ method: "GET", url: "/api/legal/privacy" });
    const body = res.json();
    expect(body.title).toBe("Privacy Policy");
    expect(body.markdown).toContain("Acme Games");
    expect(body.markdown).toContain("legal@acme.test");
    expect(body.effectiveDate).toBe("2026-09-07");
    expect(body.missing).toEqual([]);
  });

  it("400 on an unknown document", async () => {
    expect((await app.inject({ method: "GET", url: "/api/legal/eula" })).statusCode).toBe(400);
  });
});

describe("admin legal settings", () => {
  it("first player (Administrator) can read and write; a plain player is forbidden", async () => {
    const admin = await registerVerifiedPlayer({ app, redis }, { remoteAddress: "10.9.8.1" });
    const pleb = await registerVerifiedPlayer({ app, redis }, { remoteAddress: "10.9.8.2" });

    expect((await app.inject({ method: "GET", url: "/api/admin/legal/settings", headers: auth(pleb.token) })).statusCode).toBe(403);

    const post = await app.inject({ method: "POST", url: "/api/admin/legal/settings", headers: auth(admin.token), payload: {
      operatorName: "Acme", contactEmail: "legal@acme.test", jurisdiction: "", effectiveDate: "2026-09-07",
    } });
    expect(post.statusCode).toBe(200);

    const get = await app.inject({ method: "GET", url: "/api/admin/legal/settings", headers: auth(admin.token) });
    const getBody = get.json();
    expect(getBody.rows).toEqual([
      { setting: "operatorName", value: "Acme" },
      { setting: "contactEmail", value: "legal@acme.test" },
      { setting: "jurisdiction", value: "" },
      { setting: "effectiveDate", value: "2026-09-07" },
    ]);
    expect(getBody.values).toEqual({
      operatorName: "Acme", contactEmail: "legal@acme.test", jurisdiction: "", effectiveDate: "2026-09-07",
    });

    const pub = await app.inject({ method: "GET", url: "/api/legal/terms" });
    expect(pub.json().missing).toEqual(["jurisdiction"]);
  });

  it("rejects a malformed email or date", async () => {
    const admin = await registerVerifiedPlayer({ app, redis }, { remoteAddress: "10.9.8.3" });
    const badMail = await app.inject({ method: "POST", url: "/api/admin/legal/settings", headers: auth(admin.token), payload: { operatorName: "", contactEmail: "nope", jurisdiction: "", effectiveDate: "" } });
    expect(badMail.json()).toEqual({ error: "invalid_email" });
    const badDate = await app.inject({ method: "POST", url: "/api/admin/legal/settings", headers: auth(admin.token), payload: { operatorName: "", contactEmail: "", jurisdiction: "", effectiveDate: "7/9/2026" } });
    expect(badDate.json()).toEqual({ error: "invalid_date" });
  });

  it("the legal section appears in /api/admin/plugins for the admin", async () => {
    const admin = await registerVerifiedPlayer({ app, redis }, { remoteAddress: "10.9.8.4" });
    const res = await app.inject({ method: "GET", url: "/api/admin/plugins", headers: auth(admin.token) });
    const ids = (res.json().sections as { pluginId: string }[]).map((s) => s.pluginId);
    expect(ids).toContain("legal");
  });
});
