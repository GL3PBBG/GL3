# Hospital Self-Admission and Local Facility Rosters — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a hurt player check themselves into hospital to heal for the price of time, and let anyone standing in a town see — and act on — the players in that town's hospital and jail.

**Architecture:** Everything lands in core (`apps/server/src/game/hospital/`, `apps/server/src/game/jail/`), because bail/bust/paid-discharge need a release-another-player primitive that would otherwise have to be exposed on the plugin SDK ctx. Six new routes, four new settings, no new database objects, and no new `GameEvent` variants — the facts are published through the existing `player.released` / `player.discharged` / `player.jailed` / `notification.created` events.

**Tech Stack:** TypeScript (strict, ESM, `.js` import suffixes), Fastify, drizzle-orm on PostgreSQL, ioredis, Zod at every boundary, vitest against real Postgres + Redis, React + TanStack Query on the web.

**Spec:** `docs/superpowers/specs/2026-08-18-hospital-jail-social-design.md`

## Global Constraints

- **Money is `bigint`** in Postgres and TypeScript, and crosses the wire as a decimal string (`MoneySchema`). Never a JSON number.
- **Every balance movement goes through `applyBalanceChange`** (`apps/server/src/economy/ledger.ts`). One transaction, one ledger row.
- **Two-player routes take ONE sorted `lockPlayersForUpdate(tx, [a, b])` as the FIRST statement of the transaction**, before reading either player. Never two separate calls.
- **Publish events only after the transaction commits.** Never inside `db.transaction(...)`.
- **Zod-validate every request body.** A malformed body must produce a clean 400, never a 500 from Postgres.
- **Tests asserting on `game:events` filter by their own `actorId`** via `awaitOwnEvent()` (`apps/server/test/helpers/events.ts`). The channel is global across test files.
- **Every new `apps/server/test/*.test.ts` file MUST be added to `vitest.workspace.ts`.** A file that is not listed in a project's `include` never runs, and `npm run verify` stays green without it.
- **No `any` in `packages/*`.**
- Settings defaults, copied verbatim from spec §6: `hospital.checkin_seconds_per_hp` = `30`, `jail.bail_cost_per_second` = `1000`, `jail.bust_success_percent` = `25`, `jail.bust_fail_jail_seconds` = `300`.
- Environment for every test run: `export DATABASE_URL=postgres://gl3:gl3@localhost:5432/gl3` and `export REDIS_URL=redis://localhost:6379`.
- Conventional Commits.

## File Structure

**Created (server):**
- `apps/server/src/game/hospital/settings.ts` — parses `hospital.checkin_seconds_per_hp`; exports the existing per-second discharge rate so both hospital routes share one parser.
- `apps/server/src/game/jail/settings.ts` — parses the three `jail.*` keys.
- `apps/server/src/game/jail/bust.ts` — `bustSucceeds(seed, percent)`, pure.
- `apps/server/src/game/roster.ts` — one query used by both roster routes: players at a location with a live sentence.

**Modified (server):**
- `apps/server/src/game/hospital/routes.ts` — check-in, `/local`, `discharge-player`; gains `redis`.
- `apps/server/src/game/jail/routes.ts` — `/local`, `bail`, `bust`; gains `settings`.
- `apps/server/src/app.ts:74-75` — both registration calls change shape.

**Created (tests):** `facility-settings.test.ts` (unit), `hospital-checkin.test.ts`, `facility-rosters.test.ts`, `hospital-discharge-player.test.ts`, `jail-bail-bust.test.ts`, `facility-concurrency.test.ts`.

**Modified (shared/web):** `packages/shared/src/dto/hospital.ts`, `packages/shared/src/dto/jail.ts`, `packages/shared/package.json`, `apps/web/src/api/keys.ts`, `apps/web/src/api/queries.ts`, `apps/web/src/lib/errors.ts`, `apps/web/src/pages/Hospital.tsx`, `apps/web/src/pages/Jail.tsx`.

---

### Task 1: Settings parsers and the bust roll

**Files:**
- Create: `apps/server/src/game/hospital/settings.ts`
- Create: `apps/server/src/game/jail/settings.ts`
- Create: `apps/server/src/game/jail/bust.ts`
- Modify: `apps/server/src/game/hospital/routes.ts` (delete the local `costPerSecond`, import it)
- Modify: `vitest.workspace.ts` (`@gl3/server:unit` include list)
- Test: `apps/server/test/facility-settings.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `dischargeCostPerSecond(settings: Record<string,string>): bigint`, `checkinSecondsPerHp(settings): number`, `bailCostPerSecond(settings): bigint`, `bustSuccessPercent(settings): number`, `bustFailJailSeconds(settings): number`, `bustSucceeds(seed: string, percent: number): boolean`.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/facility-settings.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { checkinSecondsPerHp, dischargeCostPerSecond } from "../src/game/hospital/settings.js";
import { bailCostPerSecond, bustFailJailSeconds, bustSuccessPercent } from "../src/game/jail/settings.js";
import { bustSucceeds } from "../src/game/jail/bust.js";

/**
 * `settings` is admin-edited free text. A typo there must fall back to the
 * default rather than throw on every request — the rule the existing
 * `costPerSecond` comment in hospital/routes.ts states, applied to all five.
 * Note `BigInt("")` returns 0n rather than throwing, so blank has to be
 * rejected explicitly or a cleared admin field silently means "free".
 */
describe("facility settings parsers", () => {
  it("uses defaults when the keys are absent", () => {
    expect(dischargeCostPerSecond({})).toBe(1000n);
    expect(checkinSecondsPerHp({})).toBe(30);
    expect(bailCostPerSecond({})).toBe(1000n);
    expect(bustSuccessPercent({})).toBe(25);
    expect(bustFailJailSeconds({})).toBe(300);
  });

  it("reads well-formed values", () => {
    expect(checkinSecondsPerHp({ "hospital.checkin_seconds_per_hp": "5" })).toBe(5);
    expect(bailCostPerSecond({ "jail.bail_cost_per_second": "42" })).toBe(42n);
    expect(bustSuccessPercent({ "jail.bust_success_percent": "0" })).toBe(0);
    expect(bustSuccessPercent({ "jail.bust_success_percent": "100" })).toBe(100);
    expect(bustFailJailSeconds({ "jail.bust_fail_jail_seconds": "60" })).toBe(60);
  });

  it.each(["", "   ", "abc", "-1", "1.5"])("falls back on %j", (raw) => {
    expect(checkinSecondsPerHp({ "hospital.checkin_seconds_per_hp": raw })).toBe(30);
    expect(bailCostPerSecond({ "jail.bail_cost_per_second": raw })).toBe(1000n);
    expect(bustFailJailSeconds({ "jail.bust_fail_jail_seconds": raw })).toBe(300);
  });

  it("clamps an out-of-range bust percentage instead of falling back", () => {
    expect(bustSuccessPercent({ "jail.bust_success_percent": "250" })).toBe(100);
    expect(bustSuccessPercent({ "jail.bust_success_percent": "-5" })).toBe(0);
  });

  it("never succeeds at 0 and always succeeds at 100", () => {
    for (const seed of ["a", "b", "c", "d", "e"]) {
      expect(bustSucceeds(seed, 0)).toBe(false);
      expect(bustSucceeds(seed, 100)).toBe(true);
    }
  });

  it("is deterministic for a given seed", () => {
    expect(bustSucceeds("fixed-seed", 50)).toBe(bustSucceeds("fixed-seed", 50));
  });

  it("lands near the configured rate over many seeds", () => {
    const wins = Array.from({ length: 400 }, (_, i) => bustSucceeds(`seed-${i}`, 25))
      .filter(Boolean).length;
    expect(wins).toBeGreaterThan(60);
    expect(wins).toBeLessThan(140);
  });
});
```

- [ ] **Step 2: Register the test file, then run it to verify it fails**

In `vitest.workspace.ts`, add `"test/facility-settings.test.ts",` to the `include` array of the project named `@gl3/server:unit` (alongside `"test/rng.test.ts"`).

Run: `npx vitest run --project '@gl3/server:unit' test/facility-settings.test.ts`
Expected: FAIL — `Cannot find module '../src/game/hospital/settings.js'`.

(If it instead prints "No test files found", the `vitest.workspace.ts` edit did not land — fix that before continuing.)

- [ ] **Step 3: Write the implementations**

Create `apps/server/src/game/hospital/settings.ts`:

```ts
/**
 * `settings` rows are admin-edited free text, so every parser here answers a
 * malformed value with the default rather than throwing on every request.
 * Blank is malformed on purpose: `BigInt("")` is 0n, not a throw, so a cleared
 * admin field would otherwise make discharge free.
 */
const DEFAULT_DISCHARGE_COST_PER_SECOND = 1000n;
const DEFAULT_CHECKIN_SECONDS_PER_HP = 30;

export function parseNonNegativeBigint(raw: string | undefined, fallback: bigint): bigint {
  if (raw === undefined || raw.trim() === "") return fallback;
  try {
    const parsed = BigInt(raw);
    return parsed >= 0n ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return fallback;
  return parsed;
}

export function dischargeCostPerSecond(settings: Record<string, string>): bigint {
  return parseNonNegativeBigint(
    settings["hospital.discharge_cost_per_second"], DEFAULT_DISCHARGE_COST_PER_SECOND,
  );
}

export function checkinSecondsPerHp(settings: Record<string, string>): number {
  return parsePositiveInt(settings["hospital.checkin_seconds_per_hp"], DEFAULT_CHECKIN_SECONDS_PER_HP);
}
```

