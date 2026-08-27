import { HudExtrasResponseSchema } from "@gl3/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { adminPage as jobsAdminPage } from "@gl3/plugin-jobs";
import { jobCatalog, jobRanks, playerJobs } from "./helpers/plugin-tables.js";
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

/**
 * `bootTestServer()` does not run `seedFamilyContent` (that only runs from
 * the real boot path — `education-page.test.ts`'s own note), so the catalog
 * here is hand-seeded, two jobs with two ranks each — four ranks total, the
 * board's ≥ 4 rows floor.
 */
async function seedJobs(): Promise<{ dockJobId: string; loaderId: string; foremanId: string; shopJobId: string }> {
  const dockJobId = uuidv7();
  const loaderId = uuidv7();
  const foremanId = uuidv7();
  const shopJobId = uuidv7();
  const clerkId = uuidv7();
  const managerId = uuidv7();
  await db.insert(jobRanks).values([
    { id: loaderId, jobId: dockJobId, name: "Loader", pay: 100n, strengthGain: 2, labourGain: 0, iqGain: 1, strengthReq: 0, labourReq: 0, iqReq: 0 },
    { id: foremanId, jobId: dockJobId, name: "Foreman", pay: 200n, strengthGain: 3, labourGain: 0, iqGain: 2, strengthReq: 10, labourReq: 0, iqReq: 0 },
    { id: clerkId, jobId: shopJobId, name: "Clerk", pay: 80n, strengthGain: 0, labourGain: 1, iqGain: 1, strengthReq: 0, labourReq: 0, iqReq: 0 },
    { id: managerId, jobId: shopJobId, name: "Manager", pay: 180n, strengthGain: 0, labourGain: 2, iqGain: 2, strengthReq: 0, labourReq: 20, iqReq: 0 },
  ]);
  await db.insert(jobCatalog).values([
    { id: dockJobId, name: "Dock Worker", description: "Heavy boxes, honest pay.", firstRankId: loaderId },
    { id: shopJobId, name: "Copy Shop", description: "Toner and patience.", firstRankId: clerkId },
  ]);
  return { dockJobId, loaderId, foremanId, shopJobId };
}

describe("jobs board route", () => {
  it("serves rows keyed by rank with empty values, then gains jobName/rankName/pay after an interview", async () => {
    const { dockJobId, loaderId } = await seedJobs();
    const { token } = await registerVerifiedPlayer({ app, redis }, { username: "Applicant" });
    const headers = { authorization: `Bearer ${token}` };

    const before = await app.inject({ method: "GET", url: "/api/jobs/board", headers });
    expect(before.statusCode).toBe(200);
    const beforeBody = before.json() as {
      rows: { id: string; jobId: string; jobName: string; rankName: string; pay: string }[];
      values: Record<string, string>;
    };
    expect(beforeBody.rows.length).toBeGreaterThanOrEqual(4);
    expect(beforeBody.rows.some((r) => r.id === loaderId && r.jobId === dockJobId && r.rankName === "Loader")).toBe(true);
    expect(beforeBody.values).toEqual({});

    const interview = await app.inject({
      method: "POST", url: "/api/jobs/interview", headers, payload: { jobId: dockJobId },
    });
    expect(interview.statusCode).toBe(200);

    const after = await app.inject({ method: "GET", url: "/api/jobs/board", headers });
    expect(after.statusCode).toBe(200);
    const afterBody = after.json() as { values: Record<string, string> };
    expect(afterBody.values.jobName).toBe("Dock Worker");
    expect(afterBody.values.rankName).toBe("Loader");
    expect(afterBody.values.pay).toBe("100");
  });

  it("declares its page in /api/plugins", async () => {
    const res = await app.inject({ method: "GET", url: "/api/plugins", headers: auth() });
    const pages = (res.json() as { pages: { pluginId: string; id: string }[] }).pages;
    expect(pages.some((p) => p.pluginId === "jobs" && p.id === "jobs.index")).toBe(true);
  });
});

describe("jobs list route (the interview form's job-keyed options)", () => {
  it("lists jobs by id, not by rank id", async () => {
    const { dockJobId, shopJobId } = await seedJobs();
    const { token } = await registerVerifiedPlayer({ app, redis }, { username: "Browser" });
    const headers = { authorization: `Bearer ${token}` };

    const res = await app.inject({ method: "GET", url: "/api/jobs/list", headers });
    expect(res.statusCode).toBe(200);
    const rows = (res.json() as { rows: { id: string; name: string }[] }).rows;
    expect(rows).toContainEqual({ id: dockJobId, name: "Dock Worker" });
    expect(rows).toContainEqual({ id: shopJobId, name: "Copy Shop" });
  });
});

