# Location Combat Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-town `combat_mode` (`open` | `underground`): underground towns hide residents from `GET /api/combat/targets` and refuse `POST /api/combat/attack/:targetId` unless the attacker holds an active detective report on the target.

**Architecture:** One core column (`locations.combat_mode`, migration `0013`), one detectives column (`expires_at`, plugin migration `0002`) plus one read-only exported helper (`activeReportTargetIds`), two combat route changes (attack gate, SQL-filtered targets list), travel listing + admin, one migrate-CLI flag, two web tweaks. Combat gains a dependency on `@gl3/plugin-detectives` — the fifth plugin→plugin edge. No new lock edge anywhere: every new read is a plain SELECT.

**Tech Stack:** TypeScript strict ESM, Fastify, drizzle-orm/Postgres, zod, vitest against real Postgres+Redis.

**Spec:** `docs/superpowers/specs/2026-08-18-location-combat-modes-design.md`

## Global Constraints

- `export DATABASE_URL=postgres://gl3:gl3@localhost:5432/gl3; export REDIS_URL=redis://localhost:6379` before any test run. Task 8 additionally needs `MYSQL_ADMIN_URL` (see `.env.example`).
- Iterate with `npm run test:related -- <files>` or targeted `npx vitest run --project @gl3/server apps/server/test/<file>`; the bare `npm run verify` is the merge gate ONLY (Task 10). Never two full suites at once; check `pgrep -fa vitest` first.
- Read exit codes from the process: `npm run verify > /tmp/verify.log 2>&1; echo done` then `echo $?` on the npm command itself — never `; echo "exit=$?"` appended to the same line you read the summary from, and never through a pipe.
- No `any` in `packages/*`. ESM relative imports carry `.js`. Money is `bigint`; not relevant here (no money moves).
- New `GameEvent` variants: NONE in this cluster (the four-places rule is not triggered).
- Error codes are exact strings: `no_detective_report` (409), `invalid_combat_mode` (400).
- Conventional Commits. Work on branch `feat/location-combat-modes` off `main`.
- A new `apps/server/test/*.test.ts` file MUST be added to `vitest.workspace.ts`'s explicit `include` list or it silently never runs.

---

### Task 0: Branch

- [ ] **Step 1: Create branch**

```bash
cd /home/dlite/GL3 && git checkout -b feat/location-combat-modes main
```

Note: `apps/web/src/plugins/PageRenderer.tsx` may carry an unrelated uncommitted change — leave it untouched, never `git add -A`.

---

### Task 1: Core migration 0013 + drizzle column

**Files:**
- Create: `apps/server/drizzle/0013_location_combat_mode.sql`
- Modify: `apps/server/drizzle/meta/_journal.json` (append entry)
- Modify: `apps/server/src/db/schema/content.ts:27-34` (locations table)
- Test: `apps/server/test/schema.test.ts` (add one column assertion)

**Interfaces:**
- Produces: `locations.combat_mode text NOT NULL DEFAULT 'open' CHECK (combat_mode IN ('open','underground'))`; drizzle column `locations.combatMode` (string). Every later task reads this column.

**Notes:** `schema.test.ts`'s FK census filters `contype = 'f'` and the index census counts non-PK indexes — a CHECK constraint and a defaulted column move NEITHER count. Do not touch the counts. The table-name list at `schema.test.ts:30` already contains `locations`.

- [ ] **Step 1: Write the failing test** — in `apps/server/test/schema.test.ts`, inside the same `describe` as the existing `columnType` assertions (near line 50), add:

```ts
  it("carries the combat mode flag on locations", async () => {
    expect(await columnType("locations", "combat_mode")).toBe("text");
  });
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run --project @gl3/server:db-only apps/server/test/schema.test.ts
```

Expected: the new test FAILS (`undefined` ≠ `"text"`); every pre-existing test passes.

- [ ] **Step 3: Write the migration** — `apps/server/drizzle/0013_location_combat_mode.sql`:

```sql
ALTER TABLE locations ADD COLUMN combat_mode text NOT NULL DEFAULT 'open'
  CHECK (combat_mode IN ('open', 'underground'));
```

Append to the `entries` array in `apps/server/drizzle/meta/_journal.json` (after the `0012_assets` entry):

```json
    {
      "idx": 13,
      "version": "7",
      "when": 1787175600000,
      "tag": "0013_location_combat_mode",
      "breakpoints": true
    }
```

- [ ] **Step 4: Add the drizzle column** — in `apps/server/src/db/schema/content.ts`, extend the `locations` table (after `bulletCost`):

```ts
  combatMode: text("combat_mode").notNull().default("open"),
```

(`text` is already imported in this file.)

- [ ] **Step 5: Run test to verify it passes**

```bash
npx vitest run --project @gl3/server:db-only apps/server/test/schema.test.ts
```

