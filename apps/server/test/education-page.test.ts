import { HudExtrasResponseSchema } from "@gl3/shared";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { adminPage as educationAdminPage } from "@gl3/plugin-education";
import { playerStats } from "../src/db/schema/index.js";
import { courses } from "./helpers/plugin-tables.js";
import { resetDb, testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;
let adminToken: string;

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer, redis } = await bootTestServer());
  adminToken = (await registerVerifiedPlayer({ app, redis }, { username: "Founder" })).token;
});

afterAll(async () => { await closeServer(); await conn.end(); });

const auth = () => ({ authorization: `Bearer ${adminToken}` });

describe("education board route", () => {
  it("serves the catalog with empty values, then gains activeName/daysRemaining after starting a course", async () => {
    // bootTestServer() runs plugin migrations but not `seedFamilyContent`
    // (that only runs from `apps/server/src/index.ts`, the real boot path —
    // see `education.test.ts`'s own manual insert), so the catalog here is
    // hand-seeded, the same as every other education test.
    await db.insert(courses).values([
      { id: uuidv7(), name: "Street Smarts", description: "Two days of hard lessons.", cost: 100n, days: 2, strengthGain: 1, agilityGain: 0, guardGain: 1, labourGain: 0, iqGain: 0 },
      { id: uuidv7(), name: "Boxing Basics", description: "Learn to take a hit.", cost: 200n, days: 4, strengthGain: 2, agilityGain: 0, guardGain: 1, labourGain: 1, iqGain: 0 },
      { id: uuidv7(), name: "Night School", description: "Books after dark.", cost: 300n, days: 7, strengthGain: 0, agilityGain: 0, guardGain: 0, labourGain: 0, iqGain: 5 },
    ]);

    const { token, playerId } = await registerVerifiedPlayer({ app, redis }, { username: "Alumnus" });
    const headers = { authorization: `Bearer ${token}` };
    await db.update(playerStats).set({ cash: 1000n }).where(eq(playerStats.playerId, playerId));

    const before = await app.inject({ method: "GET", url: "/api/education/board", headers });
    expect(before.statusCode).toBe(200);
    const beforeBody = before.json() as {
      rows: { id: string; name: string; status: string }[];
      values: Record<string, string>;
    };
    expect(beforeBody.rows.length).toBeGreaterThanOrEqual(3);
    expect(beforeBody.values).toEqual({});

    const target = beforeBody.rows.find((r) => r.name === "Street Smarts");
    expect(target).toBeDefined();

    const start = await app.inject({
      method: "POST", url: "/api/education/start", headers, payload: { courseId: target!.id },
    });
    expect(start.statusCode).toBe(200);

    const after = await app.inject({ method: "GET", url: "/api/education/board", headers });
    expect(after.statusCode).toBe(200);
    const afterBody = after.json() as { values: Record<string, string> };
    expect(afterBody.values.activeName).toBe("Street Smarts");
    expect(afterBody.values.daysRemaining).toBeDefined();
  });

  it("declares its page in /api/plugins", async () => {
    const res = await app.inject({ method: "GET", url: "/api/plugins", headers: auth() });
    const pages = (res.json() as { pages: { pluginId: string; id: string }[] }).pages;
    expect(pages.some((p) => p.pluginId === "education" && p.id === "education.index")).toBe(true);
  });
});

describe("education HUD signal", () => {
  it("carries the education entry only while a course is in flight", async () => {
    const courseId = uuidv7();
    await db.insert(courses).values({
      id: courseId, name: "Cryptography", description: "Codes and ciphers.", cost: 50n, days: 3,
      strengthGain: 0, agilityGain: 0, guardGain: 0, labourGain: 0, iqGain: 3,
    });

    const { token, playerId } = await registerVerifiedPlayer({ app, redis }, { username: "Scholar" });
    const headers = { authorization: `Bearer ${token}` };
    await db.update(playerStats).set({ cash: 1000n }).where(eq(playerStats.playerId, playerId));

    const before = await app.inject({ method: "GET", url: "/api/hud/extras", headers });
    expect(before.statusCode).toBe(200);
    const beforeHud = HudExtrasResponseSchema.parse(before.json());
    expect(beforeHud.entries.some((e) => e.pluginId === "education")).toBe(false);

    const start = await app.inject({
      method: "POST", url: "/api/education/start", headers, payload: { courseId },
    });
    expect(start.statusCode).toBe(200);

    const after = await app.inject({ method: "GET", url: "/api/hud/extras", headers });
    expect(after.statusCode).toBe(200);
    const afterHud = HudExtrasResponseSchema.parse(after.json());
    const entry = afterHud.entries.find((e) => e.pluginId === "education");
    expect(entry?.label).toBe("Course");
    expect(entry?.value).toContain("Cryptography");
  });
});

