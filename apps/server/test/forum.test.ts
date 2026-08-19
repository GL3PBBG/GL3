import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { loadConfig } from "../src/config.js";
import { createRedis } from "../src/redis.js";
import { forumForums, forumPosts, forumTopics } from "./helpers/plugin-tables.js";
import { resetDb, testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
const redisUrl = loadConfig(process.env).redisUrl;
const redis = createRedis(redisUrl);
let app: FastifyInstance;
let closeServer: () => Promise<void>;
let token: string;
let playerId: string;

const get = (url: string) =>
  app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });

async function seedForum(name = "General"): Promise<string> {
  const id = uuidv7();
  await db.insert(forumForums).values({ id, name, sort: 0 });
  return id;
}

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer } = await bootTestServer());
  ({ token, playerId } = await registerVerifiedPlayer({ app, redis }));
});

afterAll(async () => {
  await closeServer();
  await conn.end();
  redis.disconnect();
});

describe("GET /api/forum", () => {
  it("lists forums with topic counts", async () => {
    const forumId = await seedForum();
    await db.insert(forumTopics).values([
      { id: uuidv7(), forumId, authorId: playerId, subject: "First topic" },
      { id: uuidv7(), forumId, authorId: playerId, subject: "Second topic" },
    ]);

    const res = await get("/api/forum");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.forums).toHaveLength(1);
    expect(body.forums[0]).toMatchObject({ id: forumId, name: "General", topicCount: 2 });
  });

  it("reports zero for a forum with no topics", async () => {
    const forumId = await seedForum("Empty");
    const res = await get("/api/forum");
    expect(res.json().forums[0]).toMatchObject({ id: forumId, topicCount: 0 });
  });
});

describe("GET /api/forum/:forumId/topics", () => {
  it("paginates topics sticky-first, then most-recently-posted", async () => {
    const forumId = await seedForum();
    const now = Date.now();

    // 25 normal topics with strictly increasing last_post_at, so recency
    // order is deterministic. Oldest last_post_at is minute 0.
    const normalRows = Array.from({ length: 25 }, (_, i) => ({
      id: uuidv7(),
      forumId,
      authorId: playerId,
      subject: `Normal ${i}`,
      type: "normal" as const,
      lastPostAt: new Date(now + i * 60_000),
    }));
    await db.insert(forumTopics).values(normalRows);

    // Sticky topic has the OLDEST last_post_at of all 26 rows, yet must sort
    // first — sticky beats recency.
    const stickyId = uuidv7();
    await db.insert(forumTopics).values({
      id: stickyId,
      forumId,
      authorId: playerId,
      subject: "Sticky",
      type: "sticky",
      lastPostAt: new Date(now - 3_600_000),
    });

    const page1 = await get(`/api/forum/${forumId}/topics?page=1`);
    expect(page1.statusCode).toBe(200);
    const body1 = page1.json();
    expect(body1.forumId).toBe(forumId);
    expect(body1.forumName).toBe("General");
    expect(body1.page).toBe(1);
    expect(body1.pageCount).toBe(2);
    expect(body1.topics).toHaveLength(20);
    expect(body1.topics[0].id).toBe(stickyId);
    expect(body1.topics[0].authorName).toBeTruthy();
    // The rest of page 1 is the 19 most-recent normal topics, descending.
    expect(body1.topics[1].subject).toBe("Normal 24");

    const page2 = await get(`/api/forum/${forumId}/topics?page=2`);
    const body2 = page2.json();
    expect(body2.page).toBe(2);
    expect(body2.pageCount).toBe(2);
    expect(body2.topics).toHaveLength(6);
  });

  it("404s an unknown forum id and 400s a malformed one", async () => {
    const unknown = await get(`/api/forum/${randomUUID()}/topics`);
    expect(unknown.statusCode).toBe(404);

    const malformed = await get("/api/forum/not-a-uuid/topics");
    expect(malformed.statusCode).toBe(400);
  });
});

describe("GET /api/forum/topics/:topicId", () => {
  it("paginates posts ascending, oldest first", async () => {
    const forumId = await seedForum();
    const topicId = uuidv7();
    const now = Date.now();
    await db.insert(forumTopics).values({ id: topicId, forumId, authorId: playerId, subject: "Thread" });

    const postRows = Array.from({ length: 25 }, (_, i) => ({
      id: uuidv7(),
      topicId,
      authorId: playerId,
      body: `Post ${i}`,
      createdAt: new Date(now + i * 1000),
    }));
    await db.insert(forumPosts).values(postRows);

    const page1 = await get(`/api/forum/topics/${topicId}?page=1`);
    expect(page1.statusCode).toBe(200);
    const body1 = page1.json();
    expect(body1.topic).toMatchObject({ id: topicId, subject: "Thread" });
    expect(body1.page).toBe(1);
    expect(body1.pageCount).toBe(2);
    expect(body1.posts).toHaveLength(20);
    expect(body1.posts[0].body).toBe("Post 0");

    const page2 = await get(`/api/forum/topics/${topicId}?page=2`);
    const body2 = page2.json();
    expect(body2.posts).toHaveLength(5);
    expect(body2.posts[0].body).toBe("Post 20");
  });

  it("404s an unknown topic id and 400s a malformed one", async () => {
    const unknown = await get(`/api/forum/topics/${randomUUID()}`);
    expect(unknown.statusCode).toBe(404);

    const malformed = await get("/api/forum/topics/not-a-uuid");
    expect(malformed.statusCode).toBe(400);
  });
});