Create `apps/server/src/game/jail/settings.ts`:

```ts
import { parseNonNegativeBigint, parsePositiveInt } from "../hospital/settings.js";

const DEFAULT_BAIL_COST_PER_SECOND = 1000n;
const DEFAULT_BUST_SUCCESS_PERCENT = 25;
const DEFAULT_BUST_FAIL_JAIL_SECONDS = 300;

export function bailCostPerSecond(settings: Record<string, string>): bigint {
  return parseNonNegativeBigint(settings["jail.bail_cost_per_second"], DEFAULT_BAIL_COST_PER_SECOND);
}

/**
 * Clamped rather than defaulted: an admin who types 250 meant "always", and
 * silently reverting that to 25 would be a worse surprise than honouring the
 * intent. Anything non-numeric still falls back like every other key.
 */
export function bustSuccessPercent(settings: Record<string, string>): number {
  const raw = settings["jail.bust_success_percent"];
  if (raw === undefined || raw.trim() === "") return DEFAULT_BUST_SUCCESS_PERCENT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return DEFAULT_BUST_SUCCESS_PERCENT;
  return Math.min(100, Math.max(0, parsed));
}

export function bustFailJailSeconds(settings: Record<string, string>): number {
  return parsePositiveInt(settings["jail.bust_fail_jail_seconds"], DEFAULT_BUST_FAIL_JAIL_SECONDS);
}
```

Create `apps/server/src/game/jail/bust.ts`:

```ts
import { createRng } from "../rng.js";

/**
 * Pure so both branches are testable without a server. The route generates the
 * seed itself and never accepts one from the client — a client-chosen seed is
 * a client-chosen outcome.
 */
export function bustSucceeds(seed: string, percent: number): boolean {
  if (percent <= 0) return false;
  if (percent >= 100) return true;
  return createRng(seed).int(0, 100) < percent;
}
```

- [ ] **Step 4: Point the existing hospital route at the shared parser**

In `apps/server/src/game/hospital/routes.ts`: delete the local `DEFAULT_COST_PER_SECOND` constant and the whole `costPerSecond` function, add `import { dischargeCostPerSecond } from "./settings.js";`, and replace both `costPerSecond(settings)` call sites with `dischargeCostPerSecond(settings)`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run --project '@gl3/server:unit' test/facility-settings.test.ts`
Expected: PASS.

Then prove the move did not change existing behaviour:
Run: `npx vitest run --project '@gl3/server' test/hospital.test.ts`
Expected: PASS (it has two tests that assert the malformed-setting fallback).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/game/hospital/settings.ts apps/server/src/game/jail/settings.ts \
  apps/server/src/game/jail/bust.ts apps/server/src/game/hospital/routes.ts \
  apps/server/test/facility-settings.test.ts vitest.workspace.ts
git commit -m "feat(facilities): settings parsers for check-in, bail and bust"
```

---

### Task 2: Shared DTOs and the `@gl3/shared` bump

**Files:**
- Modify: `packages/shared/src/dto/hospital.ts`
- Modify: `packages/shared/src/dto/jail.ts`
- Modify: `packages/shared/package.json` (version → `0.1.10`)
- Test: `packages/shared/test/facility-dto.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `HospitalPatientSchema` / `HospitalPatient`, `WardListResponseSchema` / `WardListResponse`, `CheckinResponseSchema` / `CheckinResponse` (from `dto/hospital.ts`); `JailInmateSchema` / `JailInmate`, `CellBlockListResponseSchema` / `CellBlockListResponse`, `BailResponseSchema` / `BailResponse`, `BustResponseSchema` / `BustResponse` (from `dto/jail.ts`). All re-exported through `packages/shared/src/index.ts` if that file enumerates exports rather than star-exporting the dto folder — check before assuming.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/test/facility-dto.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  BustResponseSchema, CellBlockListResponseSchema, CheckinResponseSchema, WardListResponseSchema,
} from "../src/index.js";

describe("facility DTOs", () => {
  it("parses a ward listing", () => {
    const parsed = WardListResponseSchema.parse({
      patients: [{
        playerId: "018f0000-0000-7000-8000-000000000001",
        username: "Vic", rankName: "Thug",
        until: "2026-08-18T12:00:00.000Z", remainingSeconds: 90, dischargeCost: "90000",
      }],
    });
    expect(parsed.patients[0]?.dischargeCost).toBe("90000");
  });

  it("rejects money sent as a JSON number", () => {
    expect(() => CellBlockListResponseSchema.parse({
      inmates: [{
        playerId: "018f0000-0000-7000-8000-000000000001",
        username: "Vic", rankName: "Thug",
        until: "2026-08-18T12:00:00.000Z", remainingSeconds: 90, bailCost: 90000,
      }],
    })).toThrow();
  });

  it("parses a check-in and a bust outcome", () => {
    expect(CheckinResponseSchema.parse({
      health: 0, maxHealth: 100, hospitalised: true,
      until: "2026-08-18T12:00:00.000Z", remainingSeconds: 300, dischargeCost: "300000",
    }).remainingSeconds).toBe(300);

    expect(BustResponseSchema.parse({ success: false, jailedUntil: "2026-08-18T12:05:00.000Z" })
      .success).toBe(false);
    expect(BustResponseSchema.parse({ success: true, jailedUntil: null }).jailedUntil).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project '@gl3/shared' test/facility-dto.test.ts`
Expected: FAIL — the schemas are not exported. If it says "No test files found", add the file to the `@gl3/shared` project's `include` in `vitest.workspace.ts` first (that project may glob; check).

- [ ] **Step 3: Add the schemas**

Append to `packages/shared/src/dto/hospital.ts`:

```ts
/** One patient in the caller's current town. Mirrors `GET /api/hospital/local`. */
export const HospitalPatientSchema = z.object({
  playerId: z.string().uuid(),
  username: z.string(),
  rankName: z.string(),
  until: z.string(),
  remainingSeconds: z.number().int().nonnegative(),
  /** What it would cost THE CALLER to pay this patient out. */
  dischargeCost: MoneySchema,
});
export type HospitalPatient = z.infer<typeof HospitalPatientSchema>;

export const WardListResponseSchema = z.object({ patients: z.array(HospitalPatientSchema) });
export type WardListResponse = z.infer<typeof WardListResponseSchema>;

/** `POST /api/hospital/checkin` answers with the same shape as `GET /api/hospital`. */
export const CheckinResponseSchema = HospitalStatusSchema;
export type CheckinResponse = z.infer<typeof CheckinResponseSchema>;
```

Append to `packages/shared/src/dto/jail.ts` (adding `import { MoneySchema } from "../primitives.js";` at the top):

```ts
export const JailInmateSchema = z.object({
  playerId: z.string().uuid(),
  username: z.string(),
  rankName: z.string(),
  until: z.string(),
  remainingSeconds: z.number().int().nonnegative(),
  bailCost: MoneySchema,
});
export type JailInmate = z.infer<typeof JailInmateSchema>;

export const CellBlockListResponseSchema = z.object({ inmates: z.array(JailInmateSchema) });
export type CellBlockListResponse = z.infer<typeof CellBlockListResponseSchema>;

export const BailResponseSchema = z.object({ freed: z.string().uuid(), paid: MoneySchema, cash: MoneySchema });
export type BailResponse = z.infer<typeof BailResponseSchema>;

/** `jailedUntil` is the CALLER's new sentence — non-null only when the bust failed. */
export const BustResponseSchema = z.object({
  success: z.boolean(),
  jailedUntil: TimestampSchema.nullable(),
});
export type BustResponse = z.infer<typeof BustResponseSchema>;
```

If `packages/shared/src/index.ts` lists dto exports explicitly, add every new name there too.

- [ ] **Step 4: Bump the version and run the test**

In `packages/shared/package.json`, change `"version"` from `0.1.9` to `0.1.10` (additive change, patch bump under `0.x` — `^0.1.0` consumers keep resolving).

Run: `npx vitest run --project '@gl3/shared'` and `npm run typecheck`
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): roster, check-in, bail and bust DTOs (0.1.10)"
```

---

### Task 3: `POST /api/hospital/checkin`

**Files:**
- Modify: `apps/server/src/game/hospital/routes.ts`
- Modify: `vitest.workspace.ts` (`@gl3/server` include list)
- Test: `apps/server/test/hospital-checkin.test.ts`

**Interfaces:**
- Consumes: `checkinSecondsPerHp` and `dischargeCostPerSecond` (Task 1); `sendToHospital(tx, playerId, seconds)` and `maxHealthFor(tx, playerId)` from `./status.js`.
- Produces: `POST /api/hospital/checkin` → 200 `HospitalStatus` shape, 409 `already_hospitalised` | `not_injured`.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/hospital-checkin.test.ts`:

