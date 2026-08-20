import { uuidv7 } from "uuidv7";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetDb, testDb } from "./helpers/db.js";
import { detectiveSearches } from "./helpers/plugin-tables.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, redis, close: closeServer } = await bootTestServer());
});

afterAll(async () => {
  await closeServer();
  await conn.end();
});

describe("detectives on the profile (core.profileView) and menu badges (core.menuBadges)", () => {
  it("contributes a hire-detective link to any player's profile", async () => {
    const { playerId } = await registerVerifiedPlayer({ app, redis }, { username: "ProfileDetTarget" });

    const profileRes = await app.inject({ method: "GET", url: `/api/players/${playerId}/profile` });
    expect(profileRes.statusCode).toBe(200);
    const extras = profileRes.json().extras;

    expect(extras).toContainEqual(
      { kind: "link", pluginId: "detectives", label: "Hire detective", to: `/detectives?target=${playerId}` },
    );
  });

  it("shows a ready-report nav badge when the caller has a search whose ends_at is past", async () => {
    const { token, playerId } = await registerVerifiedPlayer({ app, redis }, { username: "DetBadgeReady" });
    const { playerId: targetId } = await registerVerifiedPlayer({ app, redis }, { username: "DetBadgeTarget" });

    await db.insert(detectiveSearches).values({
      id: uuidv7(),
      playerId,
      targetPlayerId: targetId,
      detectives: 1,
      endsAt: new Date(Date.now() - 60_000),
    });

    const badgesRes = await app.inject({
      method: "GET", url: "/api/menu/badges", headers: { authorization: `Bearer ${token}` },
    });
    expect(badgesRes.statusCode).toBe(200);
    expect(badgesRes.json().badges).toContainEqual({ path: "/detectives", count: 1 });
  });

  it("shows no detectives badge for a player with no ready search", async () => {
    const { token } = await registerVerifiedPlayer({ app, redis }, { username: "DetBadgeNone" });

    const badgesRes = await app.inject({
      method: "GET", url: "/api/menu/badges", headers: { authorization: `Bearer ${token}` },
    });
    expect(badgesRes.statusCode).toBe(200);
    expect(badgesRes.json().badges.some((b: { path: string }) => b.path === "/detectives")).toBe(false);
  });
});
