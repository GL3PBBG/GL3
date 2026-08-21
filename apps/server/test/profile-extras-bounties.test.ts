import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { playerStats } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
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

describe("bounties on the profile (core.profileView)", () => {
  it("shows an open-bounty stat and a place-bounty link when a bounty is open on the target", async () => {
    const { token: placerToken, playerId: placerId } = await registerVerifiedPlayer({ app, redis }, { username: "ProfileBountyPlacer" });
    const { playerId: targetId } = await registerVerifiedPlayer({ app, redis }, { username: "ProfileBountyTarget" });

    await db.update(playerStats).set({ cash: 10_000n }).where(eq(playerStats.playerId, placerId));

    const place = await app.inject({
      method: "POST",
      url: "/api/bounties",
      headers: { authorization: `Bearer ${placerToken}` },
      payload: { targetUsername: "ProfileBountyTarget", amount: "5000" },
    });
    expect(place.statusCode).toBe(201);

    const profileRes = await app.inject({ method: "GET", url: `/api/players/${targetId}/profile` });
    expect(profileRes.statusCode).toBe(200);
    const extras = profileRes.json().extras;

    expect(extras).toEqual(
      expect.arrayContaining([
        { kind: "stat", pluginId: "bounties", label: "Open bounty", value: "$5000" },
        { kind: "link", pluginId: "bounties", label: "Place bounty", to: `/bounties?target=${targetId}` },
      ]),
    );
  });

  it("shows only the place-bounty link, no stat, for a player with no open bounty", async () => {
    const { playerId } = await registerVerifiedPlayer({ app, redis }, { username: "ProfileBountyFree" });

    const profileRes = await app.inject({ method: "GET", url: `/api/players/${playerId}/profile` });
    expect(profileRes.statusCode).toBe(200);
    const extras = profileRes.json().extras;

    expect(extras).toContainEqual(
      { kind: "link", pluginId: "bounties", label: "Place bounty", to: `/bounties?target=${playerId}` },
    );
    expect(extras.some((e: { pluginId: string; kind: string }) => e.pluginId === "bounties" && e.kind === "stat")).toBe(false);
  });
});
