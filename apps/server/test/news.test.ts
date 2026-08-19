import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { loadConfig } from "../src/config.js";
import { players, roleModuleAccess, roles } from "../src/db/schema/index.js";
import { createSubscriber } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { awaitOwnEvent } from "./helpers/events.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
const subscriber = createSubscriber(loadConfig(process.env).redisUrl);
let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;
let staffToken: string;
let staffId: string;
let regularToken: string;

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer, redis } = await bootTestServer());

  const staffRoleId = uuidv7();
  await db.insert(roles).values({ id: staffRoleId, name: "Staff" });
  await db.insert(roleModuleAccess).values({ roleId: staffRoleId, moduleKey: "news" });

  const staff = await registerVerifiedPlayer({ app, redis }, { username: "Editor" });
  staffToken = staff.token;
  staffId = staff.playerId;
  await db.update(players).set({ roleId: staffRoleId }).where(eq(players.id, staffId));

  const regular = await registerVerifiedPlayer({ app, redis }, { username: "Vito" });
  regularToken = regular.token;
});

afterAll(async () => { await closeServer(); await conn.end(); subscriber.disconnect(); });

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

  // Regression guard for a review finding: the only prior "denied" fixture
  // was a player with *no role at all*, which the loader's admin gate
  // rejects at the "player has no grants" check. A role that holds a
  // *different*, real module grant exercises the module-key comparison
  // (grant must be "news" or "*"), not just a has-any-row-at-all check.
  it("403s a player whose role grants a different module, not news", async () => {
    const mailRoleId = uuidv7();
    await db.insert(roles).values({ id: mailRoleId, name: "Mail Moderator" });
    await db.insert(roleModuleAccess).values({ roleId: mailRoleId, moduleKey: "mail" });
    const moderator = await registerVerifiedPlayer({ app, redis }, { username: "Tessio" });
    await db.update(players).set({ roleId: mailRoleId }).where(eq(players.id, moderator.playerId));

    const res = await app.inject({
      method: "POST", url: "/api/news", headers: { authorization: `Bearer ${moderator.token}` },
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

  // Postgres `text` columns reject an embedded NUL byte outright (SQLSTATE
  // 22021); z.string() alone doesn't, so an otherwise-legal post 500ed
  // before noNulByte guarded title/body.
  it("400s a NUL byte in title instead of 500ing", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/news", headers: { authorization: `Bearer ${staffToken}` },
      payload: { title: `Round 2${String.fromCharCode(0)}begins`, body: "Good luck out there." },
    });
    expect(res.statusCode).toBe(400);
  });

  it("400s a NUL byte in body instead of 500ing", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/news", headers: { authorization: `Bearer ${staffToken}` },
      payload: { title: "Round 2 begins", body: `Good luck${String.fromCharCode(0)}out there.` },
    });
    expect(res.statusCode).toBe(400);
  });

  // A role's wildcard module key ("*") is the admin grant that satisfies
  // any module check, not just an exact "news" match. The loader gate
  // checks `hasPermission(grants, "news")` which accepts "news" or "*".
  it("lets a wildcard-module role post", async () => {
    const adminRoleId = uuidv7();
    await db.insert(roles).values({ id: adminRoleId, name: "Admin" });
    await db.insert(roleModuleAccess).values({ roleId: adminRoleId, moduleKey: "*" });
    const admin = await registerVerifiedPlayer({ app, redis }, { username: "Genco" });
    await db.update(players).set({ roleId: adminRoleId }).where(eq(players.id, admin.playerId));

    const res = await app.inject({
      method: "POST", url: "/api/news", headers: { authorization: `Bearer ${admin.token}` },
      payload: { title: "From the admins", body: "..." },
    });
    expect(res.statusCode).toBe(201);
  });

  // Regression guard for a review finding: nothing previously asserted that
  // news.posted is ever published — if the publishEvent call were deleted,
  // or its type/audience were wrong, every other test in this file would
  // still pass. news.posted has audience {kind:"global"}, and game:events is
  // a single channel shared by every concurrently-running test file
  // (NOTES.md rule 4), so this filters on the author's own actorId via
  // awaitOwnEvent rather than trusting the first frame on the channel —
  // events.ts:52 documents "actor = the author" for news.posted.
  it("publishes news.posted globally with the author as actor", async () => {
    await subscriber.subscribe(GAME_EVENTS_CHANNEL);
    const received = awaitOwnEvent(subscriber, staffId);

    const res = await app.inject({
      method: "POST", url: "/api/news", headers: { authorization: `Bearer ${staffToken}` },
      payload: { title: "Round 2 begins", body: "Good luck out there." },
    });
    expect(res.statusCode).toBe(201);

    const event = await received;
    expect(event.type).toBe("news.posted");
    expect(event.actorId).toBe(staffId);
    expect(event.audience).toEqual({ kind: "global" });
    if (event.type !== "news.posted") throw new Error("unreachable");
    expect(event.newsId).toBe(res.json().id);
    expect(event.title).toBe("Round 2 begins");
  });
});

describe("GET /api/news", () => {
  it("is public and requires no authentication", async () => {
    const res = await app.inject({ method: "GET", url: "/api/news" });
    expect(res.statusCode).toBe(200);
    expect(res.json().news).toEqual([]);
  });
});

describe("GET /api/admin/news", () => {
  it("returns recent rows for the staff (news-grant) role", async () => {
    // Post two items as staff
    await app.inject({
      method: "POST", url: "/api/news", headers: { authorization: `Bearer ${staffToken}` },
      payload: { title: "First", body: "Body 1" },
    });
    await app.inject({
      method: "POST", url: "/api/news", headers: { authorization: `Bearer ${staffToken}` },
      payload: { title: "Second", body: "Body 2" },
    });

    const res = await app.inject({
      method: "GET", url: "/api/admin/news",
      headers: { authorization: `Bearer ${staffToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().rows).toHaveLength(2);
    expect(res.json().rows[0].title).toBe("Second");
    expect(res.json().rows[0].id).toBeDefined();
    expect(res.json().rows[0].createdAt).toBeDefined();
  });

  it("403s a regular player", async () => {
    const res = await app.inject({
      method: "GET", url: "/api/admin/news",
      headers: { authorization: `Bearer ${regularToken}` },
    });
    expect(res.statusCode).toBe(403);
  });
});