describe("jobs HUD signal", () => {
  it("carries the wages entry only once a full day is unclaimed, and never settles on the HUD path", async () => {
    const { dockJobId } = await seedJobs();
    const { token, playerId } = await registerVerifiedPlayer({ app, redis }, { username: "Worker" });
    const headers = { authorization: `Bearer ${token}` };

    await app.inject({ method: "POST", url: "/api/jobs/interview", headers, payload: { jobId: dockJobId } });

    const fresh = await app.inject({ method: "GET", url: "/api/hud/extras", headers });
    expect(fresh.statusCode).toBe(200);
    const freshHud = HudExtrasResponseSchema.parse(fresh.json());
    expect(freshHud.entries.some((e) => e.pluginId === "jobs")).toBe(false);

    const backdated = new Date(Date.now() - 25 * 3_600_000);
    await db.update(playerJobs).set({ lastWageAt: backdated }).where(eq(playerJobs.playerId, playerId));

    const res = await app.inject({ method: "GET", url: "/api/hud/extras", headers });
    expect(res.statusCode).toBe(200);
    const hud = HudExtrasResponseSchema.parse(res.json());
    const entry = hud.entries.find((e) => e.pluginId === "jobs");
    expect(entry?.label).toBe("Wages");
    expect(entry?.value).toContain("1 day");

    // The HUD path is a plain read: the stamp it just reported off of is unchanged.
    const [row] = await db.select().from(playerJobs).where(eq(playerJobs.playerId, playerId));
    expect(row?.lastWageAt.getTime()).toBe(backdated.getTime());
  });
});

