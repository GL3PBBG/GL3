import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { players, roleModuleAccess, roles } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;

async function giveRole(playerId: string, moduleKey: string): Promise<void> {
  const roleId = uuidv7();
  await db.insert(roles).values({ id: roleId, name: `role-${moduleKey}-${roleId.slice(0, 8)}` });
  await db.insert(roleModuleAccess).values({ roleId, moduleKey });
  await db.update(players).set({ roleId }).where(eq(players.id, playerId));
}

async function bootModAndTarget(): Promise<{
  mod: { token: string }; target: { token: string; playerId: string; username: string };
}> {
  await registerVerifiedPlayer({ app, redis }, { username: "FirstAdmin" });
  const mod = await registerVerifiedPlayer({ app, redis }, { username: "Watcher" });
  await giveRole(mod.playerId, "anti-bot");
  const target = await registerVerifiedPlayer({ app, redis }, { username: "Suspect" });
  return { mod: { token: mod.token }, target };
}

function flag(modToken: string, username: string, clear = false): Promise<Awaited<ReturnType<FastifyInstance["inject"]>>> {
  return app.inject({
    method: "POST",
    url: clear ? "/api/admin/anti-bot/challenge/clear" : "/api/admin/anti-bot/challenge",
    headers: { authorization: `Bearer ${modToken}` },
    payload: { username },
  });
}

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer, redis } = await bootTestServer());
});

afterAll(async () => { await closeServer(); await conn.end(); });

describe("challenge gate", () => {
  it("a flagged player's mutating requests 409 while GETs stay open", async () => {
    const { mod, target } = await bootModAndTarget();
    expect((await flag(mod.token, target.username)).statusCode).toBe(200);

    const auth = { authorization: `Bearer ${target.token}` };
    const post = await app.inject({
      method: "POST", url: "/api/bank/deposit", headers: auth, payload: { amount: "1" },
    });
    expect(post.statusCode).toBe(409);
    expect(post.json()).toMatchObject({ error: "challenge_required" });

    const get = await app.inject({ method: "GET", url: "/api/auth/me", headers: auth });
    expect(get.statusCode).toBe(200);
  });

  it("logout and the challenge routes stay reachable while flagged", async () => {
    const { mod, target } = await bootModAndTarget();
    await flag(mod.token, target.username);
    const auth = { authorization: `Bearer ${target.token}` };

    const question = await app.inject({ method: "GET", url: "/api/challenge", headers: auth });
    expect(question.statusCode).toBe(200);

    const attempt = await app.inject({
      method: "POST", url: "/api/challenge", headers: auth, payload: { answer: "not-a-number" },
    });
    expect([400, 200]).toContain(attempt.statusCode); // reachable, not 409

    const logout = await app.inject({ method: "POST", url: "/api/auth/logout", headers: auth });
    expect(logout.statusCode).toBe(204);
  });

  it("solving the arithmetic unflags: wrong answer 400s and burns the question, right answer reopens play", async () => {
    const { mod, target } = await bootModAndTarget();
    await flag(mod.token, target.username);
    const auth = { authorization: `Bearer ${target.token}` };

    const q1 = await app.inject({ method: "GET", url: "/api/challenge", headers: auth });
    expect(q1.statusCode).toBe(200);
    const { question } = q1.json() as { question: string };
    const match = /(\d+)\s*\+\s*(\d+)/.exec(question);
    expect(match).not.toBeNull();
    const sum = Number(match![1]) + Number(match![2]);

    const wrong = await app.inject({
      method: "POST", url: "/api/challenge", headers: auth, payload: { answer: String(sum + 1) },
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toMatchObject({ error: "wrong_answer" });

    // GETDEL burnt the stored answer: the right sum for the OLD question no
    // longer exists server-side, so even the correct figure now 400s until a
    // fresh question is minted.
    const stale = await app.inject({
      method: "POST", url: "/api/challenge", headers: auth, payload: { answer: String(sum) },
    });
    expect(stale.statusCode).toBe(400);

    const q2 = await app.inject({ method: "GET", url: "/api/challenge", headers: auth });
    const m2 = /(\d+)\s*\+\s*(\d+)/.exec((q2.json() as { question: string }).question);
    const right = await app.inject({
      method: "POST", url: "/api/challenge", headers: auth,
      payload: { answer: String(Number(m2![1]) + Number(m2![2])) },
    });
    expect(right.statusCode).toBe(200);
    expect(right.json()).toMatchObject({ solved: true });

    const post = await app.inject({
      method: "POST", url: "/api/bank/deposit", headers: auth, payload: { amount: "1" },
    });
    // Bank may still refuse on its own terms (a fresh player holds no cash);
    // what matters is the GATE no longer answers.
    expect((post.json() as { error?: string }).error).not.toBe("challenge_required");
  });

  it("admin clear unflags without solving; unflagged players never see the gate", async () => {
    const { mod, target } = await bootModAndTarget();
    await flag(mod.token, target.username);
    expect((await flag(mod.token, target.username, true)).statusCode).toBe(200);

    const auth = { authorization: `Bearer ${target.token}` };
    const post = await app.inject({
      method: "POST", url: "/api/bank/deposit", headers: auth, payload: { amount: "1" },
    });
    expect((post.json() as { error?: string }).error).not.toBe("challenge_required");

    // An unflagged player GETting /api/challenge is told there is nothing to solve.
    const idle = await app.inject({ method: "GET", url: "/api/challenge", headers: auth });
    expect(idle.statusCode).toBe(409);
    expect(idle.json()).toMatchObject({ error: "not_challenged" });
  });
});