```ts
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { playerStats } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let closeServer: () => Promise<void>;
let token: string;
let playerId: string;

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer } = await bootTestServer());
  const reg = await app.inject({
    method: "POST", url: "/api/auth/register",
    payload: { username: `Sick${Date.now()}`, password: "hunter2hunter2" },
  });
  ({ token, playerId } = reg.json());
});
afterAll(async () => { await closeServer(); await conn.end(); });

const auth = () => ({ authorization: `Bearer ${token}` });

describe("POST /api/hospital/checkin", () => {
  it("409s a player at full health", async () => {
    const res = await app.inject({ method: "POST", url: "/api/hospital/checkin", headers: auth() });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "not_injured" });
  });

  it("admits a hurt player for a stay proportional to the missing health", async () => {
    // 40 missing HP × the 30s/HP default = a 1200s stay.
    await db.update(playerStats).set({ health: 60 }).where(eq(playerStats.playerId, playerId));

    const res = await app.inject({ method: "POST", url: "/api/hospital/checkin", headers: auth() });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hospitalised).toBe(true);
    expect(body.remainingSeconds).toBeGreaterThan(1190);
    expect(body.remainingSeconds).toBeLessThanOrEqual(1200);
    // Health goes to 0 for the duration — the stay is the heal, not a shortcut.
    expect(body.health).toBe(0);

    const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(row?.health).toBe(0);
    expect(row?.hospitalUntil).not.toBeNull();
  });

  it("409s a player who is already in hospital", async () => {
    await db.update(playerStats)
      .set({ health: 0, hospitalUntil: new Date(Date.now() + 60_000) })
      .where(eq(playerStats.playerId, playerId));

    const res = await app.inject({ method: "POST", url: "/api/hospital/checkin", headers: auth() });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "already_hospitalised" });
  });

  it("is allowed while jailed and does not shorten the jail sentence", async () => {
    const jailedUntil = new Date(Date.now() + 600_000);
    await db.update(playerStats)
      .set({ health: 90, jailedUntil })
      .where(eq(playerStats.playerId, playerId));

    const res = await app.inject({ method: "POST", url: "/api/hospital/checkin", headers: auth() });
    expect(res.statusCode).toBe(200);

    const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(row?.jailedUntil?.getTime()).toBe(jailedUntil.getTime());
  });

  it("quotes a discharge price for the stay it just created", async () => {
    await db.update(playerStats).set({ health: 99 }).where(eq(playerStats.playerId, playerId));
    const res = await app.inject({ method: "POST", url: "/api/hospital/checkin", headers: auth() });
    // 1 missing HP × 30s × the 1000/second discharge default = 30,000.
    expect(BigInt(res.json().dischargeCost)).toBeGreaterThan(29_000n);
    expect(BigInt(res.json().dischargeCost)).toBeLessThanOrEqual(30_000n);
  });
});
```

- [ ] **Step 2: Register the file and run it to verify it fails**

Add `"test/hospital-checkin.test.ts",` to the `@gl3/server` project's `include` in `vitest.workspace.ts`, next to `"test/hospital.test.ts"`.

Run: `npx vitest run --project '@gl3/server' test/hospital-checkin.test.ts`
Expected: FAIL — every case returns 404 because the route does not exist.

- [ ] **Step 3: Implement the route**

In `apps/server/src/game/hospital/routes.ts`, add inside `registerHospitalRoutes`, after the discharge route:

```ts
  /**
   * The voluntary door. Free — the stay itself is the price, because a
   * hospitalised player is gated out of crimes, combat and travel for its
   * whole length. Paying to leave early is the existing discharge route, so a
   * player can check in and then buy out; that is intended, and it costs
   * strictly more than waiting.
   */
  app.post("/api/hospital/checkin", { preHandler: requireAuth }, async (request, reply) => {
    const playerId = request.playerId;
    if (!playerId) return reply.code(401).send({ error: "unauthorized" });

    const result = await db.transaction(async (tx) => {
      // First statement, before any read: the same check-then-act hazard the
      // discharge route documents. Without it two concurrent check-ins both
      // read "not hospitalised" and the second overwrites the first's
      // deadline with one computed from health 0 — a maximal stay.
      await lockPlayersForUpdate(tx, [playerId]);
      const settled = await settleHospital(tx, playerId);
      if (settled.hospitalised) return { kind: "already" as const };

      const [row] = await tx.select({ health: playerStats.health })
        .from(playerStats).where(eq(playerStats.playerId, playerId));
      const health = row?.health ?? 0;
      const maxHealth = await maxHealthFor(tx, playerId);
      const missing = maxHealth - health;
      if (missing <= 0) return { kind: "healthy" as const };

      const seconds = missing * checkinSecondsPerHp(settings);
      const until = await sendToHospital(tx, playerId, seconds);
      return { kind: "admitted" as const, until, seconds, maxHealth };
    });

    if (result.kind === "already") return reply.code(409).send({ error: "already_hospitalised" });
    if (result.kind === "healthy") return reply.code(409).send({ error: "not_injured" });

    return reply.send({
      health: 0,
      maxHealth: result.maxHealth,
      hospitalised: true,
      until: result.until.toISOString(),
      remainingSeconds: result.seconds,
      dischargeCost: (BigInt(result.seconds) * dischargeCostPerSecond(settings)).toString(),
    });
  });
```

Add `checkinSecondsPerHp` to the `./settings.js` import and `sendToHospital` to the `./status.js` import.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --project '@gl3/server' test/hospital-checkin.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/game/hospital/routes.ts apps/server/test/hospital-checkin.test.ts vitest.workspace.ts
git commit -m "feat(hospital): let a hurt player check themselves in"
```

---

### Task 4: Local rosters — `GET /api/hospital/local` and `GET /api/jail/local`

**Files:**
- Create: `apps/server/src/game/roster.ts`
- Modify: `apps/server/src/game/hospital/routes.ts`
- Modify: `apps/server/src/game/jail/routes.ts`
- Modify: `apps/server/src/app.ts:74` (jail registration gains `settings`)
- Modify: `vitest.workspace.ts`
- Test: `apps/server/test/facility-rosters.test.ts`

**Interfaces:**
- Consumes: `dischargeCostPerSecond` (Task 1), `bailCostPerSecond` (Task 1).
- Produces: `listSentencedAtLocation(db, { viewerId, facility })` returning `Array<{ playerId, username, rankName, until, remainingSeconds }>` where `facility` is `"hospital" | "jail"`; the two GET routes.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/facility-rosters.test.ts`:

```ts
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { locations, playerStats } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let closeServer: () => Promise<void>;

interface Player { token: string; playerId: string }

async function register(name: string): Promise<Player> {
  const res = await app.inject({
    method: "POST", url: "/api/auth/register",
    payload: { username: `${name}${Date.now()}${Math.floor(Math.random() * 1000)}`, password: "hunter2hunter2" },
  });
  const body = res.json();
  return { token: body.token, playerId: body.playerId };
}

let townA: string;
let townB: string;

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer } = await bootTestServer());
  townA = uuidv7();
  townB = uuidv7();
  await db.insert(locations).values([
    { id: townA, name: `Town A ${townA.slice(0, 8)}` },
    { id: townB, name: `Town B ${townB.slice(0, 8)}` },
  ]);
});
afterAll(async () => { await closeServer(); await conn.end(); });

const auth = (p: Player) => ({ authorization: `Bearer ${p.token}` });

async function place(p: Player, locationId: string | null, patch: Record<string, unknown> = {}): Promise<void> {
  await db.update(playerStats).set({ locationId, ...patch }).where(eq(playerStats.playerId, p.playerId));
}

describe("GET /api/hospital/local", () => {
  it("lists a patient in the same town, and never the caller", async () => {
    const viewer = await register("Viewer");
    const patient = await register("Patient");
    await place(viewer, townA);
    await place(patient, townA, { health: 0, hospitalUntil: new Date(Date.now() + 120_000) });
    // The caller is hospitalised too — they must still not appear in their own list.
    await place(viewer, townA, { health: 0, hospitalUntil: new Date(Date.now() + 120_000) });

    const res = await app.inject({ method: "GET", url: "/api/hospital/local", headers: auth(viewer) });

    expect(res.statusCode).toBe(200);
    const { patients } = res.json();
    expect(patients).toHaveLength(1);
    expect(patients[0].playerId).toBe(patient.playerId);
    expect(patients[0].remainingSeconds).toBeGreaterThan(110);
    // 120s × the 1000/second default.
    expect(BigInt(patients[0].dischargeCost)).toBeGreaterThan(110_000n);
  });

  it("does not list a patient in another town", async () => {
    const viewer = await register("Viewer");
    const patient = await register("Patient");
    await place(viewer, townA);
    await place(patient, townB, { health: 0, hospitalUntil: new Date(Date.now() + 120_000) });

    const res = await app.inject({ method: "GET", url: "/api/hospital/local", headers: auth(viewer) });
    expect(res.json().patients).toHaveLength(0);
  });

  it("filters out an elapsed stay without settling it", async () => {
    const viewer = await register("Viewer");
    const patient = await register("Patient");
    await place(viewer, townA);
    await place(patient, townA, { health: 0, hospitalUntil: new Date(Date.now() - 1000) });

    const res = await app.inject({ method: "GET", url: "/api/hospital/local", headers: auth(viewer) });
    expect(res.json().patients).toHaveLength(0);

    // A roster read must not take write locks on strangers: the row is still
    // dirty, and the sweeper or the patient's own next request clears it.
    const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, patient.playerId));
    expect(row?.hospitalUntil).not.toBeNull();
  });

  it("answers an empty list for a caller with no location", async () => {
    const viewer = await register("Viewer");
    const patient = await register("Patient");
    await place(viewer, null);
    await place(patient, townA, { health: 0, hospitalUntil: new Date(Date.now() + 120_000) });

    const res = await app.inject({ method: "GET", url: "/api/hospital/local", headers: auth(viewer) });
    expect(res.statusCode).toBe(200);
    expect(res.json().patients).toHaveLength(0);
  });
});

describe("GET /api/jail/local", () => {
  it("lists a local inmate with a bail price and excludes other towns", async () => {
    const viewer = await register("Viewer");
    const inmate = await register("Inmate");
    const elsewhere = await register("Elsewhere");
    await place(viewer, townA);
    await place(inmate, townA, { jailedUntil: new Date(Date.now() + 300_000) });
    await place(elsewhere, townB, { jailedUntil: new Date(Date.now() + 300_000) });

    const res = await app.inject({ method: "GET", url: "/api/jail/local", headers: auth(viewer) });

    expect(res.statusCode).toBe(200);
    const { inmates } = res.json();
    expect(inmates).toHaveLength(1);
    expect(inmates[0].playerId).toBe(inmate.playerId);
    expect(BigInt(inmates[0].bailCost)).toBeGreaterThan(290_000n);
    expect(inmates[0].rankName).toEqual(expect.any(String));
  });
});
```

