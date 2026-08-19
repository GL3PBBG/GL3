import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { loadConfig } from "../src/config.js";
import { players, roleModuleAccess, roles } from "../src/db/schema/index.js";
import { createRedis } from "../src/redis.js";
import { forumForums, forumPosts, forumTopics } from "./helpers/plugin-tables.js";
import { resetDb, testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * Forum moderation (`lock`/`type`/post+topic delete) and admin CRUD
 * (`/api/admin/forum/forums`). Moderation routes live under `/api/forum`
 * and are player-facing paths gated IN-HANDLER by the ABAC `forum` module
 * grant — `admin-rounds.test.ts`'s `giveRole` fixture idiom is copied
 * verbatim below, since that file is the established pattern for granting a
 * module key to a fresh role. Admin CRUD routes are loader-tier gated via
 * `auth: "admin"` instead, same as every other plugin's `/api/admin/<id>`
 * section (`news`, `travel`).
 */

const { db, sql: conn } = testDb();
const redisUrl = loadConfig(process.env).redisUrl;
const redis = createRedis(redisUrl);
let app: FastifyInstance;
let closeServer: () => Promise<void>;

const auth = (token: string): { authorization: string } => ({ authorization: `Bearer ${token}` });

function post(url: string, token: string, payload?: unknown) {
  return app.inject({ method: "POST", url, headers: auth(token), payload });
}
function del(url: string, token: string) {
  return app.inject({ method: "DELETE", url, headers: auth(token) });
}
function get(url: string, token: string) {
  return app.inject({ method: "GET", url, headers: auth(token) });
}

async function seedForum(name = "General"): Promise<string> {
  const id = uuidv7();
  await db.insert(forumForums).values({ id, name, sort: 0 });
  return id;
}

async function seedTopic(forumId: string, authorId: string | null = null): Promise<string> {
  const id = uuidv7();
  await db.insert(forumTopics).values({
    id, forumId, authorId, subject: "A topic under moderation review",
  });
  await db.insert(forumPosts).values({
    id: uuidv7(), topicId: id, authorId, body: "Opening post body, long enough.",
  });
  return id;
}

/** Copied from `admin-rounds.test.ts`'s `giveRole` — the established fixture
 *  idiom for granting a module key to a fresh role and assigning a player to it. */
async function giveRole(playerId: string, moduleKey: string): Promise<void> {
  const roleId = uuidv7();
  await db.insert(roles).values({ id: roleId, name: `role-${moduleKey}-${roleId.slice(-6)}` });
  await db.insert(roleModuleAccess).values({ roleId, moduleKey });
  await db.update(players).set({ roleId }).where(eq(players.id, playerId));
}

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer } = await bootTestServer());
});

afterAll(async () => {
  await closeServer();
  await conn.end();
  redis.disconnect();
});

describe("forum moderation: authorization", () => {
  it("403s POST .../lock for a plain player with no grant", async () => {
    await registerVerifiedPlayer({ app, redis }); // sacrificial — soaks up the auto-admin slot
    const forumId = await seedForum();
    const topicId = await seedTopic(forumId);
    const { token } = await registerVerifiedPlayer({ app, redis });
    const res = await post(`/api/forum/topics/${topicId}/lock`, token, { locked: true });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "forbidden" });
  });

  it("403s POST .../type for a plain player with no grant", async () => {
    await registerVerifiedPlayer({ app, redis });
    const forumId = await seedForum();
    const topicId = await seedTopic(forumId);
    const { token } = await registerVerifiedPlayer({ app, redis });
    const res = await post(`/api/forum/topics/${topicId}/type`, token, { type: "sticky" });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "forbidden" });
  });

  it("403s DELETE post for a plain player with no grant", async () => {
    await registerVerifiedPlayer({ app, redis });
    const forumId = await seedForum();
    const topicId = await seedTopic(forumId);
    const [openingPost] = await db.select().from(forumPosts).where(eq(forumPosts.topicId, topicId));
    const { token } = await registerVerifiedPlayer({ app, redis });
    const res = await del(`/api/forum/posts/${openingPost.id}`, token);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "forbidden" });
  });

  it("403s DELETE topic for a plain player with no grant", async () => {
    await registerVerifiedPlayer({ app, redis });
    const forumId = await seedForum();
    const topicId = await seedTopic(forumId);
    const { token } = await registerVerifiedPlayer({ app, redis });
    const res = await del(`/api/forum/topics/${topicId}`, token);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "forbidden" });
  });

  it("401s with no token", async () => {
    const forumId = await seedForum();
    const topicId = await seedTopic(forumId);
    const res = await app.inject({ method: "POST", url: `/api/forum/topics/${topicId}/lock`, payload: { locked: true } });
    expect(res.statusCode).toBe(401);
  });
});

