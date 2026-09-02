import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import educationPlugin from "@gl3/plugin-education";
import mccodesAttributes from "@gl3/plugin-mccodes-attributes";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { loadConfig } from "../src/config.js";
import { playerStats } from "../src/db/schema/index.js";
import { createSubscriber } from "../src/redis.js";
import { testDb } from "./helpers/db.js";
import { awaitOwnPluginEvent } from "./helpers/events.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
const subscriber = createSubscriber(loadConfig(process.env).redisUrl);

afterAll(async () => { await conn.end(); });

describe("education plugin", () => {
  let server: Awaited<ReturnType<typeof bootTestServer>>;
  let courseId: string;

  beforeEach(async () => {
    if (!server) server = await bootTestServer({ plugins: [mccodesAttributes, educationPlugin] });
    // After boot: the plugin's migrations (p_education_courses) exist.
    courseId = crypto.randomUUID();
    await db.execute(sql`
      INSERT INTO p_education_courses (id, name, description, cost, days,
        strength_gain, agility_gain, guard_gain, labour_gain, iq_gain)
      VALUES (${courseId}, ${"Biology 101"}, ${"Learn things."}, ${100}, ${2},
        ${5}, ${0}, ${0}, ${0}, ${10})
    `);
  });
  beforeAll(async () => { await subscriber.subscribe(GAME_EVENTS_CHANNEL); });
  afterAll(async () => { subscriber.disconnect(); if (server) await server.close(); });

  it("declares the completed event silent and invalidating the HUD and me", () => {
    const decl = educationPlugin.events.find((e) => e.name === "completed");
    expect(decl).toBeDefined();
    expect(decl?.silent).toBe(true);
    expect(decl?.invalidates).toEqual(expect.arrayContaining(["hudExtras", "me"]));
  });

  it("starts a course: pays, enrolls, refuses a second concurrent course", async () => {
    const { token, playerId } = await registerVerifiedPlayer(server, { remoteAddress: "10.14.1.1" });
    const auth = { authorization: `Bearer ${token}` };
    await db.update(playerStats).set({ cash: 1000n }).where(eq(playerStats.playerId, playerId));

    const res = await server.app.inject({
      method: "POST", url: "/api/education/start", headers: auth, payload: { courseId },
    });
    expect(res.statusCode).toBe(200);

    const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(row?.cash).toBe(900n);
    const enrolled = (await db.execute(
      sql`SELECT course_id FROM p_education_progress WHERE player_id = ${playerId}`,
    )) as unknown as { course_id: string }[];
    expect(enrolled[0]?.course_id).toBe(courseId);

    const again = await server.app.inject({
      method: "POST", url: "/api/education/start", headers: auth, payload: { courseId },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("already_studying");
  });

  it("refuses a start the cash cannot cover", async () => {
    const { token } = await registerVerifiedPlayer(server, { remoteAddress: "10.14.1.2" });
    const res = await server.app.inject({
      method: "POST", url: "/api/education/start",
      headers: { authorization: `Bearer ${token}` },
      payload: { courseId },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("insufficient_funds");
  });

  it("completes an elapsed course on read, exactly once, and grants its stats", async () => {
    const { token, playerId } = await registerVerifiedPlayer(server, { remoteAddress: "10.14.1.3" });
    const auth = { authorization: `Bearer ${token}` };
    await db.update(playerStats).set({ cash: 1000n }).where(eq(playerStats.playerId, playerId));
    await server.app.inject({ method: "POST", url: "/api/education/start", headers: auth, payload: { courseId } });

    // Backdate past the 2-day duration: the next read is the tick.
    await db.execute(sql`
      UPDATE p_education_progress
      SET started_at = now() - interval '3 days'
      WHERE player_id = ${playerId}
    `);

    // The tick is a READ the plugin page fetches with no action behind it,
    // so only this event tells the HUD its "Course: ... left" line is gone.
    const completed = awaitOwnPluginEvent(subscriber, playerId, "education", "completed");
    const res = await server.app.inject({ method: "GET", url: "/api/education", headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.completedNow).toBe("Biology 101");
    const done = await completed;
    expect(done.audience).toEqual({ kind: "player", playerId });
    expect(done.payload).toEqual({ courseName: "Biology 101" });
    expect(body.active).toBeNull();
    expect(body.courses.find((c: { id: string }) => c.id === courseId).status).toBe("done");

    const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(row?.strength).toBe(5n);
    expect(row?.iq).toBe(10n);

    // Exactly once: a second read grants nothing and re-starting is refused.
    const second = await server.app.inject({ method: "GET", url: "/api/education", headers: auth });
    expect(second.json().completedNow).toBeNull();
    const [after] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(after?.strength).toBe(5n);
    const restart = await server.app.inject({
      method: "POST", url: "/api/education/start", headers: auth, payload: { courseId },
    });
    expect(restart.statusCode).toBe(409);
    expect(restart.json().error).toBe("already_completed");
  });
});
