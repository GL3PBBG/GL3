import { TableRowsResponseSchema } from "@gl3/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance, InjectOptions } from "fastify";
import type { LightMyRequestResponse } from "light-my-request";
import postgres from "postgres";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { players, roleModuleAccess, rounds, roles } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * Admin scheduling for rounds — `/api/admin/rounds` (GET, GET /table, POST,
 * POST /edit). No "end it now" route exists on purpose: setting `endsAt` into
 * the past through the edit route IS how a round ends, and the next lazy
 * rollover (GET /api/rounds, `ensureCurrentRound`) settles it. Case 5 below
 * asserts that mechanism directly rather than looking for a button that
 * deliberately does not exist.
 *
 * The overlap rule is the write-time guard `probe()` (game/rounds/service.ts)
 * relies on at read time: it never proves uniqueness itself, only trusts it.
 * Case 2 covers all five colliding geometries plus the two accepted
 * (half-open, endpoint-sharing) edges; case 8 is the only assertion in this
 * file that fails without the shared advisory lock (7461002) as the write
 * routes' first statement — see task-11-brief.md Step 8.
 */

const { db, sql: conn } = testDb();
const config = loadConfig({ ...process.env, NODE_ENV: "test" });
let app: FastifyInstance;
let closeServer: () => Promise<void>;

/** app.inject() is lazy — it dispatches only when something calls .then. */
function fire(opts: InjectOptions): Promise<LightMyRequestResponse> {
  return Promise.resolve(app.inject(opts));
}

async function waitForLockWaiters(n: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const [row] = await conn<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()
    `;
    const seen = row?.n ?? 0;
    if (seen >= n) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${n} lock-waiting backends (saw ${seen})`);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
}

async function registerPlayer(username: string): Promise<{ token: string; playerId: string }> {
  const res = await app.inject({
    method: "POST", url: "/api/auth/register",
    payload: { username, password: "hunter2hunter2" },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

/** First-registered player auto-becomes Administrator (`*`) — a fresh, non-first
 *  registration always starts with no role and no grants. */
async function giveRole(playerId: string, moduleKey: string): Promise<void> {
  const roleId = uuidv7();
  await db.insert(roles).values({ id: roleId, name: `role-${moduleKey}-${roleId.slice(-6)}` });
  await db.insert(roleModuleAccess).values({ roleId, moduleKey });
  await db.update(players).set({ roleId }).where(eq(players.id, playerId));
}

const auth = (token: string): { authorization: string } => ({ authorization: `Bearer ${token}` });
const iso = (d: Date): string => d.toISOString();
const addDays = (d: Date, n: number): Date => new Date(d.getTime() + n * 86_400_000);

const EXIST_START = new Date("2026-06-10T00:00:00.000Z");
const EXIST_END = new Date("2026-06-20T00:00:00.000Z");

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer } = await bootTestServer());
});

afterAll(async () => { await closeServer(); await conn.end(); });