describe("jobs admin", () => {
  it("403s a non-admin on every one of the eight routes", async () => {
    const pleb = await registerVerifiedPlayer({ app, redis }, { username: "Pleb3" });
    const headers = { authorization: `Bearer ${pleb.token}` };
    const routes: { method: "GET" | "POST" | "DELETE"; url: string }[] = [
      { method: "GET", url: "/api/admin/jobs/list" },
      { method: "POST", url: "/api/admin/jobs" },
      { method: "POST", url: "/api/admin/jobs/update" },
      { method: "DELETE", url: `/api/admin/jobs/${uuidv7()}` },
      { method: "GET", url: "/api/admin/jobs/ranks/list" },
      { method: "POST", url: "/api/admin/jobs/ranks" },
      { method: "POST", url: "/api/admin/jobs/ranks/update" },
      { method: "DELETE", url: `/api/admin/jobs/ranks/${uuidv7()}` },
    ];
    for (const { method, url } of routes) {
      const res = await app.inject({ method, url, headers, payload: method === "GET" || method === "DELETE" ? undefined : {} });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it("creates a job with a placeholder rank id and lists it as a TableRowsResponse", async () => {
    const placeholderRankId = uuidv7();
    const res = await app.inject({
      method: "POST", url: "/api/admin/jobs", headers: auth(),
      payload: { name: "Warehouse Crew", description: "Lift, carry, repeat.", firstRankId: placeholderRankId },
    });
    expect(res.statusCode).toBe(201);
    const { id } = res.json() as { id: string };

    const [row] = await db.select().from(jobCatalog).where(eq(jobCatalog.id, id));
    expect(row).toMatchObject({ name: "Warehouse Crew", firstRankId: placeholderRankId });

    const list = await app.inject({ method: "GET", url: "/api/admin/jobs/list", headers: auth() });
    expect(list.statusCode).toBe(200);
    expect(list.json().rows).toContainEqual({
      id, name: "Warehouse Crew", description: "Lift, carry, repeat.", firstRankId: placeholderRankId,
    });
  });

  it("updates a job with a blank name and keeps the old name, repointing firstRankId", async () => {
    const id = uuidv7();
    const oldRankId = uuidv7();
    const newRankId = uuidv7();
    await db.insert(jobCatalog).values({ id, name: "Warehouse Crew", description: "Lift, carry, repeat.", firstRankId: oldRankId });

    const res = await app.inject({
      method: "POST", url: "/api/admin/jobs/update", headers: auth(),
      payload: { id, name: "", description: "", firstRankId: newRankId },
    });
    expect(res.statusCode).toBe(204);

    const [row] = await db.select().from(jobCatalog).where(eq(jobCatalog.id, id));
    expect(row).toMatchObject({ name: "Warehouse Crew", description: "Lift, carry, repeat.", firstRankId: newRankId });
  });

  it("404s an update to an unknown job id", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/admin/jobs/update", headers: auth(),
      payload: { id: uuidv7(), name: "", description: "", firstRankId: uuidv7() },
    });
    expect(res.statusCode).toBe(404);
  });

  it("deletes a job", async () => {
    const id = uuidv7();
    await db.insert(jobCatalog).values({ id, name: "Doomed", description: "Not long for this world.", firstRankId: uuidv7() });
    const del = await app.inject({ method: "DELETE", url: `/api/admin/jobs/${id}`, headers: auth() });
    expect(del.statusCode).toBe(204);
    expect(await db.select().from(jobCatalog).where(eq(jobCatalog.id, id))).toEqual([]);
  });

  it("404s deleting an unknown job id", async () => {
    const res = await app.inject({ method: "DELETE", url: `/api/admin/jobs/${uuidv7()}`, headers: auth() });
    expect(res.statusCode).toBe(404);
  });

  it("creates a rank against a job and lists it joined with the job's name", async () => {
    const jobId = uuidv7();
    await db.insert(jobCatalog).values({ id: jobId, name: "Copy Shop", description: "Toner and patience.", firstRankId: uuidv7() });

    const res = await app.inject({
      method: "POST", url: "/api/admin/jobs/ranks", headers: auth(),
      payload: {
        jobId, name: "Clerk", pay: "80",
        strengthGain: 0, labourGain: 1, iqGain: 1,
        strengthReq: 0, labourReq: 0, iqReq: 0,
      },
    });
    expect(res.statusCode).toBe(201);
    const { id } = res.json() as { id: string };

    const [row] = await db.select().from(jobRanks).where(eq(jobRanks.id, id));
    expect(row).toMatchObject({ jobId, name: "Clerk", pay: 80n, labourGain: 1 });

    const list = await app.inject({ method: "GET", url: "/api/admin/jobs/ranks/list", headers: auth() });
    expect(list.statusCode).toBe(200);
    expect(list.json().rows).toContainEqual({
      id, jobId, jobName: "Copy Shop", rankLabel: "Copy Shop · Clerk", name: "Clerk", pay: "80",
      strengthGain: "0", labourGain: "1", iqGain: "1", strengthReq: "0", labourReq: "0", iqReq: "0",
    });
  });

  it("updates a rank with a blank name and keeps the old name", async () => {
    const jobId = uuidv7();
    const id = uuidv7();
    await db.insert(jobCatalog).values({ id: jobId, name: "Copy Shop", description: "Toner and patience.", firstRankId: id });
    await db.insert(jobRanks).values({
      id, jobId, name: "Clerk", pay: 80n, strengthGain: 0, labourGain: 1, iqGain: 1,
      strengthReq: 0, labourReq: 0, iqReq: 0,
    });

    const res = await app.inject({
      method: "POST", url: "/api/admin/jobs/ranks/update", headers: auth(),
      payload: {
        id, jobId, name: "", pay: "120",
        strengthGain: 0, labourGain: 2, iqGain: 1,
        strengthReq: 0, labourReq: 0, iqReq: 0,
      },
    });
    expect(res.statusCode).toBe(204);

    const [row] = await db.select().from(jobRanks).where(eq(jobRanks.id, id));
    expect(row).toMatchObject({ name: "Clerk", pay: 120n, labourGain: 2 });
  });

  it("404s an update to an unknown rank id", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/admin/jobs/ranks/update", headers: auth(),
      payload: {
        id: uuidv7(), jobId: uuidv7(), name: "", pay: "1",
        strengthGain: 0, labourGain: 0, iqGain: 0, strengthReq: 0, labourReq: 0, iqReq: 0,
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it("deletes a rank", async () => {
    const id = uuidv7();
    await db.insert(jobRanks).values({
      id, jobId: uuidv7(), name: "Doomed", pay: 1n, strengthGain: 0, labourGain: 0, iqGain: 0,
      strengthReq: 0, labourReq: 0, iqReq: 0,
    });
    const del = await app.inject({ method: "DELETE", url: `/api/admin/jobs/ranks/${id}`, headers: auth() });
    expect(del.statusCode).toBe(204);
    expect(await db.select().from(jobRanks).where(eq(jobRanks.id, id))).toEqual([]);
  });

  it("404s deleting an unknown rank id", async () => {
    const res = await app.inject({ method: "DELETE", url: `/api/admin/jobs/ranks/${uuidv7()}`, headers: auth() });
    expect(res.statusCode).toBe(404);
  });

  it("declares its section in /api/admin/plugins", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/plugins", headers: auth() });
    const sections = (res.json() as { sections: { pluginId: string; pages: { id: string }[] }[] }).sections;
    const jobsSection = sections.find((s) => s.pluginId === "jobs");
    expect(jobsSection?.pages.some((p) => p.id === "jobs-admin")).toBe(true);
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
    walk(jobsAdminPage.view);
    expect(idKeys.filter((k) => /^id$|Id$/.test(k))).toEqual([]);
    expect(valueKeys).toContain("id");
  });

  it("never renders id as a table column on the player page either", async () => {
    const { jobsPage } = await import("@gl3/plugin-jobs");
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
    walk(jobsPage.view);
    expect(idKeys.filter((k) => /^id$|Id$/.test(k))).toEqual([]);
  });
});