describe("forum moderation: granted player", () => {
  it("locks and unlocks a topic", async () => {
    const forumId = await seedForum();
    const topicId = await seedTopic(forumId);
    const { token, playerId } = await registerVerifiedPlayer({ app, redis });
    await giveRole(playerId, "forum");

    const lock = await post(`/api/forum/topics/${topicId}/lock`, token, { locked: true });
    expect(lock.statusCode, lock.body).toBe(204);
    const [locked] = await db.select().from(forumTopics).where(eq(forumTopics.id, topicId));
    expect(locked.status).toBe("locked");

    const unlock = await post(`/api/forum/topics/${topicId}/lock`, token, { locked: false });
    expect(unlock.statusCode, unlock.body).toBe(204);
    const [reopened] = await db.select().from(forumTopics).where(eq(forumTopics.id, topicId));
    expect(reopened.status).toBe("open");
  });

  it("a locked topic actually refuses replies (proves lock has an effect, not just a flag)", async () => {
    const forumId = await seedForum();
    const topicId = await seedTopic(forumId);
    const { token, playerId } = await registerVerifiedPlayer({ app, redis });
    await giveRole(playerId, "forum");

    const lock = await post(`/api/forum/topics/${topicId}/lock`, token, { locked: true });
    expect(lock.statusCode).toBe(204);

    const { token: replierToken } = await registerVerifiedPlayer({ app, redis });
    const reply = await post(`/api/forum/topics/${topicId}/posts`, replierToken, {
      body: "Trying to reply to a locked topic, long enough.",
    });
    expect(reply.statusCode).toBe(409);
    expect(reply.json().error).toBe("topic_locked");
  });

  it("sets a topic sticky, then back to normal", async () => {
    const forumId = await seedForum();
    const topicId = await seedTopic(forumId);
    const { token, playerId } = await registerVerifiedPlayer({ app, redis });
    await giveRole(playerId, "forum");

    const sticky = await post(`/api/forum/topics/${topicId}/type`, token, { type: "sticky" });
    expect(sticky.statusCode, sticky.body).toBe(204);
    const [row] = await db.select().from(forumTopics).where(eq(forumTopics.id, topicId));
    expect(row.type).toBe("sticky");

    const normal = await post(`/api/forum/topics/${topicId}/type`, token, { type: "normal" });
    expect(normal.statusCode, normal.body).toBe(204);
    const [row2] = await db.select().from(forumTopics).where(eq(forumTopics.id, topicId));
    expect(row2.type).toBe("normal");
  });

  it("400s an invalid type value", async () => {
    const forumId = await seedForum();
    const topicId = await seedTopic(forumId);
    const { token, playerId } = await registerVerifiedPlayer({ app, redis });
    await giveRole(playerId, "forum");
    const res = await post(`/api/forum/topics/${topicId}/type`, token, { type: "pinned" });
    expect(res.statusCode).toBe(400);
  });

  it("deletes a single post and decrements the topic's post count", async () => {
    const forumId = await seedForum();
    const topicId = await seedTopic(forumId);
    const { token, playerId } = await registerVerifiedPlayer({ app, redis });
    await giveRole(playerId, "forum");

    const { token: authorToken } = await registerVerifiedPlayer({ app, redis });
    const reply = await post(`/api/forum/topics/${topicId}/posts`, authorToken, {
      body: "A reply that will be deleted, long enough.",
    });
    const { postId } = reply.json();
    const [before] = await db.select().from(forumTopics).where(eq(forumTopics.id, topicId));

    const res = await del(`/api/forum/posts/${postId}`, token);
    expect(res.statusCode, res.body).toBe(204);

    const remaining = await db.select().from(forumPosts).where(eq(forumPosts.id, postId));
    expect(remaining).toHaveLength(0);
    const [after] = await db.select().from(forumTopics).where(eq(forumTopics.id, topicId));
    expect(after.postCount).toBe(before.postCount - 1);
  });

  it("404s deleting an unknown post id", async () => {
    const { token, playerId } = await registerVerifiedPlayer({ app, redis });
    await giveRole(playerId, "forum");
    const res = await del(`/api/forum/posts/${uuidv7()}`, token);
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("post_not_found");
  });

  it("deletes a topic and cascades its posts (count 0)", async () => {
    const forumId = await seedForum();
    const topicId = await seedTopic(forumId);
    const { token, playerId } = await registerVerifiedPlayer({ app, redis });
    await giveRole(playerId, "forum");

    const before = await db.select().from(forumPosts).where(eq(forumPosts.topicId, topicId));
    expect(before.length).toBeGreaterThan(0);

    const res = await del(`/api/forum/topics/${topicId}`, token);
    expect(res.statusCode, res.body).toBe(204);

    const remainingTopics = await db.select().from(forumTopics).where(eq(forumTopics.id, topicId));
    expect(remainingTopics).toHaveLength(0);
    const remainingPosts = await db.select().from(forumPosts).where(eq(forumPosts.topicId, topicId));
    expect(remainingPosts).toHaveLength(0);
  });

  it("404s deleting an unknown topic id", async () => {
    const { token, playerId } = await registerVerifiedPlayer({ app, redis });
    await giveRole(playerId, "forum");
    const res = await del(`/api/forum/topics/${uuidv7()}`, token);
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("topic_not_found");
  });

  it("a role holding the * wildcard also passes", async () => {
    const forumId = await seedForum();
    const topicId = await seedTopic(forumId);
    const { token, playerId } = await registerVerifiedPlayer({ app, redis });
    await giveRole(playerId, "*");
    const res = await post(`/api/forum/topics/${topicId}/lock`, token, { locked: true });
    expect(res.statusCode).toBe(204);
  });
});