describe("admin rounds: authorization", () => {
  // Core admin routes carry no loader tier — `auth: "admin"` is a plugin-route
  // concept only. Core enforces it with `requireAuth` plus the inline grant
  // check, same as roles' admin routes.
  it("401s with no token", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/rounds" });
    expect(res.statusCode).toBe(401);
  });

  it("403s a role with no grant", async () => {
    await registerPlayer("FirstAdmin"); // sacrificial — soaks up the auto-admin slot
    const p = await registerPlayer("NoRole");
    const res = await app.inject({
      method: "GET", url: "/api/admin/rounds", headers: auth(p.token),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "forbidden" });
  });

  it("200s a role holding the rounds module key", async () => {
    await registerPlayer("FirstAdmin");
    const p = await registerPlayer("RoundsMod");
    await giveRole(p.playerId, "rounds");
    const res = await app.inject({
      method: "GET", url: "/api/admin/rounds", headers: auth(p.token),
    });
    expect(res.statusCode).toBe(200);
  });

  it("200s a role holding the * wildcard", async () => {
    await registerPlayer("FirstAdmin");
    const p = await registerPlayer("Wildcard");
    await giveRole(p.playerId, "*");
    const res = await app.inject({
      method: "GET", url: "/api/admin/rounds", headers: auth(p.token),
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("admin rounds: GET /api/admin/rounds", () => {
  // Payload shape and ordering — the `starts_at ASC NULLS LAST` clause is
  // duplicated across this route and /table, so a mistake in either copy is
  // covered here as well as by the /table case below.
  it("returns { rounds } ordered starts_at ASC NULLS LAST, ISO strings or null", async () => {
    const founder = await registerPlayer("Founder");
    const early = uuidv7();
    const late = uuidv7();
    const openEnded = uuidv7();
    // Inserted out of chronological order on purpose, so a working ORDER BY
    // is what puts them back in the right sequence — a no-op ORDER BY would
    // pass a coincidentally-already-sorted fixture.
    await db.insert(rounds).values([
      { id: late, name: "Late", startsAt: addDays(EXIST_END, 5), endsAt: addDays(EXIST_END, 10) },
      { id: early, name: "Early", startsAt: EXIST_START, endsAt: EXIST_END },
      { id: openEnded, name: "NullStart", startsAt: null, endsAt: null },
    ]);

    const res = await app.inject({ method: "GET", url: "/api/admin/rounds", headers: auth(founder.token) });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { rounds: { id: string; startsAt: string | null; endsAt: string | null; finalizedAt: string | null; name: string; status: string }[] };

    // A NULL starts_at sorts LAST under NULLS LAST, so it must be the final entry.
    expect(body.rounds.at(-1)?.id).toBe(openEnded);
    // The two dated rows are in chronological order despite insertion order.
    const dated = body.rounds.filter((r) => r.id !== openEnded);
    expect(dated.map((r) => r.id)).toEqual([early, late]);

    const earlyRow = body.rounds.find((r) => r.id === early)!;
    expect(earlyRow).toMatchObject({ name: "Early", startsAt: iso(EXIST_START), endsAt: iso(EXIST_END) });
    expect(earlyRow.finalizedAt).toBeNull();
    expect(["finalized", "active", "ended", "scheduled"]).toContain(earlyRow.status);

    const nullRow = body.rounds.find((r) => r.id === openEnded)!;
    expect(nullRow.startsAt).toBeNull();
    expect(nullRow.endsAt).toBeNull();
  });
});

describe("admin rounds: overlap rejected at write time", () => {
  async function seedExisting(): Promise<{ token: string }> {
    const founder = await registerPlayer("Founder"); // first registration = auto-admin
    await db.insert(rounds).values({ id: uuidv7(), name: "Existing", startsAt: EXIST_START, endsAt: EXIST_END });
    return { token: founder.token };
  }

  const geometries: { label: string; startsAt: Date; endsAt: Date }[] = [
    { label: "identical", startsAt: EXIST_START, endsAt: EXIST_END },
    { label: "strictly inside", startsAt: addDays(EXIST_START, 1), endsAt: addDays(EXIST_END, -1) },
    { label: "strictly containing", startsAt: addDays(EXIST_START, -1), endsAt: addDays(EXIST_END, 1) },
    { label: "overlapping the front edge", startsAt: addDays(EXIST_START, -1), endsAt: addDays(EXIST_START, 1) },
    { label: "overlapping the back edge", startsAt: addDays(EXIST_END, -1), endsAt: addDays(EXIST_END, 1) },
  ];

  for (const g of geometries) {
    it(`rejects a create ${g.label} the existing round`, async () => {
      const { token } = await seedExisting();
      const res = await app.inject({
        method: "POST", url: "/api/admin/rounds", headers: auth(token),
        payload: { name: `Clash (${g.label})`, startsAt: iso(g.startsAt), endsAt: iso(g.endsAt) },
      });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json()).toEqual({ error: "round_overlap" });
    });
  }

  it("accepts a create strictly before, sharing the start endpoint (half-open)", async () => {
    const { token } = await seedExisting();
    const res = await app.inject({
      method: "POST", url: "/api/admin/rounds", headers: auth(token),
      payload: { name: "Before", startsAt: iso(addDays(EXIST_START, -2)), endsAt: iso(EXIST_START) },
    });
    expect(res.statusCode, res.body).toBe(201);
  });

  it("accepts a create strictly after, sharing the end endpoint (half-open)", async () => {
    const { token } = await seedExisting();
    const res = await app.inject({
      method: "POST", url: "/api/admin/rounds", headers: auth(token),
      payload: { name: "After", startsAt: iso(EXIST_END), endsAt: iso(addDays(EXIST_END, 2)) },
    });
    expect(res.statusCode, res.body).toBe(201);
  });

  it("rejects editing a round into an overlap with another round", async () => {
    const { token } = await seedExisting();
    const create = await app.inject({
      method: "POST", url: "/api/admin/rounds", headers: auth(token),
      payload: { name: "Movable", startsAt: iso(addDays(EXIST_END, 5)), endsAt: iso(addDays(EXIST_END, 10)) },
    });
    expect(create.statusCode, create.body).toBe(201);
    const { id } = create.json() as { id: string };

    const res = await app.inject({
      method: "POST", url: "/api/admin/rounds/edit", headers: auth(token),
      payload: { roundId: id, name: "Movable", startsAt: iso(EXIST_START), endsAt: iso(EXIST_END) },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json()).toEqual({ error: "round_overlap" });
  });

  it("does not reject editing a round without changing its dates", async () => {
    const { token } = await seedExisting();
    const [existing] = await db.select().from(rounds);
    const res = await app.inject({
      method: "POST", url: "/api/admin/rounds/edit", headers: auth(token),
      payload: {
        roundId: existing!.id,
        name: existing!.name,
        startsAt: iso(existing!.startsAt!),
        endsAt: iso(existing!.endsAt!),
      },
    });
    expect(res.statusCode, res.body).toBe(204);
  });

  it("404s an edit to an unknown round id", async () => {
    const { token } = await seedExisting();
    const res = await app.inject({
      method: "POST", url: "/api/admin/rounds/edit", headers: auth(token),
      payload: { roundId: uuidv7(), name: "Ghost", startsAt: iso(EXIST_START), endsAt: iso(EXIST_END) },
    });
    expect(res.statusCode, res.body).toBe(404);
    expect(res.json()).toEqual({ error: "round_not_found" });
  });

  // The `coalesce(ends_at, 'infinity')` limb, exercised by an actual write —
  // every V2-migrated install ships exactly one open-ended round, and this is
  // the rule that forces an admin to give it an `ends_at` before scheduling
  // the next season. `coalesce(ends_at, ends_at)`, or no coalesce at all,
  // would otherwise pass every other case in this file.
  describe("the open-ended (null ends_at) limb", () => {
    const OPEN_START = new Date("2026-05-01T00:00:00.000Z");

    async function seedOpenEnded(): Promise<{ token: string }> {
      const founder = await registerPlayer("Founder");
      await db.insert(rounds).values({ id: uuidv7(), name: "OpenEnded", startsAt: OPEN_START, endsAt: null });
      return { token: founder.token };
    }

    it("rejects a create starting after an open-ended round's start", async () => {
      const { token } = await seedOpenEnded();
      const res = await app.inject({
        method: "POST", url: "/api/admin/rounds", headers: auth(token),
        payload: { name: "AfterOpen", startsAt: iso(addDays(OPEN_START, 10)), endsAt: iso(addDays(OPEN_START, 20)) },
      });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json()).toEqual({ error: "round_overlap" });
    });

    it("accepts a create ending at or before an open-ended round's start (half-open)", async () => {
      const { token } = await seedOpenEnded();
      const res = await app.inject({
        method: "POST", url: "/api/admin/rounds", headers: auth(token),
        payload: { name: "BeforeOpen", startsAt: iso(addDays(OPEN_START, -10)), endsAt: iso(OPEN_START) },
      });
      expect(res.statusCode, res.body).toBe(201);
    });
  });
});

describe("admin rounds: overlap with a finalized round is allowed", () => {
  it("accepts a create over the same window as a finalized round", async () => {
    const founder = await registerPlayer("Founder");
    await db.insert(rounds).values({
      id: uuidv7(), name: "Finalized", startsAt: EXIST_START, endsAt: EXIST_END, finalizedAt: new Date(),
    });
    const res = await app.inject({
      method: "POST", url: "/api/admin/rounds", headers: auth(founder.token),
      payload: { name: "OverFinalized", startsAt: iso(EXIST_START), endsAt: iso(EXIST_END) },
    });
    expect(res.statusCode, res.body).toBe(201);
  });
});

describe("admin rounds: a finalized round is immutable", () => {
  async function seedFinalized(): Promise<{ token: string; id: string; startsAt: Date; endsAt: Date; name: string }> {
    const founder = await registerPlayer("Founder");
    const id = uuidv7();
    await db.insert(rounds).values({
      id, name: "Frozen", startsAt: EXIST_START, endsAt: EXIST_END, finalizedAt: new Date(),
    });
    return { token: founder.token, id, startsAt: EXIST_START, endsAt: EXIST_END, name: "Frozen" };
  }

  it("rejects editing startsAt", async () => {
    const f = await seedFinalized();
    const res = await app.inject({
      method: "POST", url: "/api/admin/rounds/edit", headers: auth(f.token),
      payload: { roundId: f.id, name: f.name, startsAt: iso(addDays(f.startsAt, -1)), endsAt: iso(f.endsAt) },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json()).toEqual({ error: "round_finalized" });
  });

  it("rejects editing endsAt", async () => {
    const f = await seedFinalized();
    const res = await app.inject({
      method: "POST", url: "/api/admin/rounds/edit", headers: auth(f.token),
      payload: { roundId: f.id, name: f.name, startsAt: iso(f.startsAt), endsAt: iso(addDays(f.endsAt, 1)) },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json()).toEqual({ error: "round_finalized" });
  });

  it("rejects editing name alone", async () => {
    const f = await seedFinalized();
    const res = await app.inject({
      method: "POST", url: "/api/admin/rounds/edit", headers: auth(f.token),
      payload: { roundId: f.id, name: "Renamed", startsAt: iso(f.startsAt), endsAt: iso(f.endsAt) },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json()).toEqual({ error: "round_finalized" });
  });
});

describe("admin rounds: there is no \"end it now\" button", () => {
  it("ends a round by scheduling — editing endsAt into the past triggers the next rollover", async () => {
    const founder = await registerPlayer("Founder");
    const startsAt = new Date(Date.now() - 3_600_000);
    const endsAt = new Date(Date.now() + 3_600_000);
    const create = await app.inject({
      method: "POST", url: "/api/admin/rounds", headers: auth(founder.token),
      payload: { name: "Live", startsAt: iso(startsAt), endsAt: iso(endsAt) },
    });
    expect(create.statusCode, create.body).toBe(201);
    const { id } = create.json() as { id: string };

    const edit = await app.inject({
      method: "POST", url: "/api/admin/rounds/edit", headers: auth(founder.token),
      payload: { roundId: id, name: "Live", startsAt: iso(startsAt), endsAt: iso(new Date(Date.now() - 1000)) },
    });
    expect(edit.statusCode, edit.body).toBe(204);

    // No "end it now" endpoint exists — the mechanism is the schedule. This is
    // what settles it: an ordinary GET /api/rounds runs ensureCurrentRound first.
    const get = await app.inject({ method: "GET", url: "/api/rounds", headers: auth(founder.token) });
    expect(get.statusCode, get.body).toBe(200);

    // `row` present AND its finalizedAt actually a Date — `not.toBeNull()`
    // alone would pass vacuously if the row went missing (undefined !== null).
    const [row] = await db.select().from(rounds).where(eq(rounds.id, id));
    expect(row).toBeDefined();
    expect(row?.finalizedAt).toBeInstanceOf(Date);
  });
});

describe("admin rounds: validation", () => {
  it("400s invalid_window when endsAt <= startsAt", async () => {
    const founder = await registerPlayer("Founder");
    const now = new Date("2027-02-01T00:00:00.000Z");
    const res = await app.inject({
      method: "POST", url: "/api/admin/rounds", headers: auth(founder.token),
      payload: { name: "Backwards", startsAt: iso(now), endsAt: iso(now) },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_window" });
  });

  it("400s invalid_request on a malformed timestamp", async () => {
    const founder = await registerPlayer("Founder");
    const res = await app.inject({
      method: "POST", url: "/api/admin/rounds", headers: auth(founder.token),
      payload: { name: "Bad", startsAt: "not-a-date", endsAt: "also-not-a-date" },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_request" });
  });

  it("400s invalid_request on an unknown body key", async () => {
    const founder = await registerPlayer("Founder");
    const now = new Date("2027-02-01T00:00:00.000Z");
    const res = await app.inject({
      method: "POST", url: "/api/admin/rounds", headers: auth(founder.token),
      payload: { name: "Extra", startsAt: iso(now), endsAt: iso(addDays(now, 1)), bogus: "field" },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_request" });
  });
});

describe("admin rounds: timezone offsets", () => {
  it("accepts a non-Z UTC offset timestamp ({ offset: true })", async () => {
    const founder = await registerPlayer("Founder");
    const res = await app.inject({
      method: "POST", url: "/api/admin/rounds", headers: auth(founder.token),
      payload: { name: "Offset", startsAt: "2026-09-01T00:00:00+02:00", endsAt: "2026-09-02T00:00:00+02:00" },
    });
    expect(res.statusCode, res.body).toBe(201);
  });
});

/**
 * The only case in this file that fails with the advisory lock removed —
 * every other case runs sequentially and would stay green regardless. See
 * task-11-brief.md Step 8 for the red proof this was checked against.
 *
 * A bare `Promise.all` over two `app.inject()` calls is NOT enough to force
 * a genuine race here: on this box, a plain SELECT + INSERT round-trips fast
 * enough that the two requests reliably serialize on their own, lock or no
 * lock — three back-to-back runs against the code with the advisory lock
 * physically deleted still produced one 201 and one 400, proving nothing.
 *
 * So this uses the same barrier technique as `shop-concurrency.test.ts` and
 * `rounds-lock-order.test.ts`: a separate connection takes
 * `LOCK TABLE rounds IN ACCESS EXCLUSIVE MODE` BEFORE either request fires.
 * That is the first statement inside the route's transaction that touches
 * `rounds` at all in EITHER code path — the advisory lock acquisition itself
 * (independent of any table lock) succeeds uncontended for whichever request
 * gets it first, but that request's own overlap-check SELECT then queues
 * behind the barrier, and the second request queues behind the advisory lock
 * held by the first. Releasing the barrier resolves both waits at the same
 * instant, so the interleaving is fixed by construction rather than by luck,
 * in both the locked and unlocked code path — this is what makes the test
 * meaningful either way rather than needing a different harness per case.
 */
describe("admin rounds: concurrent creates of the same window", () => {
  it("lets exactly one of two concurrent creates win, with count(*) = 1", async () => {
    const founder = await registerPlayer("Founder");
    const payload = { name: "Race", startsAt: "2027-01-01T00:00:00.000Z", endsAt: "2027-01-10T00:00:00.000Z" };

    const blocker = postgres(config.databaseUrl, { max: 1 });
    const t0 = await blocker.reserve();
    const inFlight: Promise<LightMyRequestResponse>[] = [];

    try {
      await t0`BEGIN`;
      await t0`LOCK TABLE rounds IN ACCESS EXCLUSIVE MODE`;

      const a = fire({
        method: "POST", url: "/api/admin/rounds", headers: auth(founder.token), payload,
      });
      inFlight.push(a);
      const b = fire({
        method: "POST", url: "/api/admin/rounds", headers: auth(founder.token),
        payload: { ...payload, name: "Race (other)" },
      });
      inFlight.push(b);
      await waitForLockWaiters(2);

      // Releases both from the same instant, with the interleaving fixed.
      await t0`ROLLBACK`;

      const [resA, resB] = await Promise.all([a, b]);
      const codes = [resA.statusCode, resB.statusCode].sort();
      expect(codes, `a=${resA.statusCode} ${resA.body} / b=${resB.statusCode} ${resB.body}`).toEqual([201, 400]);
      const loser = resA.statusCode === 400 ? resA : resB;
      expect(loser.json()).toEqual({ error: "round_overlap" });

      const [{ n }] = await conn<{ n: number }[]>`SELECT count(*)::int AS n FROM rounds`;
      expect(n).toBe(1);
    } finally {
      try {
        await t0`ROLLBACK`;
      } catch {
        /* already rolled back */
      }
      await Promise.allSettled(inFlight);
      t0.release();
      await blocker.end();
    }
  }, 30_000);
});

describe("admin rounds: GET /api/admin/rounds/table", () => {
  it("parses under TableRowsResponseSchema with string-only values", async () => {
    const founder = await registerPlayer("Founder");
    await db.insert(rounds).values({
      id: uuidv7(), name: "OpenEnded", startsAt: new Date(Date.now() - 3_600_000), endsAt: null,
    });
    await db.insert(rounds).values({
      id: uuidv7(), name: "Scheduled",
      startsAt: new Date(Date.now() + 3_600_000), endsAt: new Date(Date.now() + 7_200_000),
    });
    await db.insert(rounds).values({
      id: uuidv7(), name: "Done",
      startsAt: new Date(Date.now() - 7_200_000), endsAt: new Date(Date.now() - 3_600_000),
      finalizedAt: new Date(),
    });

    const res = await app.inject({
      method: "GET", url: "/api/admin/rounds/table", headers: auth(founder.token),
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    const parsed = TableRowsResponseSchema.safeParse(body);
    expect(parsed.success, JSON.stringify(body)).toBe(true);

    const rows = body.rows as Record<string, string>[];
    const validStatuses = ["finalized", "active", "ended", "scheduled"];
    for (const row of rows) {
      for (const value of Object.values(row)) expect(typeof value).toBe("string");
      expect(validStatuses).toContain(row.status);
    }
    const open = rows.find((r) => r.name === "OpenEnded");
    expect(open?.endsAt).toBe("");
    expect(open?.status).toBe("active");
  });
});