Expected: ALL PASS — including the untouched FK count (37) and index count tests, which proves 0013 adds no FK and no index. The template database is rebuilt from core migrations by `test/helpers/global-setup.ts`, so the new migration applies automatically.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add apps/server/drizzle/0013_location_combat_mode.sql apps/server/drizzle/meta/_journal.json apps/server/src/db/schema/content.ts apps/server/test/schema.test.ts
git commit -m "feat(core): add locations.combat_mode with open default"
```

---

### Task 2: Shared DTOs + version bump

**Files:**
- Modify: `packages/shared/src/dto/combat.ts`
- Modify: `packages/shared/src/dto/travel.ts`
- Modify: `packages/shared/package.json` (version)

**Interfaces:**
- Produces: `CombatModeSchema = z.enum(["open","underground"])` exported from `dto/combat.ts`; `CombatTargetListResponseSchema` gains required `mode`; `LocationDtoSchema` gains required `combatMode`. Tasks 5–7 servers must send these fields; Task 9 web reads them.

**Notes:** No SDK change — `LocationListing` is travel's own interface, `providesProperties`-style manifest surface is untouched. Version: manifest sits at `0.1.12` (drafted by the hospital cluster, NOT yet published; registry serves through `0.1.11` per CLAUDE.md). Bump to `0.1.13`. Publishing is a separate, user-approved act at merge time — do NOT `npm publish` in this plan.

- [ ] **Step 1: Edit `packages/shared/src/dto/combat.ts`** — add after `TargetReasonSchema`:

```ts
/** Per-town combat rule — mirrors core `locations.combat_mode`. */
export const CombatModeSchema = z.enum(["open", "underground"]);
export type CombatMode = z.infer<typeof CombatModeSchema>;
```

and change the list response to:

```ts
export const CombatTargetListResponseSchema = z.object({
  /** `underground` towns list only players the caller holds an active detective report on. */
  mode: CombatModeSchema,
  targets: z.array(CombatTargetSchema),
});
```

- [ ] **Step 2: Edit `packages/shared/src/dto/travel.ts`** — import and add to `LocationDtoSchema` after `bulletStock`:

```ts
import { CombatModeSchema } from "./combat.js";
```

```ts
  combatMode: CombatModeSchema,
```

- [ ] **Step 3: Bump version** — `packages/shared/package.json`: `"version": "0.1.13"`.

- [ ] **Step 4: Run the shared project tests**

```bash
npx vitest run --project @gl3/shared
```

Expected: PASS (the events census is untouched — no new GameEvent).

- [ ] **Step 5: Typecheck — expect FAILURES, record them**

```bash
npm run typecheck
```

Expected: errors in `apps/server`/`packages/plugins` (targets route body now missing `mode`? — no: server routes don't parse shared response schemas) and in `apps/web` where `LocationDto`/targets responses are consumed with the new required fields. If `apps/web` fails on missing `mode`/`combatMode` in mocked fixtures or query typing, note the files — Tasks 5–7 and 9 fix them. If typecheck is fully green, fine — proceed.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/dto/combat.ts packages/shared/src/dto/travel.ts packages/shared/package.json
git commit -m "feat(shared): combat mode on targets and location DTOs (0.1.13)"
```

---

### Task 3: Detectives `expires_at` — migration, hire write, tracker read

**Files:**
- Modify: `packages/plugins/detectives/src/migrations.ts`
- Modify: `packages/plugins/detectives/src/schema.ts`
- Modify: `packages/plugins/detectives/src/index.ts` (hire + list routes)
- Modify: `apps/server/test/helpers/plugin-tables.ts` (mirror gains column)
- Test: `apps/server/test/detectives.test.ts`

**Interfaces:**
- Produces: nullable column `p_detectives_searches.expires_at timestamptz`; hire writes `expires_at = ends_at + expire-setting`; tracker (`GET /api/detectives`) reports `expiresAt` from the column for new rows, `ends_at + expire` for NULL legacy rows.
- Consumes: nothing from earlier tasks.