- [ ] **Step 2: Register the file and run it to verify it fails**

Add `"test/facility-rosters.test.ts",` to the `@gl3/server` project's `include`.

Run: `npx vitest run --project '@gl3/server' test/facility-rosters.test.ts`
Expected: FAIL — 404 on both routes.

- [ ] **Step 3: Write the shared query**

Create `apps/server/src/game/roster.ts`:

```ts
import { and, asc, eq, gt, ne } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { players, playerStats, ranks } from "../db/schema/index.js";

export type Facility = "hospital" | "jail";

export interface RosterEntry {
  playerId: string;
  username: string;
  rankName: string;
  until: string;
  remainingSeconds: number;
}

/** Mirrors `ranks.max_health`'s own fallback shape: a player may have no rank row. */
const UNRANKED = "Unranked";

/**
 * Everyone serving a live sentence in the caller's own town, caller excluded.
 *
 * Read-only by design — it settles nothing. An elapsed sentence is filtered
 * out by the `> now()` predicate and left for the sweeper or the sentenced
 * player's own next request; a roster read must never take write locks on
 * strangers, which is what would happen if it called `settleHospital` per row.
 *
 * A caller standing nowhere (`location_id IS NULL`) sees an empty list rather
 * than an error — a fresh account before its first travel is in that state.
 */
export async function listSentencedAtLocation(
  db: Db, viewerId: string, facility: Facility,
): Promise<RosterEntry[]> {
  const [viewer] = await db.select({ locationId: playerStats.locationId })
    .from(playerStats).where(eq(playerStats.playerId, viewerId));
  const locationId = viewer?.locationId ?? null;
  if (locationId === null) return [];

  const column = facility === "hospital" ? playerStats.hospitalUntil : playerStats.jailedUntil;
  const now = new Date();

  const rows = await db.select({
    playerId: playerStats.playerId,
    username: players.username,
    rankName: ranks.name,
    until: column,
  })
    .from(playerStats)
    .innerJoin(players, eq(players.id, playerStats.playerId))
    .leftJoin(ranks, eq(ranks.id, playerStats.rankId))
    .where(and(
      eq(playerStats.locationId, locationId),
      ne(playerStats.playerId, viewerId),
      gt(column, now),
    ))
    .orderBy(asc(column));

  return rows.map((row) => ({
    playerId: row.playerId,
    username: row.username,
    rankName: row.rankName ?? UNRANKED,
    until: (row.until as Date).toISOString(),
    remainingSeconds: Math.max(0, Math.ceil(((row.until as Date).getTime() - Date.now()) / 1000)),
  }));
}
```

- [ ] **Step 4: Add both routes**

In `apps/server/src/game/hospital/routes.ts`:

```ts
  app.get("/api/hospital/local", { preHandler: requireAuth }, async (request, reply) => {
    const playerId = request.playerId;
    if (!playerId) return reply.code(401).send({ error: "unauthorized" });

    const rows = await listSentencedAtLocation(db, playerId, "hospital");
    const rate = dischargeCostPerSecond(settings);
    return reply.send({
      patients: rows.map((row) => ({
        ...row,
        dischargeCost: (BigInt(row.remainingSeconds) * rate).toString(),
      })),
    });
  });
```

In `apps/server/src/game/jail/routes.ts`, change the signature to
`registerJailRoutes(app, db, redis, settings: Record<string, string>, requireAuth)` and add:

```ts
  app.get("/api/jail/local", { preHandler: requireAuth }, async (request, reply) => {
    const playerId = request.playerId;
    if (!playerId) return reply.code(401).send({ error: "unauthorized" });

    const rows = await listSentencedAtLocation(db, playerId, "jail");
    const rate = bailCostPerSecond(settings);
    return reply.send({
      inmates: rows.map((row) => ({
        ...row,
        bailCost: (BigInt(row.remainingSeconds) * rate).toString(),
      })),
    });
  });
```

In `apps/server/src/app.ts:74`, change the call to:

```ts
  registerJailRoutes(app, deps.db, deps.redis, loadedSettings, requireAuth);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run --project '@gl3/server' test/facility-rosters.test.ts test/jail.test.ts`
Expected: PASS — the existing `jail.test.ts` proves the registration-signature change did not break `GET /api/jail`.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/game/roster.ts apps/server/src/game/hospital/routes.ts \
  apps/server/src/game/jail/routes.ts apps/server/src/app.ts \
  apps/server/test/facility-rosters.test.ts vitest.workspace.ts
git commit -m "feat(facilities): local hospital and jail rosters"
```

---

### Task 5: `POST /api/hospital/discharge-player`

**Files:**
- Modify: `apps/server/src/game/hospital/routes.ts` (gains a `redis` parameter)
- Modify: `apps/server/src/app.ts:75`
- Modify: `vitest.workspace.ts`
- Test: `apps/server/test/hospital-discharge-player.test.ts`

**Interfaces:**
- Consumes: `listSentencedAtLocation` is NOT used here — the route re-reads the target under lock. `applyBalanceChange`, `lockPlayersForUpdate`, `InsufficientFundsError` from `../../economy/ledger.js`; `maxHealthFor` from `./status.js`; `insertNotification` from `../notifications/service.js`; `publishEvent` from `../../bus/publish.js`.
- Produces: `POST /api/hospital/discharge-player`, body `{ playerId: string }` → 200 `{ freed, paid, cash }`.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/hospital-discharge-player.test.ts`. Reuse the `register` / `place` helpers written in Task 4's test file verbatim (copy them — the two files are independent):