describe("education admin", () => {
  it("403s a non-admin on every one of the four routes", async () => {
    const pleb = await registerVerifiedPlayer({ app, redis }, { username: "Pleb2" });
    const headers = { authorization: `Bearer ${pleb.token}` };
    const routes: { method: "GET" | "POST" | "DELETE"; url: string }[] = [
      { method: "GET", url: "/api/admin/education/list" },
      { method: "POST", url: "/api/admin/education" },
      { method: "POST", url: "/api/admin/education/update" },
      { method: "DELETE", url: `/api/admin/education/${uuidv7()}` },
    ];
    for (const { method, url } of routes) {
      const res = await app.inject({ method, url, headers, payload: method === "GET" || method === "DELETE" ? undefined : {} });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it("creates a course and lists it as a TableRowsResponse", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/admin/education", headers: auth(),
      payload: {
        name: "Advanced Lockpicking", description: "Bypass anything.", cost: "500", days: 3,
        strengthGain: 1, agilityGain: 2, guardGain: 0, labourGain: 0, iqGain: 4,
      },
    });
    expect(res.statusCode).toBe(201);
    const { id } = res.json() as { id: string };

    const [row] = await db.select().from(courses).where(eq(courses.id, id));
    expect(row).toMatchObject({ name: "Advanced Lockpicking", cost: 500n, days: 3, iqGain: 4 });

    const list = await app.inject({ method: "GET", url: "/api/admin/education/list", headers: auth() });
    expect(list.statusCode).toBe(200);
    expect(list.json().rows).toContainEqual({
      id, name: "Advanced Lockpicking", description: "Bypass anything.", cost: "500", days: "3",
      strengthGain: "1", agilityGain: "2", guardGain: "0", labourGain: "0", iqGain: "4",
    });
  });

  it("updates a course with a blank name and keeps the old name", async () => {
    const id = uuidv7();
    await db.insert(courses).values({
      id, name: "Basket Weaving", description: "Weave baskets.", cost: 10n, days: 1,
      strengthGain: 0, agilityGain: 0, guardGain: 0, labourGain: 1, iqGain: 0,
    });

    const res = await app.inject({
      method: "POST", url: "/api/admin/education/update", headers: auth(),
      payload: {
        id, name: "", description: "", cost: "20", days: 2,
        strengthGain: 0, agilityGain: 0, guardGain: 0, labourGain: 2, iqGain: 0,
      },
    });
    expect(res.statusCode).toBe(204);

    const [row] = await db.select().from(courses).where(eq(courses.id, id));
    expect(row).toMatchObject({ name: "Basket Weaving", description: "Weave baskets.", cost: 20n, days: 2, labourGain: 2 });
  });

  it("404s an update to an unknown course id", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/admin/education/update", headers: auth(),
      payload: { id: uuidv7(), name: "", description: "", cost: "1", days: 1, strengthGain: 0, agilityGain: 0, guardGain: 0, labourGain: 0, iqGain: 0 },
    });
    expect(res.statusCode).toBe(404);
  });

  it("deletes a course", async () => {
    const id = uuidv7();
    await db.insert(courses).values({
      id, name: "Doomed 101", description: "Not long for this world.", cost: 1n, days: 1,
      strengthGain: 0, agilityGain: 0, guardGain: 0, labourGain: 0, iqGain: 0,
    });
    const del = await app.inject({ method: "DELETE", url: `/api/admin/education/${id}`, headers: auth() });
    expect(del.statusCode).toBe(204);
    expect(await db.select().from(courses).where(eq(courses.id, id))).toEqual([]);
  });

  it("refuses deleting a course with an in-flight enrollment, then succeeds once the player finishes", async () => {
    const id = uuidv7();
    await db.insert(courses).values({
      id, name: "Wedge Prevention 101", description: "Don't get stuck.", cost: 10n, days: 1,
      strengthGain: 1, agilityGain: 0, guardGain: 0, labourGain: 0, iqGain: 0,
    });

    const { token, playerId } = await registerVerifiedPlayer({ app, redis }, { username: "Wedged" });
    const headers = { authorization: `Bearer ${token}` };
    await db.update(playerStats).set({ cash: 1000n }).where(eq(playerStats.playerId, playerId));

    const start = await app.inject({
      method: "POST", url: "/api/education/start", headers, payload: { courseId: id },
    });
    expect(start.statusCode).toBe(200);

    // `p_education_progress` carries no FK to `p_courses` — an unconditional
    // delete here would wedge the enrolled player: no completion (the claim
    // subquery matches nothing) and no restart (`already_studying` blocks a
    // fresh enrollment, and there is no cancel route). The theft
    // car-in-use precedent (test/admin-theft.test.ts).
    const blocked = await app.inject({ method: "DELETE", url: `/api/admin/education/${id}`, headers: auth() });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toBe("course_in_use");
    expect((await db.select().from(courses).where(eq(courses.id, id))).length).toBe(1);

    // Force the enrollment into the past so the next real read claims it —
    // the same lazy-completion tick `settleAndRead` runs on every visit.
    await db.execute(sql`UPDATE p_education_progress SET started_at = now() - interval '2 days' WHERE course_id = ${id}`);
    const settle = await app.inject({ method: "GET", url: "/api/education", headers });
    expect(settle.statusCode).toBe(200);
    expect((settle.json() as { completedNow: string | null }).completedNow).toBe("Wedge Prevention 101");

    const del = await app.inject({ method: "DELETE", url: `/api/admin/education/${id}`, headers: auth() });
    expect(del.statusCode).toBe(204);
    expect(await db.select().from(courses).where(eq(courses.id, id))).toEqual([]);
  });

  it("404s deleting an unknown course id", async () => {
    const res = await app.inject({ method: "DELETE", url: `/api/admin/education/${uuidv7()}`, headers: auth() });
    expect(res.statusCode).toBe(404);
  });

  it("declares its section in /api/admin/plugins", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/plugins", headers: auth() });
    const sections = (res.json() as { sections: { pluginId: string; pages: { id: string }[] }[] }).sections;
    const educationSection = sections.find((s) => s.pluginId === "education");
    expect(educationSection?.pages.some((p) => p.id === "education-admin")).toBe(true);
  });

  it("never renders id as a table column, only as a select's valueKey", () => {
    const idKeys: string[] = [];
    const valueKeys: string[] = [];
    const walk = (node: unknown): void => {
      if (typeof node !== "object" || node === null) return;
      const n = node as Record<string, unknown>;
      if (n.kind === "table" && Array.isArray(n.columns)) {
        for (const c of n.columns as { key: string }[]) idKeys.push(c.key);
      }
      if (n.kind === "form" && Array.isArray(n.fields)) {
        for (const f of n.fields as { type: string; valueKey?: string }[]) {
          if (f.type === "select" && f.valueKey !== undefined) valueKeys.push(f.valueKey);
        }
      }
      for (const key of ["children", "items"]) {
        if (Array.isArray(n[key])) for (const child of n[key] as unknown[]) walk(child);
      }
    };
    walk(educationAdminPage.view);
    expect(idKeys.filter((k) => /^id$|Id$/.test(k))).toEqual([]);
    expect(valueKeys).toContain("id");
  });

  it("never renders id as a table column on the player page either", async () => {
    const { educationPage } = await import("@gl3/plugin-education");
    const idKeys: string[] = [];
    const walk = (node: unknown): void => {
      if (typeof node !== "object" || node === null) return;
      const n = node as Record<string, unknown>;
      if (n.kind === "table" && Array.isArray(n.columns)) {
        for (const c of n.columns as { key: string }[]) idKeys.push(c.key);
      }
      for (const key of ["children", "items"]) {
        if (Array.isArray(n[key])) for (const child of n[key] as unknown[]) walk(child);
      }
    };
    walk(educationPage.view);
    expect(idKeys.filter((k) => /^id$|Id$/.test(k))).toEqual([]);
  });
});