- [ ] **Step 1: Write the failing test** — append to `apps/server/test/detectives.test.ts` (follow the file's existing hire-test pattern for registering a player and calling `POST /api/detectives` via `app.inject`; import `detectiveSearches` from `./helpers/plugin-tables.js` if not already imported):

```ts
  it("stamps expires_at at hire and the tracker reports the same instant", async () => {
    // Hire against a fresh target using this file's existing hire helper/pattern.
    const res = await app.inject({
      method: "POST", url: "/api/detectives",
      headers: { authorization: `Bearer ${hirerToken}` },
      payload: { targetUsername: targetUsername, detectives: 1, hours: 1 },
    });
    expect(res.statusCode).toBe(201);
    const { searchId } = res.json<{ searchId: string }>();

    const [row] = await db.select().from(detectiveSearches)
      .where(eq(detectiveSearches.id, searchId));
    expect(row?.expiresAt).not.toBeNull();
    expect(row?.expiresAt?.getTime()).toBeGreaterThan(row.endsAt.getTime());

    // Two read paths cannot diverge: the tracker's expiresAt IS the column.
    const list = await app.inject({
      method: "GET", url: "/api/detectives",
      headers: { authorization: `Bearer ${hirerToken}` },
    });
    const mine = list.json<{ searches: { id: string; expiresAt: string }[] }>()
      .searches.find((s) => s.id === searchId);
    expect(mine?.expiresAt).toBe(row?.expiresAt?.toISOString());
  });

  it("computes a legacy NULL expires_at row's deadline from the expire setting", async () => {
    // Simulate a pre-upgrade row: hire, then null the column out.
    const res = await app.inject({
      method: "POST", url: "/api/detectives",
      headers: { authorization: `Bearer ${hirerToken}` },
      payload: { targetUsername: targetUsername, detectives: 1, hours: 1 },
    });
    const { searchId } = res.json<{ searchId: string }>();
    await db.update(detectiveSearches).set({ expiresAt: null })
      .where(eq(detectiveSearches.id, searchId));

    const list = await app.inject({
      method: "GET", url: "/api/detectives",
      headers: { authorization: `Bearer ${hirerToken}` },
    });
    const mine = list.json<{ searches: { id: string; endsAt: string; expiresAt: string }[] }>()
      .searches.find((s) => s.id === searchId);
    // Old behaviour preserved: ends_at + expire, not epoch/absent.
    expect(new Date(mine!.expiresAt).getTime()).toBeGreaterThan(new Date(mine!.endsAt).getTime());
  });
```

Adapt variable names (`hirerToken`, `targetUsername`, `db`, `app`) to the file's actual fixtures — read the top of `detectives.test.ts` first and reuse its registration helpers verbatim.

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run --project @gl3/server apps/server/test/detectives.test.ts
```

Expected: first new test FAILS on `expiresAt` being undefined on the row type (or null in DB); second fails likewise. Pre-existing tests pass.

- [ ] **Step 3: Implement**

`packages/plugins/detectives/src/migrations.ts` — append to `DETECTIVES_MIGRATIONS` (one statement per migration):

```ts
  {
    name: "0002_report_expiry",
    sql: `ALTER TABLE p_detectives_searches ADD COLUMN expires_at timestamptz`,
  },
```

`packages/plugins/detectives/src/schema.ts` — add to `detectiveSearches`:

```ts
  expiresAt: timestamp("expires_at", { withTimezone: true }),
```

`packages/plugins/detectives/src/index.ts` hire route — read the expire setting alongside `duration` (before the transaction):

```ts
    const expireSeconds = readSeconds(ctx.settings, "expire", DEFAULT_EXPIRE_SECONDS);
```

and extend the insert:

```ts
      await tx.db.insert(detectiveSearches).values({
        id, playerId: player.id, targetPlayerId: target.id,
        detectives: body.detectives, endsAt,
        // Snapshot at hire (read-at-boot posture): freezes this report's
        // window against later retuning, and lets combat read the deadline
        // without reaching into detectives' settings namespace.
        expiresAt: new Date(endsAt.getTime() + expireSeconds * 1000),
      });
```

`index.ts` list route — select the column (add `expiresAt: detectiveSearches.expiresAt` to the select) and switch the computation to prefer it:

```ts
            const expiresAtMs = r.expiresAt?.getTime()
              ?? r.endsAt.getTime() + expireSeconds * 1000;
```

(the `const expiresAtMs = r.endsAt.getTime() + expireSeconds * 1000;` line is replaced; everything downstream already uses `expiresAtMs`).

`apps/server/test/helpers/plugin-tables.ts` — mirror the new column on its `detectiveSearches` table (comment says it mirrors `0001_searches`; update the comment to `0001_searches + 0002_report_expiry`):

```ts
  expiresAt: timestamp("expires_at", { withTimezone: true }),
```

- [ ] **Step 4: Run to verify pass**

```bash
npx vitest run --project @gl3/server apps/server/test/detectives.test.ts apps/server/test/detectives-worker.test.ts
```

Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add packages/plugins/detectives/src apps/server/test/detectives.test.ts apps/server/test/helpers/plugin-tables.ts
git commit -m "feat(detectives): materialise report expiry on the row"
```

---

### Task 4: Detectives export `activeReportTargetIds`

**Files:**
- Create: `packages/plugins/detectives/src/reports.ts`
- Modify: `packages/plugins/detectives/src/index.ts` (re-export)
- Test: `apps/server/test/detectives.test.ts`

**Interfaces:**
- Produces: `activeReportTargetIds(tx: PluginTx, hirerId: string, now: Date): Promise<Set<string>>` — named export of `@gl3/plugin-detectives`. Active = `succeeded = true AND ends_at <= now AND expires_at > now` (SQL three-valued logic makes NULL `expires_at` expired for free). Read-only, no locks. Tasks 5–6 consume it.

- [ ] **Step 1: Write the failing test** — append to `apps/server/test/detectives.test.ts`. Seed rows directly through the `detectiveSearches` helper table; import `activeReportTargetIds` from `@gl3/plugin-detectives` and the server's `testDb` transaction shape. The helper takes a `PluginTx`, whose `db` member is what it reads — in tests, call it through `callPluginRoute`-style plumbing is unnecessary: build the minimal shape `{ db }`:

```ts
import { activeReportTargetIds } from "@gl3/plugin-detectives";
import type { PluginTx } from "@gl3/plugin-sdk";

  it("activeReportTargetIds returns exactly the live successful reports", async () => {
    const now = new Date();
    const past = new Date(now.getTime() - 3_600_000);
    const future = new Date(now.getTime() + 3_600_000);
    const mk = (target: string, over: Partial<typeof detectiveSearches.$inferInsert>) =>
      db.insert(detectiveSearches).values({
        id: uuidv7(), playerId: hirerId, targetPlayerId: target,
        detectives: 1, endsAt: past, succeeded: true, expiresAt: future, ...over,
      });

    const [active, pending, failed, expired, legacy, foreign] =
      await Promise.all([register(), register(), register(), register(), register(), register()])
        .then((rs) => rs.map((r) => r.id));

    await mk(active, {});
    await mk(pending, { endsAt: future, succeeded: null });      // still running
    await mk(failed, { succeeded: false });                      // roll lost
    await mk(expired, { expiresAt: past });                      // window over
    await mk(legacy, { expiresAt: null });                       // pre-upgrade row: counts as expired
    await db.insert(detectiveSearches).values({                  // someone ELSE's report
      id: uuidv7(), playerId: foreign, targetPlayerId: active,
      detectives: 1, endsAt: past, succeeded: true, expiresAt: future,
    });

    const set = await db.transaction(async (txDb) =>
      activeReportTargetIds({ db: txDb } as PluginTx, hirerId, new Date()));
    expect(set).toEqual(new Set([active]));
  });
```

Adapt `register()`/`hirerId` to the file's fixtures. If the `{ db } as PluginTx` cast is refused by the file's lint posture (`apps/*` prefers type guards over casts — this is a test, a targeted cast with a comment is acceptable; follow whatever `economy-invariant.test.ts` does when it hands plugin helpers a tx).

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run --project @gl3/server apps/server/test/detectives.test.ts
```

Expected: FAIL — `activeReportTargetIds` is not exported.

- [ ] **Step 3: Implement** — `packages/plugins/detectives/src/reports.ts`:

```ts
import { and, eq, gt, lte } from "drizzle-orm";
import type { PluginTx } from "@gl3/plugin-sdk";
import { detectiveSearches } from "./schema.js";

/**
 * Every player the hirer currently holds a LIVE report on: succeeded, past
 * ends_at (the reveal), before expires_at (the licence window). A NULL
 * expires_at (pre-upgrade row) fails `gt` and counts as expired — combat
 * never honours a report whose window was never stamped.
 *
 * Read-only and lock-free by design: combat calls this inside its attack
 * transaction, and a plain SELECT adds no edge to the lock graph.
 */
export async function activeReportTargetIds(
  tx: PluginTx, hirerId: string, now: Date,
): Promise<Set<string>> {
  const rows = await tx.db
    .select({ targetId: detectiveSearches.targetPlayerId })
    .from(detectiveSearches)
    .where(and(
      eq(detectiveSearches.playerId, hirerId),
      eq(detectiveSearches.succeeded, true),
      lte(detectiveSearches.endsAt, now),
      gt(detectiveSearches.expiresAt, now),
    ));
  return new Set(rows.map((r) => r.targetId));
}
```

`packages/plugins/detectives/src/index.ts` — add near the top-level exports (same placement reasoning as combat's `resolveShot` re-export):

```ts
export { activeReportTargetIds } from "./reports.js";
```

- [ ] **Step 4: Run to verify pass**

```bash
npx vitest run --project @gl3/server apps/server/test/detectives.test.ts
```

Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add packages/plugins/detectives/src apps/server/test/detectives.test.ts
git commit -m "feat(detectives): export activeReportTargetIds for combat's underground gate"
```

---

### Task 5: Combat attack gate + new test file

**Files:**
- Modify: `packages/plugins/combat/package.json` (dependency)
- Modify: `packages/plugins/combat/tsconfig.json` (reference)
- Modify: `packages/plugins/combat/src/schema.ts` (locations mirror)
- Modify: `packages/plugins/combat/src/index.ts` (attack route)
- Modify: `vitest.workspace.ts` (include the new file)
- Create: `apps/server/test/location-combat-modes.test.ts`

**Interfaces:**
- Consumes: `activeReportTargetIds` (Task 4), `locations.combat_mode` (Task 1).
- Produces: 409 `no_detective_report` from attack in an underground town without a live report on that target; check runs AFTER `same_gang` and `protected`.

**Registration for the new edge (spec §1):** dependency + tsconfig reference below. `Dockerfile.server` already COPYs detectives on the same five lines as every plugin (`grep -c "packages/plugins/detectives" Dockerfile.server` should print 5 — verify, change nothing if so). Root `tsconfig.json` and `apps/server` already reference both plugins. After editing combat's tsconfig, run `npx tsc --build --force apps/server/tsconfig.json` — the exact command CI's image build runs.

- [ ] **Step 1: Wire the dependency**

`packages/plugins/combat/package.json` dependencies — add `"@gl3/plugin-detectives": "*"` (alongside `"@gl3/plugin-inventory": "*"`), then:

```bash
npm install
```

`packages/plugins/combat/tsconfig.json` — references become:

```json
  "references": [{ "path": "../../plugin-sdk" }, { "path": "../inventory" }, { "path": "../detectives" }]
```

```bash
npx tsc --build --force apps/server/tsconfig.json
grep -c "packages/plugins/detectives" Dockerfile.server   # expect 5
```

- [ ] **Step 2: Write the failing tests** — create `apps/server/test/location-combat-modes.test.ts`, modelled directly on `apps/server/test/combat.test.ts` (copy its boot/register/`makeAttackable` scaffolding; `bootTestServer` runs every installed plugin's migrations, so no manual `runPluginMigrations`). Core of the file:

```ts
import { eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { locations, playerStats } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { detectiveSearches } from "./helpers/plugin-tables.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let closeServer: () => Promise<void>;

// register(), makeAttackable(...) — copy verbatim from combat.test.ts,
// with one addition: makeAttackable takes a mode and stamps it on the town:
async function makeAttackable(mode: "open" | "underground", ...ids: string[]): Promise<string> {
  const locationId = uuidv7();
  await db.insert(locations).values({
    id: locationId, name: `loc-${locationId.slice(-8)}`,
    travelCost: 0n, travelCooldownSeconds: 60, bulletStock: 0, bulletCost: 1n,
    combatMode: mode,
  });
  await db.update(playerStats)
    .set({ locationId, exp: 100_000n, bullets: 1000n, health: 100,
           gangId: null, jailedUntil: null, hospitalUntil: null })
    .where(inArray(playerStats.playerId, ids));
  return locationId;
}

/** A live report: succeeded, revealed, unexpired. Overrides shape the negatives. */
async function seedReport(
  hirer: string, target: string,
  over: Partial<typeof detectiveSearches.$inferInsert> = {},
): Promise<void> {
  const now = Date.now();
  await db.insert(detectiveSearches).values({
    id: uuidv7(), playerId: hirer, targetPlayerId: target, detectives: 1,
    endsAt: new Date(now - 3_600_000), succeeded: true,
    expiresAt: new Date(now + 3_600_000), ...over,
  });
}

const attack = (token: string, targetId: string) =>
  app.inject({ method: "POST", url: `/api/combat/attack/${targetId}`,
    headers: { authorization: `Bearer ${token}` } });
```

Test cases (each `beforeEach(resetDb)` + fresh registrations, matching combat.test.ts's rhythm):

```ts
  it("open town: attack works exactly as shipped", async () => {
    await makeAttackable("open", a.id, t.id);
    expect((await attack(a.token, t.id)).statusCode).toBe(200);
  });

  it("underground, no report: 409 no_detective_report and the cooldown is burned", async () => {
    await makeAttackable("underground", a.id, t.id);
    const res = await attack(a.token, t.id);
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe("no_detective_report");
    // Burned: an immediate retry hits the cooldown, not the report check.
    expect((await attack(a.token, t.id)).statusCode).toBe(429);
  });

  it("underground, pending report: 409", async () => {
    await makeAttackable("underground", a.id, t.id);
    await seedReport(a.id, t.id, { endsAt: new Date(Date.now() + 3_600_000), succeeded: null });
    expect((await attack(a.token, t.id)).json<{ error: string }>().error).toBe("no_detective_report");
  });

  it("underground, failed report: 409", async () => { /* seedReport(..., { succeeded: false }) */ });
  it("underground, expired report: 409", async () => { /* { expiresAt: new Date(Date.now() - 1000) } */ });
  it("underground, legacy NULL expires_at: 409", async () => { /* { expiresAt: null } */ });

  it("underground, live report: the shot resolves through the normal path", async () => {
    await makeAttackable("underground", a.id, t.id);
    await seedReport(a.id, t.id);
    const res = await attack(a.token, t.id);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ hit: boolean }>()).toHaveProperty("hit");
  });

  it("underground gangmate: same_gang, not no_detective_report (check order)", async () => {
    await makeAttackable("underground", a.id, t.id);
    // put both in one gang — copy combat.test.ts's gang seeding
    const res = await attack(a.token, t.id);
    expect(res.json<{ error: string }>().error).toBe("same_gang");
  });
```

Fill the elided bodies fully in the actual file — no placeholders. The kill path (payout/hospital/`killResolved`) is already pinned by `combat-kill.test.ts` in both modes' shared code path; the live-report 200 above is the integration point this file owns.

- [ ] **Step 3: Register the file** — in `vitest.workspace.ts`, default `@gl3/server` project `include` list, insert alphabetically (after `test/jail*` / before `test/mail*`, wherever `location-` sorts in that list):

```ts
        "test/location-combat-modes.test.ts",
```

Verify registration: `npx vitest run --project @gl3/server apps/server/test/location-combat-modes.test.ts` must FIND the file (anything but "No test files found").

- [ ] **Step 4: Run to verify failure**

Expected: open-town case passes; every underground case FAILS (attack succeeds where 409 expected) — proving the tests can fail.

- [ ] **Step 5: Implement the gate**

`packages/plugins/combat/src/schema.ts` — add a `locations` mirror (same pattern as the file's other core mirrors; only touched columns):

```ts
/** Core-owned; only the mode column combat reads. */
export const locations = pgTable("locations", {
  id: uuid("id").primaryKey(),
  combatMode: text("combat_mode").notNull(),
});
```

`packages/plugins/combat/src/index.ts` — imports:

```ts
import { activeReportTargetIds } from "@gl3/plugin-detectives";
```

add `locations` to the `./schema.js` import list. In `attackRoute`, immediately AFTER the `protected` check (the `attacker.exp < ... || target.exp < ...` throw) and BEFORE the `shotAt` block:

```ts
      // Underground towns are V2's rule: unshootable without a live detective
      // report. AFTER same_gang/protected so town mode never leaks through
      // error-ordering differences. Both reads are plain SELECTs — no lock,
      // no new edge (spec §1 rule-6 audit). attacker.locationId is non-null
      // here: target_elsewhere above already threw on null.
      const [town] = await tx.db
        .select({ combatMode: locations.combatMode })
        .from(locations)
        .where(eq(locations.id, attacker.locationId));
      if (town?.combatMode === "underground") {
        const reported = await activeReportTargetIds(tx, player.id, new Date());
        if (!reported.has(params.targetId)) {
          throw new PluginError("no_detective_report", 409);
        }
      }
```

- [ ] **Step 6: Run to verify pass**

```bash
npx vitest run --project @gl3/server apps/server/test/location-combat-modes.test.ts apps/server/test/combat.test.ts apps/server/test/combat-kill.test.ts apps/server/test/combat-lock-order.test.ts
```

Expected: ALL PASS (combat regression files prove open-town behaviour unchanged — `makeAttackable` there creates towns with the `'open'` default).

- [ ] **Step 7: Commit**

```bash
npm run typecheck && npx tsc --build --force apps/server/tsconfig.json
git add packages/plugins/combat vitest.workspace.ts apps/server/test/location-combat-modes.test.ts package-lock.json
git commit -m "feat(combat): gate underground-town attacks on a live detective report"
```

---

### Task 6: Combat targets route — mode + SQL-side report filter

**Files:**
- Modify: `packages/plugins/combat/src/index.ts` (`targetsRoute`)
- Test: `apps/server/test/location-combat-modes.test.ts`

**Interfaces:**
- Consumes: Task 4 helper, Task 5 mirror. Produces: response body `{ mode, targets }` per Task 2's `CombatTargetListResponseSchema`; in underground mode the filter is an `inArray` predicate BEFORE `LIMIT 50`.

- [ ] **Step 1: Write the failing tests** — append to `location-combat-modes.test.ts`:

```ts
  const targets = (token: string) =>
    app.inject({ method: "GET", url: "/api/combat/targets",
      headers: { authorization: `Bearer ${token}` } });

  it("open town: body carries mode=open and lists everyone", async () => {
    await makeAttackable("open", a.id, t.id);
    const body = (await targets(a.token)).json<{ mode: string; targets: { playerId: string }[] }>();
    expect(body.mode).toBe("open");
    expect(body.targets.map((r) => r.playerId)).toContain(t.id);
  });

  it("underground: lists only reported players, absent not reasoned", async () => {
    const bystander = await register();
    await makeAttackable("underground", a.id, t.id, bystander.id);
    await seedReport(a.id, t.id);
    const body = (await targets(a.token)).json<{ mode: string; targets: { playerId: string }[] }>();
    expect(body.mode).toBe("underground");
    expect(body.targets.map((r) => r.playerId)).toEqual([t.id]);
  });

  it("underground with no reports: empty list, mode still underground", async () => {
    await makeAttackable("underground", a.id, t.id);
    const body = (await targets(a.token)).json<{ mode: string; targets: unknown[] }>();
    expect(body.mode).toBe("underground");
    expect(body.targets).toEqual([]);
  });

  it("underground: a reported player out-ranked by 50+ others still appears (SQL-side filter)", async () => {
    // 51 bystanders with higher exp than the reported target would push the
    // target past LIMIT 50 if the filter ran after the limit.
    const bystanders = await Promise.all(Array.from({ length: 51 }, () => register()));
    const locationId = await makeAttackable("underground", a.id, t.id, ...bystanders.map((b) => b.id));
    await db.update(playerStats).set({ exp: 1_000n })
      .where(eq(playerStats.playerId, t.id));      // lowest exp in town (still over threshold? see note)
    await seedReport(a.id, t.id);
    const body = (await targets(a.token)).json<{ targets: { playerId: string }[] }>();
    expect(body.targets.map((r) => r.playerId)).toEqual([t.id]);
  });
```

Note on the 51-bystander case: `exp: 1_000n` must stay ABOVE the newbie threshold or the row gets `newbie_protected` instead of proving the limit — read `combat.newbie_exp_threshold`'s default in `packages/plugins/combat/src/settings.ts` and pick a value over it but under `makeAttackable`'s `100_000n`. Registration of 53 players is the slowest part of the file (argon2 42ms/hash ≈ 2.2s) — acceptable, do not optimise.

- [ ] **Step 2: Run to verify failure** — the mode assertions fail (`mode` undefined); in the filter cases every co-located player is listed.

- [ ] **Step 3: Implement** — in `targetsRoute`, add `inArray` to the file's `drizzle-orm` import. After the `me` read and its null-location early-return (which becomes `return { status: 200, body: { mode: "open", targets: [] } };`):

```ts
      const [town] = await tx.db
        .select({ combatMode: locations.combatMode })
        .from(locations)
        .where(eq(locations.id, me.locationId));
      const mode = town?.combatMode === "underground" ? "underground" as const : "open" as const;

      // Underground: the report set becomes a SQL predicate BEFORE the
      // LIMIT — a post-limit filter would hide a legally attackable reported
      // player ranked below 50th by exp in a crowded town. The set is small
      // (the tracker caps at 100 searches), so the IN list is cheap.
      let reportedIds: string[] | null = null;
      if (mode === "underground") {
        const reported = await activeReportTargetIds(tx, player.id, new Date());
        if (reported.size === 0) return { status: 200, body: { mode, targets: [] } };
        reportedIds = [...reported];
      }
```

then extend the existing query's `where(and(...))` with a conditional third predicate and stamp `mode` on the body:

```ts
        .where(and(
          eq(playerStats.locationId, me.locationId),
          ne(playerStats.playerId, player.id),
          ...(reportedIds === null ? [] : [inArray(playerStats.playerId, reportedIds)]),
        ))
```

```ts
      return {
        status: 200,
        body: {
          mode,
          targets: rows.map((row) => {
```

- [ ] **Step 4: Run to verify pass**

```bash
npx vitest run --project @gl3/server apps/server/test/location-combat-modes.test.ts apps/server/test/combat.test.ts
```

Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add packages/plugins/combat/src/index.ts apps/server/test/location-combat-modes.test.ts
git commit -m "feat(combat): underground towns list only reported targets, filtered in SQL"
```

---

### Task 7: Travel — listing field + admin editing

**Files:**
- Modify: `packages/plugins/travel/src/schema.ts` (mirror gains column)
- Modify: `packages/plugins/travel/src/index.ts` (LocationListing, list route, admin routes, admin page)
- Test: `apps/server/test/location-combat-modes.test.ts` (or the file travel admin tests live in — read `vitest.workspace.ts` and `grep -l "api/admin/travel" apps/server/test` first; extend THAT file if one exists)

**Interfaces:**
- Consumes: Task 1 column, Task 2 `LocationDto.combatMode`.
- Produces: `LocationListing.combatMode: "open" | "underground"`; `GET /api/locations` rows carry `combatMode`; `GET /api/admin/travel/combat-modes` (new, the select's `optionsSource` — the view vocabulary's `select` REQUIRES an optionsSource, there are no static options); create/update accept `combatMode` and 400 `invalid_combat_mode` on anything outside the pair.

- [ ] **Step 1: Write the failing tests** — in the travel admin test file found above (or `location-combat-modes.test.ts` if none):

```ts
  it("lists combatMode on the travel board", async () => {
    await makeAttackable("underground", a.id);
    const res = await app.inject({ method: "GET", url: "/api/locations",
      headers: { authorization: `Bearer ${a.token}` } });
    const town = res.json<{ locations: { combatMode?: string; current: boolean }[] }>()
      .locations.find((l) => l.current);
    expect(town?.combatMode).toBe("underground");
  });

  it("admin round-trips combat_mode and refuses junk", async () => {
    // adminToken: register() the FIRST player of the run or grant per the
    // file's existing admin-test pattern (first registered player is admin).
    const create = await app.inject({ method: "POST", url: "/api/admin/travel/locations",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: "Hideout", travelCost: "0", travelCooldownSeconds: 0, combatMode: "underground" } });
    expect(create.statusCode).toBe(201);
    const { id } = create.json<{ id: string }>();

    const [row] = await db.select().from(locations).where(eq(locations.id, id));
    expect(row?.combatMode).toBe("underground");

    const bad = await app.inject({ method: "POST", url: "/api/admin/travel/locations/update",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { id, name: "Hideout", travelCost: "0", travelCooldownSeconds: 0, combatMode: "ghost" } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json<{ error: string }>().error).toBe("invalid_combat_mode");
  });
```

- [ ] **Step 2: Run to verify failure** — `combatMode` undefined on the board; create 400s (strict schema rejects the unknown key) instead of 201.

- [ ] **Step 3: Implement**

`packages/plugins/travel/src/schema.ts` — add to the `locations` mirror:

```ts
  combatMode: text("combat_mode").notNull(),
```

(add `text` to the drizzle-orm/pg-core import if missing; extend the file's mirror comment: travel now reads AND writes this column via admin.)

`packages/plugins/travel/src/index.ts`:

1. `LocationListing` gains `readonly combatMode: "open" | "underground";` — subscribers (bullets) stamp other fields, the interface growing breaks nothing.
2. List route: in the `rows.map` feeding `ctx.filters.apply`, add
   `combatMode: l.combatMode === "underground" ? "underground" as const : "open" as const,`
   and in the response body map add `combatMode: l.combatMode,`.
3. Body schema + validation helper near `TownBodySchema`:

```ts
const TownBodySchema = z.object({
  name: z.string().min(1).max(80),
  travelCost: AdminMoney,
  travelCooldownSeconds: z.coerce.number().int().nonnegative(),
  // Validated in the handler, not by z.enum: the loader answers every zod
  // failure with a generic `invalid_request`, and the spec pins this one to
  // its own code. Defaulted so pre-existing clients that omit it keep working.
  combatMode: z.string().default("open"),
}).strict();

function parseCombatMode(raw: string): "open" | "underground" {
  if (raw !== "open" && raw !== "underground") throw new PluginError("invalid_combat_mode", 400);
  return raw;
}
```

4. `adminCreateRoute` insert gains `combatMode: parseCombatMode(body.combatMode),` (call `parseCombatMode` BEFORE `ctx.transaction` — spec: before any DB read). Same in `adminUpdateRoute`'s `.set({...})`.
5. `adminListRoute` rows gain `combatMode: l.combatMode,`.
6. New options route (register it in the manifest's `routes` array):

```ts
const adminModesRoute = route({
  method: "GET", path: "/api/admin/travel/combat-modes", auth: "admin",
  handler: async () => ({
    status: 200,
    body: { rows: [
      { id: "open", name: "Open" },
      { id: "underground", name: "Underground" },
    ] },
  }),
});
```

7. Admin page: add to the table columns `{ key: "combatMode", label: "Combat" },` and to BOTH forms:

```ts
        { name: "combatMode", label: "Combat mode", type: "select", optionsSource: "GET /api/admin/travel/combat-modes", valueKey: "id", labelKey: "name" },
```

(`valueKey: "id"` selects a mode string, not a UUID — `test/admin-ids-hidden.test.ts` guards UUID display, not this; if it fails, read its assertion before touching it.)

- [ ] **Step 4: Run to verify pass** — the edited test file, plus travel + bullets + admin regressions:

```bash
npx vitest run --project @gl3/server apps/server/test/location-combat-modes.test.ts apps/server/test/travel.test.ts apps/server/test/travel-lock-order.test.ts apps/server/test/bullets.test.ts apps/server/test/admin-ids-hidden.test.ts
```

(adjust file names to what exists — `ls apps/server/test | grep -E "travel|admin"`). Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add packages/plugins/travel apps/server/test
git commit -m "feat(travel): expose and administer per-town combat mode"
```

---

### Task 8: Migration CLI `--town-combat-mode`

**Files:**
- Modify: `apps/migrate/src/cli-args.ts`
- Modify: `apps/migrate/src/orchestrator.ts`
- Modify: `apps/migrate/src/cli.ts:82` (thread the arg)
- Modify: `apps/migrate/src/migrators/locations.ts`
- Test: `apps/migrate/test/cli-args.test.ts`, `apps/migrate/test/migrators/locations.test.ts`

**Interfaces:**
- Produces: `CliArgs.townCombatMode: "open" | "underground"` (default `"open"`); `migrateLocations(pool, exec, report, townCombatMode)` stamps it on every town.

**Env:** these tests need `MYSQL_ADMIN_URL` exported alongside `DATABASE_URL`/`REDIS_URL` (see `.env.example`) — a missing var fails the whole block in a way that reads like real failures.

- [ ] **Step 1: Write the failing tests**

`apps/migrate/test/cli-args.test.ts` (pure, no DB — follow the file's existing cases):

```ts
  it("defaults town combat mode to open", () => {
    expect(parseCliArgs(["--pg", "postgres://x"]).townCombatMode).toBe("open");
  });
  it("accepts --town-combat-mode underground", () => {
    expect(parseCliArgs(["--pg", "postgres://x", "--town-combat-mode", "underground"]).townCombatMode)
      .toBe("underground");
  });
  it("rejects a junk town combat mode", () => {
    expect(() => parseCliArgs(["--pg", "postgres://x", "--town-combat-mode", "ghost"])).toThrow();
  });
```

`apps/migrate/test/migrators/locations.test.ts` — extend the existing test's assertions and add the flag case:

```ts
      // in the existing test, after the travelCost assertion:
      expect(rows.every((r) => r.combatMode === "open")).toBe(true);
```

```ts
  it("stamps underground on every town when asked", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    try {
      const pool = mysql.createPool(fixture.url);
      const { db, sql } = createDb(target.url);
      await migrateLocations(pool, db, createReport(false), "underground");
      const rows = await db.select().from(locations);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.combatMode === "underground")).toBe(true);
      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });
```

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run apps/migrate/test/cli-args.test.ts apps/migrate/test/migrators/locations.test.ts
```

Expected: FAIL — `townCombatMode` absent; `migrateLocations` takes three args.

- [ ] **Step 3: Implement**

`cli-args.ts`:

```ts
  townCombatMode: z.enum(["open", "underground"]).default("open"),
```

in `CliArgsSchema`, and `"town-combat-mode": "townCombatMode",` in `FLAG_TO_KEY`. Update the "five flags" doc comment to six.

`migrators/locations.ts` — signature gains a defaulted parameter and the values gain the column:

```ts
export async function migrateLocations(
  pool: mysql.Pool, exec: Executor, report: MigrationReport,
  townCombatMode: "open" | "underground" = "open",
): Promise<void> {
```

```ts
      combatMode: townCombatMode,
```

The default is load-bearing for idempotency AND is the spec's V2 posture — enumerate the callers (`grep -rn "migrateLocations(" apps/migrate`) and confirm the orchestrator is the only production call site before trusting it.

`orchestrator.ts` — `RunMigrationOptions` gains `townCombatMode: "open" | "underground";`, destructure it in `runMigration`, pass to `migrateLocations(pool, tx, report, townCombatMode)`.

`cli.ts:82` — `runMigration({ mysql: pool, db, report, dryRun: args.dryRun, townCombatMode: args.townCombatMode });`

- [ ] **Step 4: Run to verify pass** — same command as Step 2 plus the orchestrator-level suite if one exists (`ls apps/migrate/test | grep -i "cli\|pipeline\|idempot"`). Expected: ALL PASS (the three-run idempotency test keeps passing because `onConflictDoUpdate` re-stamps the same `'open'`).

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add apps/migrate
git commit -m "feat(migrate): --town-combat-mode flag defaulting every town to open"
```

---

### Task 9: Web — combat empty state + travel badge

**Files:**
- Modify: `apps/web/src/pages/Combat.tsx`
- Modify: `apps/web/src/pages/Travel.tsx`
- Possibly: the pages' CSS modules (badge style) — follow each page's existing `styles.meta`/`styles.muted` classes rather than inventing one.

**Interfaces:**
- Consumes: Task 2 DTO fields (`targets.data.mode`, `location.combatMode`) — the API layer (`apps/web/src/api/queries.ts`) parses with the shared schemas, so the fields arrive typed once Tasks 5–7 servers send them.

**Testing:** `@gl3/web` has no DOM test harness for these pages beyond typecheck (the exhaustive-switch files are untouched — no new event). The check is `npm run typecheck` plus the `@gl3/web` vitest project.

- [ ] **Step 1: Combat empty state** — in `Combat.tsx`, add `import { Link } from "react-router-dom";`, read the mode next to `rows`:

```tsx
  const mode = targets.data?.mode ?? "open";
```

and replace the empty-state paragraph:

```tsx
          {rows.length === 0 ? (
            mode === "underground" ? (
              <p className={styles.meta}>
                Nobody shows their face in this town. <Link to="/detectives">Hire a detective.</Link>
              </p>
            ) : (
              <p className={styles.meta}>Nobody else is in this city.</p>
            )
          ) : (
```

- [ ] **Step 2: Travel badge** — in `Travel.tsx`, inside each row's meta line (next to the bullets price), add:

```tsx
                  {location.combatMode === "underground" ? <> · underground</> : null}
```

Rendered as plain meta text — the board's existing typography, no new CSS class. (Spec calls it a badge; a labelled meta segment satisfies "visible before paying the fare" without inventing a component — if the page already has a badge/pill class, use it instead.)

- [ ] **Step 3: Verify**

```bash
npm run typecheck
npx vitest run --project @gl3/web
```

Expected: PASS. Also resolve any `apps/web` fixture errors recorded in Task 2 Step 5.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages
git commit -m "feat(web): underground empty-state on combat, mode tag on travel board"
```

---

### Task 10: Docs + merge gate

**Files:**
- Modify: `docs/STATUS.md` (new cluster section), `CLAUDE.md` (current-state paragraph; note shared at `0.1.13` unpublished; fifth plugin→plugin edge)

- [ ] **Step 1: Write the docs** — one STATUS section in the established shape (what shipped, the decisions table's deltas, the SQL-side-filter reasoning, the operational constraint about running underground towns without the detectives plugin, no-new-lock-edge audit, no new GameEvent). One CLAUDE.md current-state paragraph. Commit:

```bash
git add docs/STATUS.md CLAUDE.md
git commit -m "docs: record location combat modes cluster"
```

- [ ] **Step 2: Pre-gate hygiene**

```bash
pgrep -fa vitest   # must be empty
psql "$DATABASE_URL" -Atc "select datname from pg_database where datname like 'gl3_tmpl%'"
```

Another agent's runs mean WAIT — a concurrent session makes the run void, not failing.

- [ ] **Step 3: The bare gate**

```bash
npm run verify > /tmp/claude-1000/-home-dlite-GL3/13d4a867-28b1-4807-bc0a-4732fbdf45fb/scratchpad/verify.log 2>&1
echo $?
```

The `echo $?` is its own command on its own line. Non-zero exit is a failure EVEN IF every test passed (unhandled rejections). Files reporting `(0 test)` with zero failures = cross-talk, run void. `apps/migrate` needs `MYSQL_ADMIN_URL` exported or 25 files fail as a block.

- [ ] **Step 4: On green** — report the exit code and the suite counts to the user verbatim, then invoke superpowers:finishing-a-development-branch. Publishing `@gl3/shared@0.1.13` needs explicit user approval and coordination (the registry may have moved past `0.1.12` again — check `npm view @gl3/shared versions --registry https://npm.gl3.dev` first).

---

## Self-review notes

- Spec coverage: §1 core column (T1), detectives migration+export (T3,T4), combat attack (T5), combat targets SQL filter (T6), travel listing+admin (T7), migrate flag (T8); §3 web (T9); §4 both error codes (T5,T7); §5 every named case incl. >50-resident filter (T6), NULL expires_at (T4,T5), check order (T5), tracker/helper agreement (T3), no lock-order test deliberately (recorded — do NOT add one), workspace include (T5), DTO patch bump (T2), schema.test counts untouched + column assertion (T1); §6 out-of-scope untouched.
- The admin `select` needs an `optionsSource` (SDK requires it — verified against `pages.ts:80-86`); spec's "select with the two values" is implemented via the new `GET /api/admin/travel/combat-modes`.
- `invalid_combat_mode` cannot come from z.enum (loader answers zod failures with generic `invalid_request` — `plugins/routes.ts:71`), hence handler-level validation.
