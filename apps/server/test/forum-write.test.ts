import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { loadConfig } from "../src/config.js";
import { notifications } from "../src/db/schema/index.js";
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

const post = (url: string, token: string, payload: unknown) =>
  app.inject({
    method: "POST",
    url,
    headers: { authorization: `Bearer ${token}` },
    payload,
  });

async function seedForum(name = "General"): Promise<string> {
  const id = uuidv7();
  await db.insert(forumForums).values({ id, name, sort: 0 });
  return id;
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

describe("POST /api/forum/:forumId/topics", () => {
  it("creates a topic with its opening post atomically", async () => {
    const forumId = await seedForum();
    const { token } = await registerVerifiedPlayer({ app, redis });

    const res = await post(`/api/forum/${forumId}/topics`, token, {
      subject: "A brand new topic",
      body: "The opening post body, long enough to pass.",
    });
    expect(res.statusCode).toBe(201);
    const { topicId } = res.json();
    expect(typeof topicId).toBe("string");

    const [topic] = await db.select().from(forumTopics).where(eq(forumTopics.id, topicId));
    expect(topic).toBeTruthy();
    expect(topic.forumId).toBe(forumId);
    expect(topic.postCount).toBe(1);
    expect(topic.lastPostAt.getTime()).toBe(topic.createdAt.getTime());

    const openingPosts = await db.select().from(forumPosts).where(eq(forumPosts.topicId, topicId));
    expect(openingPosts).toHaveLength(1);
    expect(openingPosts[0].body).toBe("The opening post body, long enough to pass.");
  });

  it("404s an unknown forum id", async () => {
    const { token } = await registerVerifiedPlayer({ app, redis });
    const res = await post(`/api/forum/${uuidv7()}/topics`, token, {
      subject: "A brand new topic",
      body: "The opening post body, long enough to pass.",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("forum_not_found");
  });

  it("400s a too-short subject or body", async () => {
    const forumId = await seedForum();
    const { token } = await registerVerifiedPlayer({ app, redis });
    const res = await post(`/api/forum/${forumId}/topics`, token, { subject: "hi", body: "hi" });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/forum/topics/:topicId/posts", () => {
  it("reply bumps last_post_at and post_count, notifies the author once", async () => {
    const forumId = await seedForum();
    const { token: tokenA, playerId: playerIdA } = await registerVerifiedPlayer({ app, redis });
    const { token: tokenB } = await registerVerifiedPlayer({ app, redis });

    const createRes = await post(`/api/forum/${forumId}/topics`, tokenA, {
      subject: "A brand new topic",
      body: "The opening post body, long enough to pass.",
    });
    const { topicId } = createRes.json();
    const [before] = await db.select().from(forumTopics).where(eq(forumTopics.id, topicId));

    // Reply from B (not the author) — should notify A.
    const replyRes = await post(`/api/forum/topics/${topicId}/posts`, tokenB, {
      body: "A reply body, long enough to pass validation.",
    });
    expect(replyRes.statusCode).toBe(201);
    const { postId } = replyRes.json();
    expect(typeof postId).toBe("string");

    const [after] = await db.select().from(forumTopics).where(eq(forumTopics.id, topicId));
    expect(after.postCount).toBe(before.postCount + 1);
    expect(after.lastPostAt.getTime()).toBeGreaterThan(before.lastPostAt.getTime());

    const notesForA = await db.select().from(notifications).where(eq(notifications.playerId, playerIdA));
    expect(notesForA).toHaveLength(1);

    // Reply from A (the author, self-reply) — no new notification for A.
    const selfReply = await post(`/api/forum/topics/${topicId}/posts`, tokenA, {
      body: "A self reply body, long enough to pass.",
    });
    expect(selfReply.statusCode).toBe(201);

    const notesForAAfterSelf = await db
      .select()
      .from(notifications)
      .where(eq(notifications.playerId, playerIdA));
    expect(notesForAAfterSelf).toHaveLength(1);
  });

  it("404s an unknown topic id", async () => {
    const { token } = await registerVerifiedPlayer({ app, redis });
    const res = await post(`/api/forum/topics/${uuidv7()}/posts`, token, {
      body: "A reply body, long enough to pass validation.",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("topic_not_found");
  });

  it("locked topic refuses replies with 409", async () => {
    const forumId = await seedForum();
    const topicId = uuidv7();
    await db.insert(forumTopics).values({
      id: topicId,
      forumId,
      authorId: null,
      subject: "Locked thread",
      status: "locked",
    });
    const { token } = await registerVerifiedPlayer({ app, redis });

    const res = await post(`/api/forum/topics/${topicId}/posts`, token, {
      body: "A reply body, long enough to pass validation.",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("topic_locked");
  });
});

describe("cooldowns", () => {
  it("topic cooldown is 60s: a second topic within the window 429s with retryAfter", async () => {
    const forumId = await seedForum();
    const { token } = await registerVerifiedPlayer({ app, redis });

    const first = await post(`/api/forum/${forumId}/topics`, token, {
      subject: "First topic subject",
      body: "First topic opening body, long enough.",
    });
    expect(first.statusCode).toBe(201);

    const second = await post(`/api/forum/${forumId}/topics`, token, {
      subject: "Second topic subject",
      body: "Second topic opening body, long enough.",
    });
    expect(second.statusCode).toBe(429);
    const body = second.json();
    expect(body.error).toBe("on_cooldown");
    expect(body.retryAfter).toBeGreaterThan(0);
  });

  it("post cooldown is 15s: a second reply within the window 429s with retryAfter", async () => {
    const forumId = await seedForum();
    // Distinct players for topic creation vs replying, so the topic
    // cooldown claimed above doesn't mask the post cooldown under test.
    const { token: authorToken } = await registerVerifiedPlayer({ app, redis });
    const { token: replierToken } = await registerVerifiedPlayer({ app, redis });

    const createRes = await post(`/api/forum/${forumId}/topics`, authorToken, {
      subject: "Topic for replies",
      body: "Opening body, long enough to pass validation.",
    });
    const { topicId } = createRes.json();

    const first = await post(`/api/forum/topics/${topicId}/posts`, replierToken, {
      body: "First reply body, long enough to pass.",
    });
    expect(first.statusCode).toBe(201);

    const second = await post(`/api/forum/topics/${topicId}/posts`, replierToken, {
      body: "Second reply body, long enough to pass.",
    });
    expect(second.statusCode).toBe(429);
    const body = second.json();
    expect(body.error).toBe("on_cooldown");
    expect(body.retryAfter).toBeGreaterThan(0);
  });
});
