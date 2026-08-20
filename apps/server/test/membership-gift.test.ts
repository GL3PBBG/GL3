import membershipPlugin from "@gl3/plugin-membership";
import type { FastifyInstance } from "fastify";
import type { Redis as IORedis } from "ioredis";
import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { loadConfig } from "../src/config.js";
import { createSubscriber } from "../src/redis.js";
import { testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";
import { runPluginMigrations } from "../src/plugins/migrate.js";

const { db } = testDb();
const subscriber = createSubscriber(loadConfig(process.env).redisUrl);

async function notificationCount(playerId: string): Promise<number> {
  const rows = await db.execute(sql`
    SELECT count(*)::int AS count FROM notifications WHERE player_id = ${playerId}`);
  return Number(rows[0]?.count ?? 0);
}

async function latestNotification(playerId: string): Promise<string | null> {
  const rows = await db.execute(sql`
    SELECT body FROM notifications WHERE player_id = ${playerId}
    ORDER BY created_at DESC LIMIT 1`);
  const row = rows[0] as { body: string } | undefined;
  return row?.body ?? null;
}

describe("membership gift route", () => {
  let app: FastifyInstance;
  let redis: IORedis;
  let closeServer: () => Promise<void>;

  beforeAll(async () => {
    await runPluginMigrations(db, [membershipPlugin]);
    ({ app, close: closeServer, redis } = await bootTestServer());
  });

  afterAll(async () => {
    await closeServer?.();
    subscriber.disconnect();
  });

  async function register(): Promise<{ id: string; token: string; username: string }> {
    const body = await registerVerifiedPlayer({ app, redis });
    return { id: body.playerId, token: body.token, username: body.username };
  }

  async function seedPackage(costPoints: number, durationSeconds: number, name = "Gold"): Promise<string> {
    const id = uuidv7();
    await db.execute(sql`
      INSERT INTO p_membership_packages (id, name, cost_points, duration_seconds)
      VALUES (${id}, ${name}, ${costPoints}, ${durationSeconds})`);
    return id;
  }

  async function seedPoints(playerId: string, points: number): Promise<void> {
    await db.execute(sql`UPDATE player_stats SET points = ${points} WHERE player_id = ${playerId}`);
  }

  async function pointsOf(playerId: string): Promise<number> {
    const rows = await db.execute(sql`SELECT points FROM player_stats WHERE player_id = ${playerId}`);
    return Number(rows[0]?.points ?? 0);
  }

  async function membershipExpiry(playerId: string): Promise<Date | null> {
    const rows = await db.execute(sql`
      SELECT expires_at FROM player_timers WHERE player_id = ${playerId} AND key = 'membership'`);
    const row = rows[0] as { expires_at: string } | undefined;
    return row === undefined ? null : new Date(row.expires_at);
  }

  it("gifts a package: buyer debited, recipient's timer set, buyer's unset, recipient notified", async () => {
    const packageId = await seedPackage(300, 7200, "Bronze");
    const buyer = await register();
    const recipient = await register();
    await seedPoints(buyer.id, 1000);

    const res = await app.inject({
      method: "POST",
      url: "/api/membership/gift",
      headers: { authorization: `Bearer ${buyer.token}` },
      payload: { packageId, recipientName: recipient.username },
    });
    expect(res.statusCode).toBe(200);

    expect(await pointsOf(buyer.id)).toBe(700);
    const recipientExpiry = await membershipExpiry(recipient.id);
    expect(recipientExpiry).not.toBeNull();
    const expectedMs = Date.now() + 7200 * 1000;
    expect(Math.abs((recipientExpiry as Date).getTime() - expectedMs)).toBeLessThan(10_000);

    expect(await membershipExpiry(buyer.id)).toBeNull();

    expect(await notificationCount(recipient.id)).toBe(1);
    const message = await latestNotification(recipient.id);
    expect(message).toContain(buyer.username);
  });

  it("publishes membership.gifted to both the buyer's and the recipient's audience", async () => {
    const packageId = await seedPackage(300, 7200, "Bronze");
    const buyer = await register();
    const recipient = await register();
    await seedPoints(buyer.id, 1000);
    await subscriber.subscribe(GAME_EVENTS_CHANNEL);

    // Rule 4: filter by the buyer's own actorId — both events are published
    // with actorId = buyer (the actor is who acted), so audience is what
    // distinguishes the buyer's copy from the recipient's.
    const events = await new Promise<{ audience: unknown }[]>((resolve, reject) => {
      const collected: { audience: unknown }[] = [];
      const onMessage = (channel: string, raw: string): void => {
        if (channel !== GAME_EVENTS_CHANNEL) return;
        const frame: Record<string, unknown> = JSON.parse(raw);
        if (frame.actorId !== buyer.id) return;
        if (frame.type !== "plugin.event" || frame.pluginId !== "membership" || frame.name !== "gifted") return;
        collected.push({ audience: frame.audience });
        if (collected.length === 2) {
          clearTimeout(timer);
          subscriber.off("message", onMessage);
          resolve(collected);
        }
      };
      const timer = setTimeout(() => {
        subscriber.off("message", onMessage);
        reject(new Error(`expected 2 membership.gifted events, saw ${collected.length}`));
      }, 5000);
      subscriber.on("message", onMessage);
      void app.inject({
        method: "POST",
        url: "/api/membership/gift",
        headers: { authorization: `Bearer ${buyer.token}` },
        payload: { packageId, recipientName: recipient.username },
      });
    });

    const audiences = events.map((e) => e.audience);
    expect(audiences).toContainEqual({ kind: "player", playerId: buyer.id });
    expect(audiences).toContainEqual({ kind: "player", playerId: recipient.id });
  });

  it("gifting to your own username -> 400 cannot_gift_self, points unchanged", async () => {
    const packageId = await seedPackage(300, 7200, "Bronze");
    const buyer = await register();
    await seedPoints(buyer.id, 1000);

    const res = await app.inject({
      method: "POST",
      url: "/api/membership/gift",
      headers: { authorization: `Bearer ${buyer.token}` },
      payload: { packageId, recipientName: buyer.username },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "cannot_gift_self" });
    expect(await pointsOf(buyer.id)).toBe(1000);
  });

  it("unknown recipientName -> 404 player_not_found", async () => {
    const packageId = await seedPackage(300, 7200, "Bronze");
    const buyer = await register();
    await seedPoints(buyer.id, 1000);

    const res = await app.inject({
      method: "POST",
      url: "/api/membership/gift",
      headers: { authorization: `Bearer ${buyer.token}` },
      payload: { packageId, recipientName: "no-such-player-anywhere" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "player_not_found" });
  });

  it("insufficient points -> 409 insufficient_points, recipient timer unset", async () => {
    const packageId = await seedPackage(10_000, 3600, "Platinum");
    const buyer = await register();
    const recipient = await register();
    await seedPoints(buyer.id, 5);

    const res = await app.inject({
      method: "POST",
      url: "/api/membership/gift",
      headers: { authorization: `Bearer ${buyer.token}` },
      payload: { packageId, recipientName: recipient.username },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "insufficient_points" });
    expect(await pointsOf(buyer.id)).toBe(5);
    expect(await membershipExpiry(recipient.id)).toBeNull();
  });
});
