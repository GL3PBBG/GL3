import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { players, roleModuleAccess, roles } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let closeServer: () => Promise<void>;
let staffToken: string;
let regularToken: string;

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer } = await bootTestServer());

  const staffRoleId = uuidv7();
  await db.insert(roles).values({ id: staffRoleId, name: "Staff" });
  await db.insert(roleModuleAccess).values({ roleId: staffRoleId, moduleKey: "news" });

  const staff = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "Editor", password: "hunter2hunter2" } });
  staffToken = staff.json().token;
  await db.update(players).set({ roleId: staffRoleId }).where(eq(players.id, staff.json().playerId));

  const regular = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "Vito", password: "hunter2hunter2" } });
  regularToken = regular.json().token;
});

afterAll(async () => { await closeServer(); await conn.end(); });

describe("POST /api/news", () => {
  it("lets a player with news module access post, and lists it publicly after", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/news", headers: { authorization: `Bearer ${staffToken}` },
      payload: { title: "Round 2 begins", body: "Good luck out there." },
    });
    expect(res.statusCode).toBe(201);

    const list = await app.inject({ method: "GET", url: "/api/news" });
    expect(list.statusCode).toBe(200);
    expect(list.json().news).toHaveLength(1);
    expect(list.json().news[0].title).toBe("Round 2 begins");
    expect(list.json().news[0].authorName).toBe("Editor");
  });

  it("403s a player with no module access", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/news", headers: { authorization: `Bearer ${regularToken}` },
      payload: { title: "Spam", body: "..." },
    });
    expect(res.statusCode).toBe(403);
  });

  it("401s an unauthenticated post", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/news",
      payload: { title: "Spam", body: "..." },
    });
    expect(res.statusCode).toBe(401);
  });

  it("400s an invalid body", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/news", headers: { authorization: `Bearer ${staffToken}` },
      payload: { title: "", body: "..." },
    });
    expect(res.statusCode).toBe(400);
  });

  // A role's wildcard module key ("*") is the V2-preserved admin grant
  // (roleAccess RA_module='*') — it must satisfy any module, not just an
  // exact "news" match.
  it("lets a wildcard-module role post", async () => {
    const adminRoleId = uuidv7();
    await db.insert(roles).values({ id: adminRoleId, name: "Admin" });
    await db.insert(roleModuleAccess).values({ roleId: adminRoleId, moduleKey: "*" });
    const admin = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "Genco", password: "hunter2hunter2" } });
    await db.update(players).set({ roleId: adminRoleId }).where(eq(players.id, admin.json().playerId));

    const res = await app.inject({
      method: "POST", url: "/api/news", headers: { authorization: `Bearer ${admin.json().token}` },
      payload: { title: "From the admins", body: "..." },
    });
    expect(res.statusCode).toBe(201);
  });
});

describe("GET /api/news", () => {
  it("is public and requires no authentication", async () => {
    const res = await app.inject({ method: "GET", url: "/api/news" });
    expect(res.statusCode).toBe(200);
    expect(res.json().news).toEqual([]);
  });
});