```ts
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { locations, playerStats, transactions } from "../src/db/schema/index.js";
import { applyBalanceChange } from "../src/economy/ledger.js";
import { resetDb, testDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let closeServer: () => Promise<void>;
let townA: string;
let townB: string;

interface Player { token: string; playerId: string }

async function register(name: string): Promise<Player> {
  const res = await app.inject({
    method: "POST", url: "/api/auth/register",
    payload: { username: `${name}${Date.now()}${Math.floor(Math.random() * 1000)}`, password: "hunter2hunter2" },
  });
  const body = res.json();
  return { token: body.token, playerId: body.playerId };
}

async function place(p: Player, locationId: string | null, patch: Record<string, unknown> = {}): Promise<void> {
  await db.update(playerStats).set({ locationId, ...patch }).where(eq(playerStats.playerId, p.playerId));
}

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer } = await bootTestServer());
  townA = uuidv7();
  townB = uuidv7();
  await db.insert(locations).values([
    { id: townA, name: `Town A ${townA.slice(0, 8)}` },
    { id: townB, name: `Town B ${townB.slice(0, 8)}` },
  ]);
});
afterAll(async () => { await closeServer(); await conn.end(); });

const auth = (p: Player) => ({ authorization: `Bearer ${p.token}` });
const post = (p: Player, body: unknown) => app.inject({
  method: "POST", url: "/api/hospital/discharge-player", headers: auth(p), payload: body,
});

describe("POST /api/hospital/discharge-player", () => {
  it("pays for a local patient, heals them, and debits only the payer", async () => {
    const payer = await register("Payer");
    const patient = await register("Patient");
    await place(payer, townA);
    await place(patient, townA, { health: 0, hospitalUntil: new Date(Date.now() + 60_000) });
    await db.transaction((tx) => applyBalanceChange(tx, {
      playerId: payer.playerId, amount: 500_000n, kind: "cash", reason: "test.seed",
    }));
    const [before] = await db.select().from(playerStats).where(eq(playerStats.playerId, patient.playerId));

    const res = await post(payer, { playerId: patient.playerId });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.freed).toBe(patient.playerId);
    expect(BigInt(body.paid)).toBeGreaterThan(0n);

    const [target] = await db.select().from(playerStats).where(eq(playerStats.playerId, patient.playerId));
    expect(target?.hospitalUntil).toBeNull();
    expect(target?.health).toBe(100);
    expect(target?.cash).toBe(before?.cash);

    const [payerRow] = await db.select().from(playerStats).where(eq(playerStats.playerId, payer.playerId));
    expect(payerRow?.cash).toBe(500_000n - BigInt(body.paid));

    const ledger = await db.select().from(transactions).where(eq(transactions.playerId, payer.playerId));
    expect(ledger.filter((t) => t.reason === "hospital.discharge")).toHaveLength(1);
    const sum = ledger.reduce((acc, t) => acc + (t.balanceKind === "cash" ? t.amount : 0n), 0n);
    expect(sum).toBe(payerRow?.cash);
  });

  it("409s a patient in another town", async () => {
    const payer = await register("Payer");
    const patient = await register("Patient");
    await place(payer, townA, { cash: 5_000_000n });
    await place(patient, townB, { health: 0, hospitalUntil: new Date(Date.now() + 60_000) });

    const res = await post(payer, { playerId: patient.playerId });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "wrong_location" });
  });

  it("409s a target who is not in hospital", async () => {
    const payer = await register("Payer");
    const other = await register("Other");
    await place(payer, townA, { cash: 5_000_000n });
    await place(other, townA);

    const res = await post(payer, { playerId: other.playerId });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "not_hospitalised" });
  });

  it("409s paying for yourself", async () => {
    const payer = await register("Payer");
    await place(payer, townA, { cash: 5_000_000n, health: 0, hospitalUntil: new Date(Date.now() + 60_000) });

    const res = await post(payer, { playerId: payer.playerId });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "self_target" });
  });

  it("409s when the payer cannot afford it", async () => {
    const payer = await register("Payer");
    const patient = await register("Patient");
    await place(payer, townA, { cash: 1n });
    await place(patient, townA, { health: 0, hospitalUntil: new Date(Date.now() + 600_000) });

    const res = await post(payer, { playerId: patient.playerId });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "insufficient_funds" });
  });

  it("404s an unknown player and 400s a malformed body", async () => {
    const payer = await register("Payer");
    await place(payer, townA, { cash: 5_000_000n });

    expect((await post(payer, { playerId: uuidv7() })).statusCode).toBe(404);
    expect((await post(payer, { playerId: "not-a-uuid" })).statusCode).toBe(400);
    expect((await post(payer, {})).statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Register the file and run it to verify it fails**

Add `"test/hospital-discharge-player.test.ts",` to the `@gl3/server` include list.

Run: `npx vitest run --project '@gl3/server' test/hospital-discharge-player.test.ts`
Expected: FAIL — 404 on the route.

- [ ] **Step 3: Implement the route**

Change the signature to
`registerHospitalRoutes(app, db, redis: Redis, settings, requireAuth)` (import `type { Redis } from "ioredis"`), update `apps/server/src/app.ts:75` to
`registerHospitalRoutes(app, deps.db, deps.redis, loadedSettings, requireAuth);`, and add:

```ts
const TargetBodySchema = z.object({ playerId: z.string().uuid() });

  /**
   * Pay a stranger out of the ward. Money moves from the CALLER; the target
   * is healed and never debited.
   */
  app.post("/api/hospital/discharge-player", { preHandler: requireAuth }, async (request, reply) => {
    const playerId = request.playerId;
    if (!playerId) return reply.code(401).send({ error: "unauthorized" });

    const parsed = TargetBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    const targetId = parsed.data.playerId;
    if (targetId === playerId) return reply.code(409).send({ error: "self_target" });

    try {
      const result = await db.transaction(async (tx) => {
        // ONE sorted call over both players, FIRST statement, before either row
        // is read (CLAUDE.md rule 6). Two separate calls, or a read before the
        // lock, is the double-charge in test/facility-concurrency.test.ts.
        await lockPlayersForUpdate(tx, [playerId, targetId]);

        const [caller] = await tx.select({ locationId: playerStats.locationId })
          .from(playerStats).where(eq(playerStats.playerId, playerId));
        const [target] = await tx.select({
          locationId: playerStats.locationId,
          hospitalUntil: playerStats.hospitalUntil,
          username: players.username,
        })
          .from(playerStats)
          .innerJoin(players, eq(players.id, playerStats.playerId))
          .where(eq(playerStats.playerId, targetId));

        if (!target) return { kind: "missing" as const };
        if (target.locationId === null || target.locationId !== caller?.locationId) {
          return { kind: "elsewhere" as const };
        }

        const remainingMs = (target.hospitalUntil?.getTime() ?? 0) - Date.now();
        if (remainingMs <= 0) return { kind: "free" as const };
        const remainingSeconds = Math.ceil(remainingMs / 1000);

        const cost = BigInt(remainingSeconds) * dischargeCostPerSecond(settings);
        const cash = await applyBalanceChange(tx, {
          playerId, amount: -cost, kind: "cash", reason: "hospital.discharge",
        });

        const maxHealth = await maxHealthFor(tx, targetId);
        await tx.update(playerStats)
          .set({ hospitalUntil: null, health: maxHealth })
          .where(eq(playerStats.playerId, targetId));

        const notificationId = uuidv7();
        await insertNotification(tx, {
          id: notificationId, playerId: targetId,
          body: `${request.username ?? "Someone"} paid for your discharge.`,
        });

        return {
          kind: "paid" as const, cash, cost, notificationId,
          targetName: target.username,
        };
      });

      if (result.kind === "missing") return reply.code(404).send({ error: "player_not_found" });
      if (result.kind === "elsewhere") return reply.code(409).send({ error: "wrong_location" });
      if (result.kind === "free") return reply.code(409).send({ error: "not_hospitalised" });

      // After commit, never inside the transaction (CLAUDE.md rule 5).
      // Both events are addressed to the TARGET and carry the target as actor:
      // `player.discharged` is what the web client's invalidation keys off, and
      // `notification.created`'s actor is the recipient by convention.
      const at = new Date().toISOString();
      await publishEvent(redis, {
        id: uuidv7(), type: "player.discharged", at,
        actorId: targetId, actorName: result.targetName,
        audience: { kind: "player", playerId: targetId },
      });
      await publishEvent(redis, {
        id: uuidv7(), type: "notification.created", at,
        actorId: targetId, actorName: result.targetName,
        audience: { kind: "player", playerId: targetId },
        notificationId: result.notificationId,
        body: "Someone paid for your discharge.",
      });

      return reply.send({
        freed: targetId,
        paid: result.cost.toString(),
        cash: result.cash.toString(),
      });
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        return reply.code(409).send({ error: "insufficient_funds" });
      }
      throw error;
    }
  });
```

Add the imports this needs: `z` from `zod`, `uuidv7` from `uuidv7`, `players` from the schema barrel, `publishEvent` from `../../bus/publish.js`, `insertNotification` from `../notifications/service.js`.

If `request.username` is not a field this codebase populates, use the caller's username from a `players` select inside the transaction instead — check `apps/server/src/plugins/routes.ts` for what the auth decorator actually attaches, and match it. Do not invent a field.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --project '@gl3/server' test/hospital-discharge-player.test.ts test/hospital.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/game/hospital/routes.ts apps/server/src/app.ts \
  apps/server/test/hospital-discharge-player.test.ts vitest.workspace.ts
git commit -m "feat(hospital): pay another patient out of the ward"
```

---

### Task 6: `POST /api/jail/bail`

**Files:**
- Modify: `apps/server/src/game/jail/routes.ts`
- Modify: `vitest.workspace.ts`
- Test: `apps/server/test/jail-bail-bust.test.ts` (bail cases only; Task 7 adds the bust cases to the same file)