describe("admin forum: authorization (loader tier)", () => {
  it("403s a non-admin player on GET /api/admin/forum/forums", async () => {
    await registerVerifiedPlayer({ app, redis }); // sacrificial — soaks up the auto-admin slot
    const p = await registerVerifiedPlayer({ app, redis });
    const res = await get("/api/admin/forum/forums", p.token);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "forbidden" });
  });

  it("403s a non-admin player on POST /api/admin/forum/forums", async () => {
    await registerVerifiedPlayer({ app, redis });
    const p = await registerVerifiedPlayer({ app, redis });
    const res = await post("/api/admin/forum/forums", p.token, { name: "Off Topic", sort: 1 });
    expect(res.statusCode).toBe(403);
  });

  it("a plain `forum` ABAC grant (not admin) DOES pass the loader tier, because both check the same grant", async () => {
    // The moderation grant and the admin loader tier are deliberately
    // separate mechanisms: an in-handler ABAC grant on "forum" is not the
    // same thing as passing `auth: "admin"`'s own grant check — both happen
    // to check the same module key here, but the loader tier ALSO requires
    // `requireAuth` to have resolved a role at all, and a moderator role is
    // exactly the shape that should still be admitted (since its grant IS
    // "forum"). This asserts the two paths are wired to the SAME grant, not
    // that they are independent — see the 200 case in the next describe.
    await registerVerifiedPlayer({ app, redis });
    const p = await registerVerifiedPlayer({ app, redis });
    await giveRole(p.playerId, "forum");
    const res = await get("/api/admin/forum/forums", p.token);
    expect(res.statusCode).toBe(200);
  });

  it("first-registered admin player passes", async () => {
    const founder = await registerVerifiedPlayer({ app, redis });
    const res = await get("/api/admin/forum/forums", founder.token);
    expect(res.statusCode).toBe(200);
  });
});

describe("admin forum: CRUD", () => {
  it("creates a forum", async () => {
    const founder = await registerVerifiedPlayer({ app, redis });
    const res = await post("/api/admin/forum/forums", founder.token, { name: "Off Topic", sort: 5 });
    expect(res.statusCode, res.body).toBe(201);
    const { id } = res.json();
    const [row] = await db.select().from(forumForums).where(eq(forumForums.id, id));
    expect(row).toMatchObject({ name: "Off Topic", sort: 5 });
  });

  it("creates and updates a forum from form-shaped string values", async () => {
    // The adminPages renderer submits EVERY field as a string
    // (PageRenderer.tsx builds Record<string, string>), so `sort` arrives as
    // "5", not 5 — the schema must coerce, as travel's admin schema does.
    const founder = await registerVerifiedPlayer({ app, redis });
    const created = await post("/api/admin/forum/forums", founder.token, { name: "Form Made", sort: "5" });
    expect(created.statusCode, created.body).toBe(201);
    const { id } = created.json();
    const updated = await post("/api/admin/forum/forums/update", founder.token, { id, name: "Form Made", sort: "7" });
    expect(updated.statusCode, updated.body).toBe(204);
    const [row] = await db.select().from(forumForums).where(eq(forumForums.id, id));
    expect(row).toMatchObject({ sort: 7 });
  });

  it("lists forums via the table feed", async () => {
    const founder = await registerVerifiedPlayer({ app, redis });
    await seedForum("General");
    const res = await get("/api/admin/forum/forums", founder.token);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { rows: { id: string; name: string; sort: number }[] };
    expect(body.rows.some((r) => r.name === "General")).toBe(true);
  });

  it("renames and re-sorts an existing forum", async () => {
    const founder = await registerVerifiedPlayer({ app, redis });
    const forumId = await seedForum("Original");
    const res = await post("/api/admin/forum/forums/update", founder.token, { id: forumId, name: "Renamed", sort: 9 });
    expect(res.statusCode, res.body).toBe(204);
    const [row] = await db.select().from(forumForums).where(eq(forumForums.id, forumId));
    expect(row).toMatchObject({ name: "Renamed", sort: 9 });
  });

  it("404s renaming an unknown forum id", async () => {
    const founder = await registerVerifiedPlayer({ app, redis });
    const res = await post("/api/admin/forum/forums/update", founder.token, { id: uuidv7(), name: "Ghost", sort: 0 });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("forum_not_found");
  });
});
