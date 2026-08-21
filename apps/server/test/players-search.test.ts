import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { players, playerStats, ranks } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer, redis } = await bootTestServer());
});

afterAll(async () => { await closeServer(); await conn.end(); });

async function makePlayer(username: string, rankId?: string): Promise<string> {
  const id = uuidv7();
  await db.insert(players).values({ id, username });
  await db.insert(playerStats).values({ playerId: id, rankId: rankId ?? null });
  return id;
}

async function makeRank(name: string): Promise<string> {
  const id = uuidv7();
  await db.insert(ranks).values({ id, name, expRequired: 0n });
  return id;
}

const search = (token: string, q: string) => app.inject({
  method: "GET",
  url: `/api/players/search?q=${encodeURIComponent(q)}`,
  headers: { authorization: `Bearer ${token}` },
});

type Body = { players: { playerId: string; username: string; rankName: string | null }[] };

describe("GET /api/players/search", () => {
  it("refuses a term shorter than two characters", async () => {
    const { token } = await registerVerifiedPlayer({ app, redis });
    await makePlayer("Alberto");

    for (const q of ["", "a", "  b  "]) {
      const res = await search(token, q);
      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string }>().error).toBe("invalid_request");
    }
  });

  it("refuses a term longer than thirty characters", async () => {
    const { token } = await registerVerifiedPlayer({ app, redis });
    const res = await search(token, "x".repeat(31));
    expect(res.statusCode).toBe(400);
  });

  it("requires authentication", async () => {
    const res = await app.inject({ method: "GET", url: "/api/players/search?q=al" });
    expect(res.statusCode).toBe(401);
  });

  it("matches a case-insensitive substring and carries the rank name", async () => {
    const { token } = await registerVerifiedPlayer({ app, redis });
    const rankId = await makeRank("Thug");
    const alberto = await makePlayer("Alberto", rankId);
    const bertha = await makePlayer("BERTHA");
    const carlo = await makePlayer("Carlo");

    const res = await search(token, "bErT");
    expect(res.statusCode).toBe(200);
    const found = res.json<Body>().players;
    const ids = found.map((row) => row.playerId);

    expect(ids).toContain(alberto);
    expect(ids).toContain(bertha);
    expect(ids).not.toContain(carlo);

    expect(found.find((row) => row.playerId === alberto)?.rankName).toBe("Thug");
    // Left join — an unranked player is null, not an omitted row.
    expect(found.find((row) => row.playerId === bertha)?.rankName).toBeNull();
  });

  it("returns no location field, so an underground town cannot leak through search", async () => {
    const { token } = await registerVerifiedPlayer({ app, redis });
    await makePlayer("Ghostly");

    const res = await search(token, "ghost");
    const [row] = res.json<Body>().players;
    expect(row).toBeDefined();
    expect(Object.keys(row!).sort()).toEqual(["playerId", "rankName", "username"]);
  });

  it("treats a literal % as text rather than a wildcard", async () => {
    const { token } = await registerVerifiedPlayer({ app, redis });
    const plain = await makePlayer("Alberto");
    const percent = await makePlayer("Al%berto");

    // Unescaped, `%b` is "anything then a b" and would match Alberto too.
    const res = await search(token, "l%b");
    expect(res.statusCode).toBe(200);
    const ids = res.json<Body>().players.map((row) => row.playerId);
    expect(ids).toContain(percent);
    expect(ids).not.toContain(plain);
  });

  it("treats a literal _ as text rather than a single-character wildcard", async () => {
    const { token } = await registerVerifiedPlayer({ app, redis });
    const plain = await makePlayer("Dino");
    const underscore = await makePlayer("D_no");

    const res = await search(token, "d_n");
    const ids = res.json<Body>().players.map((row) => row.playerId);
    expect(ids).toContain(underscore);
    expect(ids).not.toContain(plain);
  });

  it("caps the result set at twenty rows, ordered by username", async () => {
    const { token } = await registerVerifiedPlayer({ app, redis });
    // 25 matches on a term the caller's own generated username (`p_<hex>`)
    // cannot contain, so the count is exactly the rows inserted here.
    for (let i = 0; i < 25; i++) {
      await makePlayer(`Zeppo${String(i).padStart(2, "0")}`);
    }

    const res = await search(token, "zeppo");
    const found = res.json<Body>().players;
    expect(found).toHaveLength(20);
    expect(found[0]?.username).toBe("Zeppo00");
    expect(found[19]?.username).toBe("Zeppo19");
  });
});