**Interfaces:**
- Consumes: `bailCostPerSecond` (Task 1); ledger helpers; `insertNotification`; `publishEvent`.
- Produces: `POST /api/jail/bail`, body `{ playerId }` → 200 `{ freed, paid, cash }`; errors `self_target`, `wrong_location`, `not_jailed`, `insufficient_funds`, 404 `player_not_found`, 400 `invalid_body`.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/jail-bail-bust.test.ts` with the same `register` / `place` / town scaffolding as Task 5's file, plus:

```ts
describe("POST /api/jail/bail", () => {
  it("frees a local inmate and charges the payer", async () => {
    const payer = await register("Payer");
    const inmate = await register("Inmate");
    await place(payer, townA);
    await place(inmate, townA, { jailedUntil: new Date(Date.now() + 60_000) });
    await db.transaction((tx) => applyBalanceChange(tx, {
      playerId: payer.playerId, amount: 500_000n, kind: "cash", reason: "test.seed",
    }));

    const res = await app.inject({
      method: "POST", url: "/api/jail/bail", headers: auth(payer),
      payload: { playerId: inmate.playerId },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.freed).toBe(inmate.playerId);

    const [target] = await db.select().from(playerStats).where(eq(playerStats.playerId, inmate.playerId));
    expect(target?.jailedUntil).toBeNull();

    const ledger = await db.select().from(transactions).where(eq(transactions.playerId, payer.playerId));
    expect(ledger.filter((t) => t.reason === "jail.bail")).toHaveLength(1);
  });

  it("409s an inmate in another town, a free player, and yourself", async () => {
    const payer = await register("Payer");
    const far = await register("Far");
    const free = await register("Free");
    await place(payer, townA, { cash: 5_000_000n, jailedUntil: new Date(Date.now() + 60_000) });
    await place(far, townB, { jailedUntil: new Date(Date.now() + 60_000) });
    await place(free, townA);

    const bail = (targetId: string) => app.inject({
      method: "POST", url: "/api/jail/bail", headers: auth(payer), payload: { playerId: targetId },
    });

    expect((await bail(far.playerId)).json()).toMatchObject({ error: "wrong_location" });
    expect((await bail(free.playerId)).json()).toMatchObject({ error: "not_jailed" });
    expect((await bail(payer.playerId)).json()).toMatchObject({ error: "self_target" });
  });

  it("409s when the payer cannot afford it and 400s a malformed body", async () => {
    const payer = await register("Payer");
    const inmate = await register("Inmate");
    await place(payer, townA, { cash: 1n });
    await place(inmate, townA, { jailedUntil: new Date(Date.now() + 600_000) });

    const res = await app.inject({
      method: "POST", url: "/api/jail/bail", headers: auth(payer),
      payload: { playerId: inmate.playerId },
    });
    expect(res.json()).toMatchObject({ error: "insufficient_funds" });

    const bad = await app.inject({
      method: "POST", url: "/api/jail/bail", headers: auth(payer), payload: { playerId: "nope" },
    });
    expect(bad.statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Register the file and run it to verify it fails**

Add `"test/jail-bail-bust.test.ts",` to the `@gl3/server` include list.

Run: `npx vitest run --project '@gl3/server' test/jail-bail-bust.test.ts`
Expected: FAIL — 404 on `/api/jail/bail`.

- [ ] **Step 3: Implement the route**

In `apps/server/src/game/jail/routes.ts`:

```ts
const TargetBodySchema = z.object({ playerId: z.string().uuid() });

  app.post("/api/jail/bail", { preHandler: requireAuth }, async (request, reply) => {
    const playerId = request.playerId;
    if (!playerId) return reply.code(401).send({ error: "unauthorized" });

    const parsed = TargetBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    const targetId = parsed.data.playerId;
    if (targetId === playerId) return reply.code(409).send({ error: "self_target" });

    try {
      const result = await db.transaction(async (tx) => {
        // One sorted call over both players, first statement (rule 6). The
        // re-read below is what makes the loser of two concurrent bails 409
        // instead of paying a second time.
        await lockPlayersForUpdate(tx, [playerId, targetId]);

        const [caller] = await tx.select({ locationId: playerStats.locationId })
          .from(playerStats).where(eq(playerStats.playerId, playerId));
        const [target] = await tx.select({
          locationId: playerStats.locationId,
          jailedUntil: playerStats.jailedUntil,
          username: players.username,
        })
          .from(playerStats)
          .innerJoin(players, eq(players.id, playerStats.playerId))
          .where(eq(playerStats.playerId, targetId));

        if (!target) return { kind: "missing" as const };
        if (target.locationId === null || target.locationId !== caller?.locationId) {
          return { kind: "elsewhere" as const };
        }

        const remainingMs = (target.jailedUntil?.getTime() ?? 0) - Date.now();
        if (remainingMs <= 0) return { kind: "free" as const };

        const cost = BigInt(Math.ceil(remainingMs / 1000)) * bailCostPerSecond(settings);
        const cash = await applyBalanceChange(tx, {
          playerId, amount: -cost, kind: "cash", reason: "jail.bail",
        });

        await tx.update(playerStats)
          .set({ jailedUntil: null })
          .where(eq(playerStats.playerId, targetId));

        const notificationId = uuidv7();
        await insertNotification(tx, {
          id: notificationId, playerId: targetId, body: "Someone paid your bail.",
        });

        return { kind: "paid" as const, cash, cost, notificationId, targetName: target.username };
      });

      if (result.kind === "missing") return reply.code(404).send({ error: "player_not_found" });
      if (result.kind === "elsewhere") return reply.code(409).send({ error: "wrong_location" });
      if (result.kind === "free") return reply.code(409).send({ error: "not_jailed" });

      const at = new Date().toISOString();
      await publishEvent(redis, {
        id: uuidv7(), type: "player.released", at,
        actorId: targetId, actorName: result.targetName,
        audience: { kind: "player", playerId: targetId },
      });
      await publishEvent(redis, {
        id: uuidv7(), type: "notification.created", at,
        actorId: targetId, actorName: result.targetName,
        audience: { kind: "player", playerId: targetId },
        notificationId: result.notificationId, body: "Someone paid your bail.",
      });

      return reply.send({
        freed: targetId, paid: result.cost.toString(), cash: result.cash.toString(),
      });
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        return reply.code(409).send({ error: "insufficient_funds" });
      }
      throw error;
    }
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --project '@gl3/server' test/jail-bail-bust.test.ts test/jail.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/game/jail/routes.ts apps/server/test/jail-bail-bust.test.ts vitest.workspace.ts
git commit -m "feat(jail): bail a local inmate out"
```

---

### Task 7: `POST /api/jail/bust`

**Files:**
- Modify: `apps/server/src/game/jail/routes.ts`
- Test: `apps/server/test/jail-bail-bust.test.ts` (append)

**Interfaces:**
- Consumes: `bustSucceeds`, `bustSuccessPercent`, `bustFailJailSeconds` (Task 1); `sendToJail` from `./status.js`; `newSeed` from `../rng.js`.
- Produces: `POST /api/jail/bust`, body `{ playerId }` → 200 `{ success, jailedUntil }`; errors `self_target`, `already_jailed`, `wrong_location`, `not_jailed`, 404, 400.

- [ ] **Step 1: Write the failing test**

The settings are read at boot, so each branch needs its own app booted against a settings row. Follow the pattern at the bottom of `apps/server/test/hospital.test.ts` (the malformed-setting describe block) for how that file boots a second server against a seeded `settings` row, and append to `jail-bail-bust.test.ts`:

```ts
import { settings as settingsTable } from "../src/db/schema/index.js";

/**
 * `jail.bust_success_percent` is read once at boot, so each branch gets its
 * own app. 100 and 0 make the outcome independent of the draw — the roll
 * itself is unit-tested in facility-settings.test.ts.
 */
async function bootWith(rows: Record<string, string>): Promise<{ app: FastifyInstance; close: () => Promise<void> }> {
  await db.insert(settingsTable)
    .values(Object.entries(rows).map(([key, value]) => ({ key, value })));
  return bootTestServer();
}

describe("POST /api/jail/bust", () => {
  it("frees the target and leaves the caller free when the roll always wins", async () => {
    const own = await bootWith({ "jail.bust_success_percent": "100" });
    try {
      const buster = await registerOn(own.app, "Buster");
      const inmate = await registerOn(own.app, "Inmate");
      await place(buster, townA);
      await place(inmate, townA, { jailedUntil: new Date(Date.now() + 300_000) });

      const res = await own.app.inject({
        method: "POST", url: "/api/jail/bust", headers: auth(buster),
        payload: { playerId: inmate.playerId },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ success: true, jailedUntil: null });

      const [target] = await db.select().from(playerStats).where(eq(playerStats.playerId, inmate.playerId));
      expect(target?.jailedUntil).toBeNull();
      const [caller] = await db.select().from(playerStats).where(eq(playerStats.playerId, buster.playerId));
      expect(caller?.jailedUntil).toBeNull();
    } finally {
      await own.close();
    }
  });

  it("jails the caller and leaves the target in when the roll always loses", async () => {
    const own = await bootWith({ "jail.bust_success_percent": "0", "jail.bust_fail_jail_seconds": "120" });
    try {
      const buster = await registerOn(own.app, "Buster");
      const inmate = await registerOn(own.app, "Inmate");
      await place(buster, townA);
      const inmateUntil = new Date(Date.now() + 300_000);
      await place(inmate, townA, { jailedUntil: inmateUntil });

      const res = await own.app.inject({
        method: "POST", url: "/api/jail/bust", headers: auth(buster),
        payload: { playerId: inmate.playerId },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(false);

      const [target] = await db.select().from(playerStats).where(eq(playerStats.playerId, inmate.playerId));
      expect(target?.jailedUntil?.getTime()).toBe(inmateUntil.getTime());

      const [caller] = await db.select().from(playerStats).where(eq(playerStats.playerId, buster.playerId));
      const callerSeconds = Math.round(((caller?.jailedUntil?.getTime() ?? 0) - Date.now()) / 1000);
      expect(callerSeconds).toBeGreaterThan(110);
      expect(callerSeconds).toBeLessThanOrEqual(120);
    } finally {
      await own.close();
    }
  });

  it("refuses a jailed caller, another town, a free target, and yourself", async () => {
    const jailed = await register("Jailed");
    const inmate = await register("Inmate");
    const far = await register("Far");
    const free = await register("Free");
    await place(jailed, townA, { jailedUntil: new Date(Date.now() + 300_000) });
    await place(inmate, townA, { jailedUntil: new Date(Date.now() + 300_000) });
    await place(far, townB, { jailedUntil: new Date(Date.now() + 300_000) });
    await place(free, townA);

    const bust = (caller: Player, targetId: string) => app.inject({
      method: "POST", url: "/api/jail/bust", headers: auth(caller), payload: { playerId: targetId },
    });

    // A prisoner cannot bust anyone.
    expect((await bust(jailed, inmate.playerId)).json()).toMatchObject({ error: "already_jailed" });

    const freeCaller = await register("FreeCaller");
    await place(freeCaller, townA);
    expect((await bust(freeCaller, far.playerId)).json()).toMatchObject({ error: "wrong_location" });
    expect((await bust(freeCaller, free.playerId)).json()).toMatchObject({ error: "not_jailed" });
    expect((await bust(freeCaller, freeCaller.playerId)).json()).toMatchObject({ error: "self_target" });
  });
});
```

Add a `registerOn(app, name)` helper alongside `register` in this file — identical body, but taking the Fastify instance as its first argument, so the two custom-settings apps can register their own players.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project '@gl3/server' test/jail-bail-bust.test.ts`
Expected: FAIL — the three bust cases 404.

- [ ] **Step 3: Implement the route**

In `apps/server/src/game/jail/routes.ts`:

```ts
  /**
   * Free to attempt. The failure branch — the caller doing the target's kind
   * of time — is the whole cost, which is why there is no price and no
   * cooldown. The seed is generated here and never accepted from the client:
   * a client-chosen seed is a client-chosen outcome.
   */
  app.post("/api/jail/bust", { preHandler: requireAuth }, async (request, reply) => {
    const playerId = request.playerId;
    if (!playerId) return reply.code(401).send({ error: "unauthorized" });

    const parsed = TargetBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    const targetId = parsed.data.playerId;
    if (targetId === playerId) return reply.code(409).send({ error: "self_target" });

    const result = await db.transaction(async (tx) => {
      await lockPlayersForUpdate(tx, [playerId, targetId]);

      const [caller] = await tx.select({
        locationId: playerStats.locationId, jailedUntil: playerStats.jailedUntil,
        username: players.username,
      })
        .from(playerStats)
        .innerJoin(players, eq(players.id, playerStats.playerId))
        .where(eq(playerStats.playerId, playerId));
      if (caller && (caller.jailedUntil?.getTime() ?? 0) > Date.now()) {
        return { kind: "caller_jailed" as const };
      }

      const [target] = await tx.select({
        locationId: playerStats.locationId, jailedUntil: playerStats.jailedUntil,
        username: players.username,
      })
        .from(playerStats)
        .innerJoin(players, eq(players.id, playerStats.playerId))
        .where(eq(playerStats.playerId, targetId));

      if (!target) return { kind: "missing" as const };
      if (target.locationId === null || target.locationId !== caller?.locationId) {
        return { kind: "elsewhere" as const };
      }
      if ((target.jailedUntil?.getTime() ?? 0) <= Date.now()) return { kind: "free" as const };

      if (!bustSucceeds(newSeed(), bustSuccessPercent(settings))) {
        const until = await sendToJail(tx, playerId, bustFailJailSeconds(settings));
        return { kind: "failed" as const, until, callerName: caller?.username ?? "unknown" };
      }

      await tx.update(playerStats)
        .set({ jailedUntil: null })
        .where(eq(playerStats.playerId, targetId));

      const notificationId = uuidv7();
      await insertNotification(tx, {
        id: notificationId, playerId: targetId, body: "Someone busted you out.",
      });
      return { kind: "busted" as const, notificationId, targetName: target.username };
    });

    if (result.kind === "missing") return reply.code(404).send({ error: "player_not_found" });
    if (result.kind === "elsewhere") return reply.code(409).send({ error: "wrong_location" });
    if (result.kind === "free") return reply.code(409).send({ error: "not_jailed" });
    if (result.kind === "caller_jailed") return reply.code(409).send({ error: "already_jailed" });

    const at = new Date().toISOString();
    if (result.kind === "failed") {
      await publishEvent(redis, {
        id: uuidv7(), type: "player.jailed", at,
        actorId: playerId, actorName: result.callerName,
        audience: { kind: "player", playerId },
        until: result.until.toISOString(), reason: "bust_failed",
      });
      return reply.send({ success: false, jailedUntil: result.until.toISOString() });
    }

    await publishEvent(redis, {
      id: uuidv7(), type: "player.released", at,
      actorId: targetId, actorName: result.targetName,
      audience: { kind: "player", playerId: targetId },
    });
    await publishEvent(redis, {
      id: uuidv7(), type: "notification.created", at,
      actorId: targetId, actorName: result.targetName,
      audience: { kind: "player", playerId: targetId },
      notificationId: result.notificationId, body: "Someone busted you out.",
    });
    return reply.send({ success: true, jailedUntil: null });
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --project '@gl3/server' test/jail-bail-bust.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/game/jail/routes.ts apps/server/test/jail-bail-bust.test.ts
git commit -m "feat(jail): bust an inmate out, and do their time if it fails"
```

---

### Task 8: The concurrency guard

**Files:**
- Modify: `vitest.workspace.ts`
- Test: `apps/server/test/facility-concurrency.test.ts`

**Interfaces:**
- Consumes: the routes from Tasks 5 and 6.
- Produces: nothing new — this task exists to prove the leading `lockPlayersForUpdate` earns its place.

- [ ] **Step 1: Write the test**

Model it on `apps/server/test/hospital-concurrency.test.ts`, which is in the tree and already solves the hard part: `fire()` (because `app.inject()` is lazy) and `waitForLockWaiters(n)` (because a bare `Promise.all` may not actually overlap). Copy both helpers verbatim.

Create `apps/server/test/facility-concurrency.test.ts` with two cases:

```ts
/**
 * TWO payers, ONE inmate, both bails in flight at once.
 *
 * Without the leading `lockPlayersForUpdate(tx, [caller, target])`, both
 * requests read "jailed", both queue on the ledger's own lock, and both
 * charge: one release, two `jail.bail` rows, twice the money gone.
 * `economy-invariant.test.ts` cannot catch it — both charges are ledgered, so
 * sum(ledger) == balance holds throughout. Only the COUNT gives it away.
 */
it("charges exactly one of two concurrent bails", async () => {
  // ... register payerA, payerB (both funded, both in townA) and one inmate
  // jailed for 600s in townA; block on the inmate row from a third connection,
  // fire() both bails, waitForLockWaiters(2), release the blocker, await both.

  const codes = [resA.statusCode, resB.statusCode].sort();
  expect(codes).toEqual([200, 409]);

  const bailRows = await db.select().from(transactions)
    .where(eq(transactions.reason, "jail.bail"));
  expect(bailRows).toHaveLength(1);
});

it("charges exactly one of two concurrent paid discharges", async () => {
  // Same shape against POST /api/hospital/discharge-player and one patient.
  // Exactly one 200, one 409 not_hospitalised, one hospital.discharge row
  // among the two payers.
});
```

Fill both bodies out completely, following `hospital-concurrency.test.ts`'s
structure (it opens a second `postgres()` connection with `loadConfig()`, holds
`SELECT ... FOR UPDATE` on the contended row, and releases it after
`waitForLockWaiters`).

- [ ] **Step 2: Register the file and run it**

Add `"test/facility-concurrency.test.ts",` to the `@gl3/server` include list.

Run: `npx vitest run --project '@gl3/server' test/facility-concurrency.test.ts`
Expected: PASS.

- [ ] **Step 3: PROVE the test can fail**

A green test that was never seen red proves nothing. Temporarily comment out the `await lockPlayersForUpdate(tx, [playerId, targetId]);` line in **`apps/server/src/game/jail/routes.ts`**'s bail route.

Run: `npx vitest run --project '@gl3/server' test/facility-concurrency.test.ts`
Expected: FAIL — two 200s and two `jail.bail` rows.

Paste the failing output into the commit message body. Then restore the line and re-run:
Expected: PASS.

Repeat the same removal for `discharge-player` in `apps/server/src/game/hospital/routes.ts` and confirm the second case goes red, then restore.

- [ ] **Step 4: Commit**

```bash
git add apps/server/test/facility-concurrency.test.ts vitest.workspace.ts
git commit -m "test(facilities): prove one bail and one discharge per contested target"
```

---

### Task 9: The hospital page

**Files:**
- Modify: `apps/web/src/api/keys.ts`, `apps/web/src/api/queries.ts`, `apps/web/src/lib/errors.ts`, `apps/web/src/pages/Hospital.tsx`

**Interfaces:**
- Consumes: `WardListResponseSchema`, `CheckinResponseSchema` (Task 2); `GET /api/hospital/local`, `POST /api/hospital/checkin`, `POST /api/hospital/discharge-player`.
- Produces: `keys.hospitalLocal()`, `useWard()`, `useCheckin()`, `useDischargePlayer()`.

- [ ] **Step 1: Add the query keys and hooks**

In `apps/web/src/api/keys.ts`, next to `hospital`:

```ts
  hospitalLocal: () => ["hospital", "local"] as const,
```

In `apps/web/src/api/queries.ts`, following `useHospital` / `useDischarge`:

```ts
export function useWard() {
  return useQuery<WardListResponse>({
    queryKey: keys.hospitalLocal(),
    queryFn: async () => WardListResponseSchema.parse(await api("/api/hospital/local")),
    // No poll: the roster is not a countdown the tab must keep honest, and
    // each row carries remainingSeconds for the local tick.
  });
}

export function useCheckin() {
  const queryClient = useQueryClient();
  return useMutation<CheckinResponse, Error, void>({
    mutationFn: async () =>
      CheckinResponseSchema.parse(await api("/api/hospital/checkin", { method: "POST" })),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.hospital() });
      void queryClient.invalidateQueries({ queryKey: keys.hospitalLocal() });
      void queryClient.invalidateQueries({ queryKey: keys.me() });
    },
  });
}

export function useDischargePlayer() {
  const queryClient = useQueryClient();
  return useMutation<{ freed: string; paid: string; cash: string }, Error, string>({
    mutationFn: async (playerId) =>
      (await api("/api/hospital/discharge-player", {
        method: "POST", body: JSON.stringify({ playerId }),
      })) as { freed: string; paid: string; cash: string },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.hospitalLocal() });
      void queryClient.invalidateQueries({ queryKey: keys.me() });
    },
  });
}
```

If other mutations in this file parse their responses through a shared schema, add a `DischargePlayerResponseSchema` to `packages/shared/src/dto/hospital.ts` instead of the inline cast and use it here — match the file's dominant style rather than introducing a second one.

- [ ] **Step 2: Add the error copy**

In `apps/web/src/lib/errors.ts`, next to `not_hospitalised`:

```ts
  not_injured: "You're already at full health.",
  already_hospitalised: "You're already in hospital.",
  already_jailed: "You're in jail yourself.",
  wrong_location: "They're not in this town.",
  self_target: "That's you.",
  not_jailed: "They're not in jail.",
  player_not_found: "No such player.",
  invalid_body: "That request didn't make sense.",
```

- [ ] **Step 3: Extend the page**

In `apps/web/src/pages/Hospital.tsx`:

1. In the not-hospitalised branch, when `status.health < status.maxHealth`, render a check-in panel that states the computed stay **before** the click and names the consequence:

```tsx
<p className={styles.meta}>
  Checking in heals you to {status.maxHealth} but takes you out of crimes,
  combat and travel until the stay ends.
</p>
<button type="button" disabled={checkin.isPending} onClick={() => checkin.mutate()}>
  {checkin.isPending ? "Checking in…" : "Check yourself in"}
</button>
<ErrorText error={checkin.error} />
```

2. Below both branches, render the ward:

```tsx
<Panel title="In this ward">
  {ward.data === undefined ? <Loading what="the ward" /> : null}
  {ward.data?.patients.length === 0 ? (
    <p className={styles.muted}>Nobody else is in this town's hospital.</p>
  ) : null}
  {ward.data?.patients.map((patient) => (
    <div key={patient.playerId} className={styles.row}>
      <span>{patient.username} ({patient.rankName})</span>
      <span>{formatDuration(patient.remainingSeconds)}</span>
      <button
        type="button"
        disabled={dischargePlayer.isPending || !canAfford(cash, patient.dischargeCost)}
        onClick={() => dischargePlayer.mutate(patient.playerId)}
      >
        Pay <Money value={patient.dischargeCost} />
      </button>
    </div>
  ))}
  <ErrorText error={dischargePlayer.error} />
</Panel>
```

Use whatever row class `pages.module.css` already provides for list rows — check the file and reuse; do not add a new class unless none fits.

- [ ] **Step 4: Verify**

Run: `npm run typecheck` and `npx vitest run --project '@gl3/web'`
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): hospital check-in and the local ward list"
```

---

### Task 10: The jail page

**Files:**
- Modify: `apps/web/src/api/keys.ts`, `apps/web/src/api/queries.ts`, `apps/web/src/pages/Jail.tsx`

**Interfaces:**
- Consumes: `CellBlockListResponseSchema`, `BailResponseSchema`, `BustResponseSchema` (Task 2).
- Produces: `keys.jailLocal()`, `useCellBlock()`, `useBail()`, `useBust()`.

- [ ] **Step 1: Add the key and hooks**

`keys.ts`: `jailLocal: () => ["jail", "local"] as const,`

`queries.ts`:

```ts
export function useCellBlock() {
  return useQuery<CellBlockListResponse>({
    queryKey: keys.jailLocal(),
    queryFn: async () => CellBlockListResponseSchema.parse(await api("/api/jail/local")),
  });
}

export function useBail() {
  const queryClient = useQueryClient();
  return useMutation<BailResponse, Error, string>({
    mutationFn: async (playerId) =>
      BailResponseSchema.parse(await api("/api/jail/bail", {
        method: "POST", body: JSON.stringify({ playerId }),
      })),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.jailLocal() });
      void queryClient.invalidateQueries({ queryKey: keys.me() });
    },
  });
}

export function useBust() {
  const queryClient = useQueryClient();
  return useMutation<BustResponse, Error, string>({
    mutationFn: async (playerId) =>
      BustResponseSchema.parse(await api("/api/jail/bust", {
        method: "POST", body: JSON.stringify({ playerId }),
      })),
    onSuccess: () => {
      // A failed bust jails the CLICKER, so the caller's own jail status is
      // part of this mutation's result — invalidate it too.
      void queryClient.invalidateQueries({ queryKey: keys.jailLocal() });
      void queryClient.invalidateQueries({ queryKey: keys.jail() });
      void queryClient.invalidateQueries({ queryKey: keys.me() });
    },
  });
}
```

- [ ] **Step 2: Extend the page**

In `apps/web/src/pages/Jail.tsx`, render both branches (free and jailed) followed by:

```tsx
<Panel title="In this cell block">
  {cellBlock.data?.inmates.length === 0 ? (
    <p className={styles.muted}>Nobody else is doing time in this town.</p>
  ) : null}
  {cellBlock.data?.inmates.map((inmate) => (
    <div key={inmate.playerId} className={styles.row}>
      <span>{inmate.username} ({inmate.rankName})</span>
      <span>{formatDuration(inmate.remainingSeconds)}</span>
      <button
        type="button"
        disabled={bail.isPending || !canAfford(cash, inmate.bailCost)}
        onClick={() => bail.mutate(inmate.playerId)}
      >
        Bail <Money value={inmate.bailCost} />
      </button>
      <button type="button" disabled={bust.isPending} onClick={() => bust.mutate(inmate.playerId)}>
        Bust out
      </button>
    </div>
  ))}
  <p className={styles.muted}>Busting is free, but a failed attempt puts you in the next cell.</p>
  <ErrorText error={bail.error} />
  <ErrorText error={bust.error} />
</Panel>
```

The jailed branch currently returns early — restructure so the self panel and the cell block both render, rather than duplicating the list in two returns.

- [ ] **Step 3: Verify**

Run: `npm run typecheck` and `npx vitest run --project '@gl3/web'`
Expected: both PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): local cell block with bail and bust"
```

---

### Task 11: Documentation and the merge gate

**Files:**
- Modify: `docs/STATUS.md`, `CLAUDE.md`

- [ ] **Step 1: Write the STATUS.md section**

Add a section covering: check-in is the first *voluntary* route into hospital; rosters are location-scoped and settle nothing; the three two-player routes share the combat lock ordering and add no graph edge; no new `GameEvent` variant and why (the four-places tax); the four new settings and their defaults; `@gl3/shared` at 0.1.10 pending publish.

- [ ] **Step 2: Update CLAUDE.md's "Current state"**

One paragraph in the same voice as the surrounding cluster notes. State plainly that this cluster adds **no migration and no new lock-graph edge**, so `schema.test.ts` counts and the lock-order test list are both unchanged.

- [ ] **Step 3: Check for a competing test run before the gate**

```bash
pgrep -fa vitest
psql "$DATABASE_URL" -c "select datname from pg_database where datname like 'gl3_tmpl%'"
```

A run that overlaps another agent's is **void, not failing** — zero assertion failures with files reporting `(0 test)` is cross-talk. If anything is running, wait.

- [ ] **Step 4: Run the full gate, bare**

```bash
export DATABASE_URL=postgres://gl3:gl3@localhost:5432/gl3
export REDIS_URL=redis://localhost:6379
npm run verify
```

Read the **process exit code**, not the summary and not a wrapper's. Do NOT append `; echo "exit=$?"` — that returns `echo`'s status and has already hidden a red suite once. An unhandled rejection makes vitest exit non-zero while still printing all-passed.

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add docs/STATUS.md CLAUDE.md
git commit -m "docs: record hospital check-in and facility rosters"
```

- [ ] **Step 6: Report, do not publish**

Report the suite's file/test counts and the exit code. `@gl3/shared@0.1.10` is **not** published by this plan — publishing to `npm.gl3.dev` needs the user's explicit approval, as every previous bump did.

---

## Self-Review Notes

- **Spec coverage:** §3.1 → Task 3; §3.2/§3.4 → Task 4; §3.3 → Task 5; §3.5 → Task 6; §3.6 → Task 7; §4 → Tasks 5–8 (Task 8 proves it); §5 → Tasks 5–7 (events after commit, no new variant); §6 → Task 1; §7 → Tasks 9–10; §8 → Task 2 (version) and Task 11 (no migration recorded); §9 → Tasks 1, 3–8.
- **Naming consistency:** `dischargeCostPerSecond`, `checkinSecondsPerHp`, `bailCostPerSecond`, `bustSuccessPercent`, `bustFailJailSeconds`, `bustSucceeds`, `listSentencedAtLocation`, `keys.hospitalLocal()`, `keys.jailLocal()` are used with these exact spellings in every task that references them.
- **Known judgement calls left to the implementer, each with an instruction rather than a placeholder:** the caller's username source in Task 5 (check the auth decorator, do not invent a field), the list-row CSS class in Tasks 9–10 (reuse what `pages.module.css` has), and whether `@gl3/shared`'s vitest project globs or enumerates (Task 2, Step 2).
