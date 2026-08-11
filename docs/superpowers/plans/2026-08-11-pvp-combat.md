# PvP Combat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let players shoot each other — a `combat` plugin, a minimal `inventory` plugin, and hospital as a core state facility.

**Architecture:** Two new plugin packages built on the shipped plugin SDK, plus core work for hospital (the gate must live with the route loader, exactly as jail does). Combat resolves synchronously inside one `ctx.transaction` under an ascending-UUID two-player lock; equipment and consumables are inventory concerns; death moves the victim's on-hand cash to the killer through the ledger.

**Tech Stack:** TypeScript strict (ESM, `.js` import extensions), Fastify 5, Drizzle ORM + Postgres 16, Redis 7, zod, vitest against real Postgres and Redis.

**Design spec:** `docs/superpowers/specs/2026-08-11-pvp-combat-design.md` (commit `cd7934f`). Read it before Task 1.

## Global Constraints

- **No `any` in `packages/*`** — none, not even a cast. Use type guards.
- **ESM only**; every relative import carries a `.js` extension despite `.ts` sources.
- **Zod-validates every external boundary** — HTTP bodies, route params, and `items.effects` jsonb on every read.
- **Money is `bigint`** in Postgres and TypeScript, and crosses the wire as a **decimal string**. Never a JSON number.
- **Bigint column defaults** must be written `` .default(sql`0`) ``, never `.default(0n)` — drizzle-kit's serialiser crashes on `BigInt`.
- **Every balance movement goes through `tx.economy.applyBalanceChange`.** One transaction, one ledger row.
- **Never check-then-act on Redis.** `SET NX EX`, `GETDEL`, or Lua only.
- **Publish events only after the transaction commits** — `tx.events.publishCore` buffers; the loader flushes post-commit.
- **A foreign key is a lock.** Inserting a row whose FK references another row takes `FOR KEY SHARE` on it, which conflicts with `FOR UPDATE`. Read the FKs, not just the lock calls.
- **Random outcomes use `node:crypto` `randomInt`**, never `Math.random`.
- **Conventional Commits.**
- **Verification is the exit code, not the summary:** `npm run verify > /tmp/verify.log 2>&1; echo "exit=$?"`. An unhandled rejection makes vitest exit non-zero while still printing a passing test count.
- **Environment:** Docker is unavailable. Postgres and Redis run natively.
  ```bash
  export DATABASE_URL=postgres://gl3:gl3@localhost:5432/gl3
  export REDIS_URL=redis://localhost:6379
  ```
- **Never run two full test suites at once.** Never run Redis `FLUSHALL`/`FLUSHDB` — Redis is shared across every test file and every concurrent agent.
- **Baseline suite: 71 files / 588 tests**, green. Every task must leave it green.

### The eight registration sites for a new plugin package

Three of these fail silently or only in CI. For each new package (`combat`, `inventory`):

1. `packages/plugins/<id>/` — `package.json`, `tsconfig.json`, `src/`
2. `apps/server/package.json` dependencies (then `npm install`)
3. `apps/server/tsconfig.json` `references` — **fails only in CI**
4. root `tsconfig.json` `references`
5. `vitest.workspace.ts` `srcAliases` — **fails nothing; silently grades against a stale `dist/`**
6. `apps/server/src/plugins/core-plugins.ts` `CORE_PLUGINS`
7. `vitest.workspace.ts` project `include` list for each new test file — **an unlisted file is silently never run**
8. **Five `Dockerfile.server` COPY lines** — **fails only in CI**

Checks: `grep -c "packages/plugins/combat" Dockerfile.server` → `5`; same for `inventory`. And `npx tsc --build --force apps/server/tsconfig.json`, the exact command the image build runs.

---

## Corrections to the design spec

Two things found while reading the code, which override the spec where they conflict:

1. **`tx.locks.player(playerIds: string[])` already exists** on `PluginTx` (`packages/plugin-sdk/src/ctx.ts`, implemented at `apps/server/src/plugins/ctx.ts` as a passthrough to `lockPlayersForUpdate`). The spec's §3.4 item 1 ("add `tx.locks.players`") is **already done** — no work. Note the method is singular: `tx.locks.player([a, b])`.
2. **`ctx.settings.get()` is dead surface.** `PluginCtxDeps.settings` is hardcoded `{}` at `apps/server/src/app.ts:103`, `apps/server/src/index.ts:43` and in `apps/server/test/helpers/plugin-route.ts`. Nothing ever reads the `settings` table. The spec assumes settings work; Task 1 makes them work.

---

## File Structure

**Core (`apps/server/src/`)**

| File | Responsibility |
|---|---|
| `settings/load.ts` (new) | `loadSettings(db)` → `Record<string, string>` from the `settings` table |
| `db/schema/social.ts` (modify) | `combatLog` table definition |
| `drizzle/0005_combat_log.sql` (new) | The migration |
| `game/hospital/status.ts` (new) | `checkHospital`, `settleHospital`, `sendToHospital`, `dischargeCost` |
| `game/hospital/routes.ts` (new) | `GET /api/hospital`, `POST /api/hospital/discharge` |
| `plugins/routes.ts` (modify) | `accessInHospital` gate alongside the jail gate |
| `plugins/ctx.ts` (modify) | `tx.hospital.sendToHospital`; accept loaded settings |
| `app.ts`, `index.ts` (modify) | Wire `loadSettings`; register hospital routes |
| `db/seed.ts` (modify) | Starter weapon + heal consumable items |

**SDK (`packages/plugin-sdk/src/`)**

| File | Responsibility |
|---|---|
| `route.ts` (modify) | `accessInHospital?: boolean`, defaulting `true` |
| `ctx.ts` (modify) | `readonly hospital: { sendToHospital(...) }` on `PluginTx` |

**`packages/plugins/inventory/src/`**

| File | Responsibility |
|---|---|
| `schema.ts` | Mirrors: `items`, `player_items`, `player_stats`, `ranks` |
| `effects.ts` | Zod schemas for `weapon` / `armor` / `consumable` effects, with defaults |
| `index.ts` | The three routes + `definePlugin` |

**`packages/plugins/combat/src/`**

| File | Responsibility |
|---|---|
| `schema.ts` | Mirrors: `player_stats`, `players`, `items`, `ranks`, `gang_members`, `combat_log` |
| `effects.ts` | Re-declared weapon/armor effect schemas (a plugin may not import another plugin) |
| `resolve.ts` | **Pure** hit/damage/crit/armor arithmetic — no DB, no ctx, unit-testable |
| `settings.ts` | Typed reads of the `combat.*` settings with defaults |
| `index.ts` | The two routes + `definePlugin` |

`resolve.ts` being pure is deliberate: it is the only part with interesting arithmetic, and keeping it free of the database means its tests need neither Postgres nor Redis.

---

### Task 1: Load `settings` from the database at boot

`ctx.settings.get()` returns null for every key today because nothing populates `PluginCtxDeps.settings`. Combat reads nine settings, so this must work first.

Settings are read **once at boot** into a plain `Record<string, string>`, which is what the synchronous `get(key): string | null` signature already implies. Changing a setting requires a restart — acceptable, and matches V2, where `settings` is admin-edited configuration rather than live state.

**Files:**
- Create: `apps/server/src/settings/load.ts`
- Modify: `apps/server/src/app.ts:95,103` (both `settings: {}` sites)
- Modify: `apps/server/src/index.ts:43`
- Modify: `apps/server/test/helpers/plugin-route.ts` (accept a `settings` option)
- Test: `apps/server/test/settings-load.test.ts`
- Modify: `vitest.workspace.ts` (add the test file to the `@gl3/server:db-only` project)

**Interfaces:**
- Consumes: `Db` from `apps/server/src/db/client.js`; the `settings` table from `apps/server/src/db/schema/index.js`.
- Produces: `loadSettings(db: Db): Promise<Record<string, string>>`. `CallPluginRouteOptions` gains `settings?: Record<string, string>`.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/settings-load.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { settings } from "../src/db/schema/index.js";
import { loadSettings } from "../src/settings/load.js";
import { testDb } from "./helpers/db.js";

describe("loadSettings", () => {
  it("returns an empty record when the table is empty", async () => {
    const { db } = await testDb();
    await db.delete(settings);
    expect(await loadSettings(db)).toEqual({});
  });

  it("reads every row into a key→value record", async () => {
    const { db } = await testDb();
    await db.delete(settings);
    await db.insert(settings).values([
      { key: "combat.cooldown_seconds", value: "60" },
      { key: "combat.hospital_seconds", value: "300" },
    ]);

    const loaded = await loadSettings(db);

    expect(loaded).toEqual({
      "combat.cooldown_seconds": "60",
      "combat.hospital_seconds": "300",
    });
  });
});
```

Add `"test/settings-load.test.ts"` to the `include` array of the `@gl3/server:db-only` project in `vitest.workspace.ts` (it needs Postgres, not Redis).

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run --project @gl3/server:db-only apps/server/test/settings-load.test.ts
```

Expected: FAIL — `Cannot find module '../src/settings/load.js'`.

- [ ] **Step 3: Write the implementation**

Create `apps/server/src/settings/load.ts`:

```ts
import type { Db } from "../db/client.js";
import { settings } from "../db/schema/index.js";

/**
 * Read once at boot into a plain record: `PluginCtx.settings.get` is
 * synchronous, so the values must already be in memory by the time a route
 * runs. Changing a setting therefore needs a restart, which matches V2 —
 * `settings` is admin-edited configuration, not live game state.
 *
 * Before this existed, every `PluginCtxDeps.settings` site passed `{}` and
 * `ctx.settings.get()` answered null for every key in the game.
 */
export async function loadSettings(db: Db): Promise<Record<string, string>> {
  const rows = await db.select({ key: settings.key, value: settings.value }).from(settings);
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run --project @gl3/server:db-only apps/server/test/settings-load.test.ts
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Wire it into both boot paths**

In `apps/server/src/app.ts`, replace both `settings: {}` occurrences (lines ~95 and ~103) with a value loaded once near the top of `buildApp`, before the plugin loader runs:

```ts
const loadedSettings = await loadSettings(deps.db);
```

then pass `settings: loadedSettings` at both sites. Add the import:

```ts
import { loadSettings } from "./settings/load.js";
```

In `apps/server/src/index.ts:43`, replace `settings: {}` the same way — load once before the `loadPlugins` call and pass the result.

- [ ] **Step 6: Let the test helper pass settings**

In `apps/server/test/helpers/plugin-route.ts`, add to `CallPluginRouteOptions`:

```ts
  /**
   * Defaults to `{}` — a route reading a setting must be given one here, the
   * same way `bootTestServer` gets them from the `settings` table.
   */
  settings?: Record<string, string>;
```

and in the `deps` object literal replace `settings: {},` with `settings: opts.settings ?? {},`.

- [ ] **Step 7: Run the full suite**

```bash
npm run verify > /tmp/verify.log 2>&1; echo "exit=$?"
```

Expected: `exit=0`. Baseline was 71 files / 588 tests; this adds 1 file / 2 tests.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/settings/load.ts apps/server/src/app.ts apps/server/src/index.ts \
        apps/server/test/settings-load.test.ts apps/server/test/helpers/plugin-route.ts \
        vitest.workspace.ts
git commit -m "feat(settings): load the settings table into the plugin ctx at boot

PluginCtxDeps.settings was hardcoded {} at every construction site, so
ctx.settings.get() answered null for every key in the game. Combat reads
nine settings and needs this to work."
```

---

### Task 2: `combat_log` table and migration `0005`

**Files:**
- Modify: `apps/server/src/db/schema/social.ts`
- Create: `apps/server/drizzle/0005_combat_log.sql`
- Test: `apps/server/test/combat-log-schema.test.ts`
- Modify: `vitest.workspace.ts` (`@gl3/server:db-only` project)

**Interfaces:**
- Produces: `combatLog` exported from `apps/server/src/db/schema/social.js` and re-exported by `db/schema/index.js`. Columns: `id`, `attackerId`, `targetId`, `hit`, `damage`, `fatal`, `weaponItemId`, `payout`, `createdAt`.

**There is deliberately no `location_id` column.** `combat_log`'s FKs are taken while the transaction holds two `player_stats` locks; a `locations` FK would take `FOR KEY SHARE` on a location row at that moment — player-then-location, inverting the location-first order that `travel` and `bullets` follow, closing an ABBA cycle. The remaining FKs are safe: nothing locks `items`, and the two `players` FKs point at rows already held `FOR UPDATE`, which subsumes `FOR KEY SHARE`.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/combat-log-schema.test.ts`:

```ts
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { testDb } from "./helpers/db.js";

describe("combat_log schema", () => {
  it("has the expected columns and types", async () => {
    const { db } = await testDb();
    const rows = await db.execute(sql`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'combat_log'
      ORDER BY column_name
    `);
    const byName = Object.fromEntries(
      rows.map((r) => [String(r.column_name), { type: String(r.data_type), nullable: r.is_nullable === "YES" }]),
    );

    expect(byName).toMatchObject({
      id: { type: "uuid", nullable: false },
      attacker_id: { type: "uuid", nullable: false },
      target_id: { type: "uuid", nullable: false },
      hit: { type: "boolean", nullable: false },
      damage: { type: "integer", nullable: false },
      fatal: { type: "boolean", nullable: false },
      weapon_item_id: { type: "uuid", nullable: true },
      payout: { type: "bigint", nullable: false },
      created_at: { type: "timestamp with time zone", nullable: false },
    });
  });

  it("has no location_id column (rule 6: a locations FK would invert the lock order)", async () => {
    const { db } = await testDb();
    const rows = await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'combat_log' AND column_name = 'location_id'
    `);
    expect(rows).toHaveLength(0);
  });

  it("indexes both participant columns for the log reads", async () => {
    const { db } = await testDb();
    const rows = await db.execute(sql`
      SELECT indexname FROM pg_indexes WHERE tablename = 'combat_log'
    `);
    const names = rows.map((r) => String(r.indexname));
    expect(names).toContain("combat_log_target_idx");
    expect(names).toContain("combat_log_attacker_idx");
  });
});
```

Add `"test/combat-log-schema.test.ts"` to the `@gl3/server:db-only` project `include` list in `vitest.workspace.ts`.

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run --project @gl3/server:db-only apps/server/test/combat-log-schema.test.ts
```

Expected: FAIL — the `information_schema` query returns no rows, so `byName` is `{}`.

- [ ] **Step 3: Add the table to the Drizzle schema**

Append to `apps/server/src/db/schema/social.ts` (match the file's existing import style; add `boolean` and `integer` to the `drizzle-orm/pg-core` import if absent):

```ts
/**
 * One row per SHOT, not per kill — `fatal` marks the last one. Misses are
 * logged too: "someone shot at me and missed" is information the bounty and
 * detective clusters will both want, and it is where death attribution lives
 * now that V2's `US_shotBy` is gone (spec §2.5 dropped it).
 *
 * NO `location_id`, deliberately. These FKs are taken while the transaction
 * holds two `player_stats` rows FOR UPDATE; a `locations` FK would take
 * FOR KEY SHARE on a location row at that point — player-then-location,
 * the inverse of the location-first order `travel` and `bullets` follow, which
 * closes an ABBA cycle (CLAUDE.md rule 6). The location is recoverable from
 * context and is not worth an inverted lock order.
 */
export const combatLog = pgTable("combat_log", {
  id: uuid("id").primaryKey(),
  attackerId: uuid("attacker_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  targetId: uuid("target_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  hit: boolean("hit").notNull(),
  damage: integer("damage").notNull().default(0),
  fatal: boolean("fatal").notNull().default(false),
  weaponItemId: uuid("weapon_item_id").references(() => items.id, { onDelete: "set null" }),
  /** Cash taken from the victim. Non-zero only on a fatal row. */
  payout: bigint("payout", { mode: "bigint" }).notNull().default(sql`0`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  targetIdx: index("combat_log_target_idx").on(t.targetId, t.createdAt),
  attackerIdx: index("combat_log_attacker_idx").on(t.attackerId, t.createdAt),
}));
```

`social.ts` may not already import `items`; add it from `./content.js` if so. Note `` .default(sql`0`) `` for the bigint — `.default(0n)` crashes drizzle-kit's serialiser.

Confirm `db/schema/index.ts` re-exports `social.js` wholesale (`export * from "./social.js"`). If it names exports individually, add `combatLog`.

- [ ] **Step 4: Write the migration**

Create `apps/server/drizzle/0005_combat_log.sql`:

```sql
CREATE TABLE IF NOT EXISTS "combat_log" (
  "id" uuid PRIMARY KEY NOT NULL,
  "attacker_id" uuid NOT NULL,
  "target_id" uuid NOT NULL,
  "hit" boolean NOT NULL,
  "damage" integer DEFAULT 0 NOT NULL,
  "fatal" boolean DEFAULT false NOT NULL,
  "weapon_item_id" uuid,
  "payout" bigint DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "combat_log" ADD CONSTRAINT "combat_log_attacker_id_players_id_fk"
  FOREIGN KEY ("attacker_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "combat_log" ADD CONSTRAINT "combat_log_target_id_players_id_fk"
  FOREIGN KEY ("target_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "combat_log" ADD CONSTRAINT "combat_log_weapon_item_id_items_id_fk"
  FOREIGN KEY ("weapon_item_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "combat_log_target_idx" ON "combat_log" ("target_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "combat_log_attacker_idx" ON "combat_log" ("attacker_id","created_at");
```

Check `apps/server/drizzle/meta/_journal.json` and add the `0005_combat_log` entry in the same shape as the `0004_plugin_runtime` entry (same `version`, next `idx`, a `when` timestamp in ms, `tag: "0005_combat_log"`, `breakpoints: true`).

- [ ] **Step 5: Run the test to verify it passes**

The template database is built by `test/helpers/global-setup.ts` and cached; a new migration means it must be rebuilt. Drop the template first so the next run re-migrates:

```bash
psql "$DATABASE_URL" -c 'DROP DATABASE IF EXISTS gl3_test_template'
npx vitest run --project @gl3/server:db-only apps/server/test/combat-log-schema.test.ts
```

Expected: PASS, 3 tests. If the template name differs, read it out of `test/helpers/template-db.ts` rather than guessing.

- [ ] **Step 6: Run the full suite**

```bash
npm run verify > /tmp/verify.log 2>&1; echo "exit=$?"
```

Expected: `exit=0`.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/db/schema/social.ts apps/server/drizzle/0005_combat_log.sql \
        apps/server/drizzle/meta/_journal.json apps/server/test/combat-log-schema.test.ts \
        vitest.workspace.ts
git commit -m "feat(combat): add the combat_log table

One row per shot, not per kill. No location_id: the FKs are taken while
two player_stats rows are locked FOR UPDATE, so a locations FK would take
FOR KEY SHARE player-then-location and invert the established
location-first order (CLAUDE.md rule 6)."
```

---

### Task 3: Core hospital state module

Hospital is a **core state facility**, not a plugin — the same reasoning that keeps jail in core. A facility is a state that gates *every* plugin's routes, so its gate must live where the route loader is. This task builds the state functions; Task 4 wires the gate; Task 5 adds the routes.

Mirrors `apps/server/src/game/jail/status.ts` closely. One deliberate difference: **`settleHospital` publishes no event.** `GameEventSchema` has a `player.released` variant for jail but no hospital equivalent, and adding a core event variant is an SDK surface change (`CoreEventInput` is derived from `GameEvent`) that this feature does not need.

**Files:**
- Create: `apps/server/src/game/hospital/status.ts`
- Test: `apps/server/test/hospital-status.test.ts`
- Modify: `vitest.workspace.ts` (`@gl3/server:db-only` project)

**Interfaces:**
- Consumes: `Db`, `Tx` and `lockPlayersForUpdate` from `../../economy/ledger.js`; `playerStats`, `ranks` from `../../db/schema/index.js`.
- Produces, all exported from `apps/server/src/game/hospital/status.js`:
  - `interface HospitalStatus { hospitalised: boolean; until: string | null; remainingSeconds: number }`
  - `checkHospital(db: Db, playerId: string): Promise<HospitalStatus>` — read-only, does not settle.
  - `settleHospital(tx: Tx, playerId: string): Promise<HospitalStatus>` — clears an elapsed sentence and restores health to the rank's `max_health`. **Takes `tx`, not `db`.**
  - `sendToHospital(tx: Tx, playerId: string, seconds: number): Promise<Date>` — locks first, sets `health = 0` and `hospital_until`.
  - `maxHealthFor(tx: Tx, playerId: string): Promise<number>` — the player's rank `max_health`, or `100` when `rank_id` is null.

**Why `settleHospital` exists.** Expiry must not be lazy-on-read. A player whose sentence elapsed still has `health = 0` in the row until something touches them, so they could be attacked at 0 health and instantly re-killed. Combat calls this for both participants inside the lock, before any legality check.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/hospital-status.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { players, playerStats, ranks } from "../src/db/schema/index.js";
import { checkHospital, maxHealthFor, sendToHospital, settleHospital } from "../src/game/hospital/status.js";
import { testDb } from "./helpers/db.js";

// NOTE on `.slice(-8)`, which every test helper in this plan uses: take the
// uuid's TAIL, never `.slice(0, 8)`. A uuidv7's leading 48 bits are a
// millisecond timestamp, so the first 8 hex chars are its top 32 bits and only
// change every 2^16 ms (~65 seconds) — every row inserted inside the same
// minute would collide. That is a hard failure on a unique column
// (`players.username`, `gangs.name`) and confusing noise elsewhere.
async function makePlayer(db: Awaited<ReturnType<typeof testDb>>["db"], opts?: { rankMaxHealth?: number }) {
  const id = uuidv7();
  await db.insert(players).values({ id, username: `hp-${id.slice(-8)}` });
  let rankId: string | null = null;
  if (opts?.rankMaxHealth !== undefined) {
    rankId = uuidv7();
    await db.insert(ranks).values({
      id: rankId, name: `r-${rankId.slice(-8)}`, expRequired: 0n, maxHealth: opts.rankMaxHealth,
    });
  }
  await db.insert(playerStats).values({ playerId: id, health: 100, rankId });
  return id;
}

describe("hospital status", () => {
  it("reports a free player as not hospitalised", async () => {
    const { db } = await testDb();
    const id = await makePlayer(db);
    expect(await checkHospital(db, id)).toEqual({ hospitalised: false, until: null, remainingSeconds: 0 });
  });

  it("sendToHospital zeroes health and sets the deadline", async () => {
    const { db } = await testDb();
    const id = await makePlayer(db);

    const until = await db.transaction((tx) => sendToHospital(tx, id, 300));

    const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, id));
    expect(row?.health).toBe(0);
    expect(row?.hospitalUntil?.getTime()).toBe(until.getTime());

    const status = await checkHospital(db, id);
    expect(status.hospitalised).toBe(true);
    expect(status.remainingSeconds).toBeGreaterThan(290);
  });

  it("settleHospital leaves a live sentence alone", async () => {
    const { db } = await testDb();
    const id = await makePlayer(db);
    await db.transaction((tx) => sendToHospital(tx, id, 300));

    const status = await db.transaction((tx) => settleHospital(tx, id));

    expect(status.hospitalised).toBe(true);
    const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, id));
    expect(row?.health).toBe(0);
  });

  it("settleHospital restores full health once the sentence has elapsed", async () => {
    const { db } = await testDb();
    const id = await makePlayer(db, { rankMaxHealth: 140 });
    await db.update(playerStats)
      .set({ health: 0, hospitalUntil: new Date(Date.now() - 1000) })
      .where(eq(playerStats.playerId, id));

    const status = await db.transaction((tx) => settleHospital(tx, id));

    expect(status).toEqual({ hospitalised: false, until: null, remainingSeconds: 0 });
    const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, id));
    expect(row?.health).toBe(140);
    expect(row?.hospitalUntil).toBeNull();
  });

  it("maxHealthFor falls back to 100 when the player has no rank", async () => {
    const { db } = await testDb();
    const id = await makePlayer(db);
    expect(await db.transaction((tx) => maxHealthFor(tx, id))).toBe(100);
  });

  it("maxHealthFor reads the rank's max_health", async () => {
    const { db } = await testDb();
    const id = await makePlayer(db, { rankMaxHealth: 175 });
    expect(await db.transaction((tx) => maxHealthFor(tx, id))).toBe(175);
  });
});
```

Add `"test/hospital-status.test.ts"` to the `@gl3/server:db-only` project `include` list.

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run --project @gl3/server:db-only apps/server/test/hospital-status.test.ts
```

Expected: FAIL — `Cannot find module '../src/game/hospital/status.js'`.

- [ ] **Step 3: Write the implementation**

Create `apps/server/src/game/hospital/status.ts`:

```ts
import { and, eq, isNotNull } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { playerStats, ranks } from "../../db/schema/index.js";
import { lockPlayersForUpdate, type Tx } from "../../economy/ledger.js";

export interface HospitalStatus {
  hospitalised: boolean;
  until: string | null;
  remainingSeconds: number;
}

const FREE: HospitalStatus = { hospitalised: false, until: null, remainingSeconds: 0 };

/** Default when a player has no rank row — mirrors `ranks.max_health`'s own default. */
const DEFAULT_MAX_HEALTH = 100;

function statusFrom(hospitalUntil: Date | null): HospitalStatus {
  if (!hospitalUntil) return FREE;
  const remainingMs = hospitalUntil.getTime() - Date.now();
  if (remainingMs <= 0) return FREE;
  return {
    hospitalised: true,
    until: hospitalUntil.toISOString(),
    remainingSeconds: Math.ceil(remainingMs / 1000),
  };
}

/** Read-only. Does NOT clear an elapsed sentence — see settleHospital. */
export async function checkHospital(db: Db, playerId: string): Promise<HospitalStatus> {
  const [row] = await db.select({ hospitalUntil: playerStats.hospitalUntil })
    .from(playerStats).where(eq(playerStats.playerId, playerId));
  return statusFrom(row?.hospitalUntil ?? null);
}

/** The player's rank cap, or 100 when `rank_id` is null. */
export async function maxHealthFor(tx: Tx, playerId: string): Promise<number> {
  const [row] = await tx.select({ maxHealth: ranks.maxHealth })
    .from(playerStats)
    .leftJoin(ranks, eq(ranks.id, playerStats.rankId))
    .where(eq(playerStats.playerId, playerId));
  return row?.maxHealth ?? DEFAULT_MAX_HEALTH;
}

/**
 * The ONLY place an elapsed `hospital_until` is cleared, and it restores
 * health at the same time.
 *
 * Lazy-on-read is not good enough here, unlike jail: a player whose sentence
 * elapsed still has `health = 0` in the row until something touches them, so
 * they could be attacked at 0 health and instantly re-killed. Combat calls
 * this for BOTH participants immediately after taking the player locks, so
 * the restore cannot race the attack that reads its result.
 *
 * Takes `tx`, not `db`: every caller is already inside a transaction that
 * holds the relevant player lock.
 *
 * Publishes no event. `GameEventSchema` has `player.released` for jail but no
 * hospital equivalent, and adding a core variant is an SDK surface change
 * (`CoreEventInput` is derived from `GameEvent`) this feature does not need.
 *
 * The UPDATE repeats `hospital_until IS NOT NULL` so it is the arbiter of
 * "did THIS call perform the release" — the same shape as jail's
 * `releaseIfExpired`.
 */
export async function settleHospital(tx: Tx, playerId: string): Promise<HospitalStatus> {
  const [row] = await tx.select({ hospitalUntil: playerStats.hospitalUntil })
    .from(playerStats).where(eq(playerStats.playerId, playerId));
  if (!row) return FREE;

  const status = statusFrom(row.hospitalUntil);
  if (status.hospitalised) return status; // still admitted
  if (row.hospitalUntil === null) return FREE;

  const maxHealth = await maxHealthFor(tx, playerId);
  await tx.update(playerStats)
    .set({ hospitalUntil: null, health: maxHealth })
    .where(and(eq(playerStats.playerId, playerId), isNotNull(playerStats.hospitalUntil)));
  return FREE;
}

/**
 * Locks through `lockPlayersForUpdate` first, same as `applyBalanceChange`
 * and `sendToJail`, for the uniform ordering CLAUDE.md rule 6 requires. A
 * combat transaction already holds this lock, so the call is a no-op there —
 * but plugins reach this as `tx.hospital.sendToHospital` and a plugin
 * transaction may touch several players.
 */
export async function sendToHospital(tx: Tx, playerId: string, seconds: number): Promise<Date> {
  await lockPlayersForUpdate(tx, [playerId]);
  const until = new Date(Date.now() + seconds * 1000);
  await tx.update(playerStats)
    .set({ hospitalUntil: until, health: 0 })
    .where(eq(playerStats.playerId, playerId));
  return until;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run --project @gl3/server:db-only apps/server/test/hospital-status.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Run the full suite**

```bash
npm run verify > /tmp/verify.log 2>&1; echo "exit=$?"
```

Expected: `exit=0`.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/game/hospital/status.ts apps/server/test/hospital-status.test.ts vitest.workspace.ts
git commit -m "feat(hospital): add the core hospital state module

Jail and hospital are core state facilities: a facility gates every
plugin's routes, so its gate must live with the route loader.

settleHospital is not lazy-on-read like jail's releaseIfExpired, because
a player whose sentence elapsed still has health = 0 until something
touches them and could be attacked at 0 health and instantly re-killed."
```

---

### Task 4: `accessInHospital` route gate and `tx.hospital` on the ctx

Both new plugins need this, and it is the same mechanism jail already uses. Default `true`, so the nine existing plugins are unaffected.

**Files:**
- Modify: `packages/plugin-sdk/src/route.ts`
- Modify: `packages/plugin-sdk/src/ctx.ts` (`PluginTx`)
- Modify: `apps/server/src/plugins/routes.ts` (the gate)
- Modify: `apps/server/src/plugins/ctx.ts` (`tx.hospital`)
- Test: `apps/server/test/plugin-hospital-gate.test.ts`
- Modify: `vitest.workspace.ts` (`@gl3/server` project — needs both Postgres and Redis)

**Interfaces:**
- Consumes: `settleHospital`, `sendToHospital` from `../game/hospital/status.js` (Task 3).
- Produces:
  - `RouteDefinition.accessInHospital?: boolean` → resolved `PluginRoute.accessInHospital: boolean` (default `true`).
  - `PluginTx.hospital: { sendToHospital(playerId: string, seconds: number): Promise<Date> }`.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/plugin-hospital-gate.test.ts`:

```ts
import { definePlugin, route } from "@gl3/plugin-sdk";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { playerStats } from "../src/db/schema/index.js";
import { bootTestServer } from "./helpers/server.js";
import { testDb } from "./helpers/db.js";

const gatedRoute = route({
  method: "POST",
  path: "/api/gate-probe/act",
  accessInHospital: false,
  handler: async () => ({ status: 200, body: { ok: true } }),
});

const openRoute = route({
  method: "GET",
  path: "/api/gate-probe/read",
  handler: async () => ({ status: 200, body: { ok: true } }),
});

const probePlugin = definePlugin({
  id: "gate-probe",
  version: "1.0.0",
  basePaths: ["/api/gate-probe"],
  routes: [gatedRoute, openRoute],
});

describe("accessInHospital gate", () => {
  let app: FastifyInstance;
  let close: () => Promise<void>;
  let token: string;
  let playerId: string;

  beforeAll(async () => {
    ({ app, close } = await bootTestServer({ plugins: [probePlugin] }));
    const res = await app.inject({
      method: "POST", url: "/api/auth/register",
      payload: { username: `hosp-${Date.now()}`, password: "correct horse battery" },
    });
    const body = res.json();
    token = body.token;
    // POST /api/auth/register answers 201 with a FLAT
    // `{ token, playerId, username }` (auth/routes.ts:88) — there is no nested
    // `player` object. Every test in this plan that registers a player uses
    // this shape.
    playerId = body.playerId;
  });

  afterAll(async () => { await close(); });

  it("defaults to true — an ungated route answers while hospitalised", async () => {
    const { db } = await testDb();
    await db.update(playerStats)
      .set({ hospitalUntil: new Date(Date.now() + 60_000), health: 0 })
      .where(eq(playerStats.playerId, playerId));

    const res = await app.inject({
      method: "GET", url: "/api/gate-probe/read",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("answers 423 with retry-after when the route opts out", async () => {
    const { db } = await testDb();
    await db.update(playerStats)
      .set({ hospitalUntil: new Date(Date.now() + 60_000), health: 0 })
      .where(eq(playerStats.playerId, playerId));

    const res = await app.inject({
      method: "POST", url: "/api/gate-probe/act",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(423);
    expect(res.json()).toMatchObject({ error: "hospitalised" });
    expect(res.headers["retry-after"]).toBeDefined();
  });

  it("settles an elapsed sentence and lets the request through", async () => {
    const { db } = await testDb();
    await db.update(playerStats)
      .set({ hospitalUntil: new Date(Date.now() - 1000), health: 0 })
      .where(eq(playerStats.playerId, playerId));

    const res = await app.inject({
      method: "POST", url: "/api/gate-probe/act",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(row?.hospitalUntil).toBeNull();
    expect(row?.health).toBe(100);
  });
});
```

The `bootTestServer` register response shape may differ — read `apps/server/test/bank.test.ts`'s registration block and copy it exactly rather than trusting the payload above.

Add `"test/plugin-hospital-gate.test.ts"` to the `@gl3/server` project `include` list.

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run --project @gl3/server apps/server/test/plugin-hospital-gate.test.ts
```

Expected: FAIL — `accessInHospital` is not a known property on the route definition (TypeScript), and the 423 test gets a 200.

- [ ] **Step 3: Add `accessInHospital` to the SDK route type**

In `packages/plugin-sdk/src/route.ts`, alongside the existing `accessInJail`:

- in the input definition interface, add:
  ```ts
  /**
   * Whether the route answers while the player is in hospital. Defaults to
   * `true`, so every route that predates the hospital facility is unaffected.
   * An action a wounded player should not be able to take sets `false` and
   * the loader answers 423 + `retry-after`.
   */
  accessInHospital?: boolean;
  ```
- in the resolved interface, add `accessInHospital: boolean;`
- in the `route()` body, add `accessInHospital: def.accessInHospital ?? true,` next to the existing `accessInJail` default.

- [ ] **Step 4: Add `tx.hospital` to the SDK ctx type**

In `packages/plugin-sdk/src/ctx.ts`, inside `PluginTx`, directly after the `jail` member:

```ts
  /**
   * `sendToHospital` takes a player lock internally (ascending id order, same
   * as `economy.applyBalanceChange` and `jail.sendToJail`), so a transaction
   * that also moves money is already safe whichever order a plugin calls them
   * in. Sets `health = 0` alongside the deadline.
   */
  readonly hospital: { sendToHospital(playerId: string, seconds: number): Promise<Date> };
```

- [ ] **Step 5: Implement `tx.hospital` in the ctx**

In `apps/server/src/plugins/ctx.ts`, add the import:

```ts
import { sendToHospital } from "../game/hospital/status.js";
```

and, next to the existing `jail:` member of the returned `PluginTx`:

```ts
          hospital: { sendToHospital: (playerId, seconds) => sendToHospital(tx, playerId, seconds) },
```

- [ ] **Step 6: Implement the loader gate**

In `apps/server/src/plugins/routes.ts`, immediately after the existing `if (!pluginRoute.accessInJail && playerId !== undefined) { ... }` block:

```ts
          if (!pluginRoute.accessInHospital && playerId !== undefined) {
            // settleHospital needs a transaction (it may UPDATE), unlike
            // jail's releaseIfExpired which takes `db`. Restoring health on
            // expiry is a write, and it must not be observed half-applied by
            // the handler that runs immediately after.
            const hospital = await deps.db.transaction((tx) => settleHospital(tx, playerId));
            if (hospital.hospitalised) {
              reply.header("retry-after", String(hospital.remainingSeconds));
              return reply.code(423).send({
                error: "hospitalised",
                remainingSeconds: hospital.remainingSeconds,
              });
            }
          }
```

with the import:

```ts
import { settleHospital } from "../game/hospital/status.js";
```

- [ ] **Step 7: Run the test to verify it passes**

```bash
npx vitest run --project @gl3/server apps/server/test/plugin-hospital-gate.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 8: Run the full suite**

```bash
npm run verify > /tmp/verify.log 2>&1; echo "exit=$?"
```

Expected: `exit=0`. Nine existing plugins take the `true` default, so no other file should change behaviour.

- [ ] **Step 9: Commit**

```bash
git add packages/plugin-sdk/src/route.ts packages/plugin-sdk/src/ctx.ts \
        apps/server/src/plugins/routes.ts apps/server/src/plugins/ctx.ts \
        apps/server/test/plugin-hospital-gate.test.ts vitest.workspace.ts
git commit -m "feat(sdk): add the accessInHospital route gate and tx.hospital

Mirrors the jail gate. Defaults to true so the nine shipped plugins are
unaffected. The gate settles an elapsed sentence inside a transaction —
unlike jail's releaseIfExpired, restoring health on expiry is a write."
```

---

### Task 5: Hospital HTTP routes

**Files:**
- Create: `apps/server/src/game/hospital/routes.ts`
- Modify: `apps/server/src/app.ts` (register alongside `registerJailRoutes`)
- Test: `apps/server/test/hospital.test.ts`
- Modify: `vitest.workspace.ts` (`@gl3/server` project)

**Interfaces:**
- Consumes: `checkHospital`, `settleHospital`, `maxHealthFor` (Task 3); `loadSettings` output via `buildApp` (Task 1); `applyBalanceChange`, `lockPlayersForUpdate`, `InsufficientFundsError` from `../../economy/ledger.js`.
- Produces: `registerHospitalRoutes(app, db, settings, requireAuth): void`, exported from `apps/server/src/game/hospital/routes.js`.

Two routes:

- `GET /api/hospital` → `{ health, maxHealth, hospitalised, until, remainingSeconds, dischargeCost }` where `dischargeCost` is a **decimal string**.
- `POST /api/hospital/discharge` → pays `remainingSeconds × hospital.discharge_cost_per_second`, clears the sentence, restores health. `409 not_hospitalised` when free, `409 insufficient_funds` when broke.

`discharge` is deliberately reachable while jailed — jail and hospital are independent sentences, and being jailed should not block paying off the ward. Core routes are not subject to the plugin loader's gates anyway; this is recorded so nobody adds a jail check later thinking it was an oversight.

**Setting:** `hospital.discharge_cost_per_second`, default `"1000"`. Parsed with `BigInt()` inside a try/catch — a malformed setting falls back to the default rather than 500ing every request.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/hospital.test.ts`. Copy the registration/auth preamble verbatim from `apps/server/test/bank.test.ts` so the payload shape and token extraction match. The body of the describe block:

```ts
  it("reports a free player", async () => {
    const res = await app.inject({
      method: "GET", url: "/api/hospital",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ hospitalised: false, until: null, remainingSeconds: 0 });
  });

  it("409s a discharge for a player who is not hospitalised", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/hospital/discharge",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "not_hospitalised" });
  });

  it("quotes a discharge cost proportional to the remaining sentence", async () => {
    const { db } = await testDb();
    await db.update(playerStats)
      .set({ hospitalUntil: new Date(Date.now() + 100_000), health: 0 })
      .where(eq(playerStats.playerId, playerId));

    const res = await app.inject({
      method: "GET", url: "/api/hospital",
      headers: { authorization: `Bearer ${token}` },
    });

    const body = res.json();
    expect(body.hospitalised).toBe(true);
    // 100s remaining × the default 1000/second, allowing one second of drift.
    expect(BigInt(body.dischargeCost)).toBeGreaterThanOrEqual(99_000n);
    expect(BigInt(body.dischargeCost)).toBeLessThanOrEqual(100_000n);
  });

  it("discharges for cash, restores health, and ledgers the payment", async () => {
    const { db } = await testDb();
    await db.update(playerStats)
      .set({ cash: 500_000n, hospitalUntil: new Date(Date.now() + 60_000), health: 0 })
      .where(eq(playerStats.playerId, playerId));

    const res = await app.inject({
      method: "POST", url: "/api/hospital/discharge",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.health).toBe(100);

    const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(row?.hospitalUntil).toBeNull();
    expect(row?.health).toBe(100);
    expect(row?.cash).toBeLessThan(500_000n);

    const ledger = await db.select().from(transactions).where(eq(transactions.playerId, playerId));
    expect(ledger.some((t) => t.reason === "hospital.discharge")).toBe(true);
    // sum(ledger) == balance, the invariant every money path must hold.
    const sum = ledger.reduce((acc, t) => acc + (t.balanceKind === "cash" ? t.amount : 0n), 0n);
    expect(sum).toBe(row?.cash);
  });

  it("409s when the player cannot afford the discharge", async () => {
    const { db } = await testDb();
    await db.update(playerStats)
      .set({ cash: 1n, hospitalUntil: new Date(Date.now() + 600_000), health: 0 })
      .where(eq(playerStats.playerId, playerId));

    const res = await app.inject({
      method: "POST", url: "/api/hospital/discharge",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "insufficient_funds" });
  });
```

The cash-sum assertion assumes the test player's only cash ledger rows come from this file. If registration seeds a starting balance without a ledger row, drop that one assertion and rely on `economy-invariant.test.ts` (Task 15) instead — do not weaken it to `toBeGreaterThan`.

Imports needed: `playerStats`, `transactions` from `../src/db/schema/index.js`; `eq` from `drizzle-orm`; `testDb` from `./helpers/db.js`.

Add `"test/hospital.test.ts"` to the `@gl3/server` project `include` list.

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run --project @gl3/server apps/server/test/hospital.test.ts
```

Expected: FAIL — 404 on both routes.

- [ ] **Step 3: Write the routes**

Create `apps/server/src/game/hospital/routes.ts`:

```ts
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../../db/client.js";
import { playerStats } from "../../db/schema/index.js";
import { applyBalanceChange, InsufficientFundsError } from "../../economy/ledger.js";
import { checkHospital, maxHealthFor, settleHospital } from "./status.js";

const DEFAULT_COST_PER_SECOND = 1000n;

/**
 * A malformed setting falls back to the default rather than throwing on every
 * request. `settings` is admin-edited free text; a typo there must not take
 * the route down.
 */
function costPerSecond(settings: Record<string, string>): bigint {
  const raw = settings["hospital.discharge_cost_per_second"];
  if (raw === undefined) return DEFAULT_COST_PER_SECOND;
  try {
    const parsed = BigInt(raw);
    return parsed >= 0n ? parsed : DEFAULT_COST_PER_SECOND;
  } catch {
    return DEFAULT_COST_PER_SECOND;
  }
}

export function registerHospitalRoutes(
  app: FastifyInstance,
  db: Db,
  settings: Record<string, string>,
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
): void {
  app.get("/api/hospital", { preHandler: requireAuth }, async (request, reply) => {
    const playerId = request.playerId;
    if (!playerId) return reply.code(401).send({ error: "unauthorized" });

    // Settle first, so a GET after the sentence elapsed reports the restored
    // health rather than the stale 0.
    await db.transaction((tx) => settleHospital(tx, playerId));

    const status = await checkHospital(db, playerId);
    const [row] = await db.select({ health: playerStats.health })
      .from(playerStats).where(eq(playerStats.playerId, playerId));
    const maxHealth = await db.transaction((tx) => maxHealthFor(tx, playerId));

    return reply.send({
      health: row?.health ?? 0,
      maxHealth,
      hospitalised: status.hospitalised,
      until: status.until,
      remainingSeconds: status.remainingSeconds,
      // Money crosses the wire as a decimal string, never a JSON number.
      dischargeCost: (BigInt(status.remainingSeconds) * costPerSecond(settings)).toString(),
    });
  });

  /**
   * Reachable while jailed, deliberately: jail and hospital are independent
   * sentences and being jailed must not block paying off the ward.
   */
  app.post("/api/hospital/discharge", { preHandler: requireAuth }, async (request, reply) => {
    const playerId = request.playerId;
    if (!playerId) return reply.code(401).send({ error: "unauthorized" });

    try {
      const result = await db.transaction(async (tx) => {
        // settleHospital takes no lock of its own; applyBalanceChange below
        // locks this player's row, and both run in this one transaction.
        const settled = await settleHospital(tx, playerId);
        if (!settled.hospitalised) return { kind: "free" as const };

        const cost = BigInt(settled.remainingSeconds) * costPerSecond(settings);
        const cash = await applyBalanceChange(tx, {
          playerId, amount: -cost, kind: "cash", reason: "hospital.discharge",
        });

        const maxHealth = await maxHealthFor(tx, playerId);
        await tx.update(playerStats)
          .set({ hospitalUntil: null, health: maxHealth })
          .where(eq(playerStats.playerId, playerId));

        return { kind: "discharged" as const, cash, cost, health: maxHealth };
      });

      if (result.kind === "free") return reply.code(409).send({ error: "not_hospitalised" });
      return reply.send({
        health: result.health,
        cash: result.cash.toString(),
        paid: result.cost.toString(),
      });
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        return reply.code(409).send({ error: "insufficient_funds" });
      }
      throw error;
    }
  });
}
```

- [ ] **Step 4: Register the routes**

In `apps/server/src/app.ts`, next to the existing `registerJailRoutes(...)` call:

```ts
registerHospitalRoutes(app, deps.db, loadedSettings, app.requireAuth);
```

using the `loadedSettings` value introduced in Task 1, plus the import:

```ts
import { registerHospitalRoutes } from "./game/hospital/routes.js";
```

Match the exact argument shape `registerJailRoutes` is called with in this file — the `requireAuth` reference may be `app.requireAuth` or a local.

- [ ] **Step 5: Run the test to verify it passes**

```bash
npx vitest run --project @gl3/server apps/server/test/hospital.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 6: Run the full suite**

```bash
npm run verify > /tmp/verify.log 2>&1; echo "exit=$?"
```

Expected: `exit=0`.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/game/hospital/routes.ts apps/server/src/app.ts \
        apps/server/test/hospital.test.ts vitest.workspace.ts
git commit -m "feat(hospital): add the status and paid-discharge routes

Discharge is reachable while jailed on purpose: jail and hospital are
independent sentences. A malformed discharge_cost_per_second setting
falls back to the default rather than 500ing every request."
```

---

### Task 6: `inventory` plugin — package, effect schemas, and `GET /api/inventory`

This task creates the package and all eight registration sites, so it is larger than its route list suggests. The two write routes follow in Tasks 7 and 8.

**Files:**
- Create: `packages/plugins/inventory/package.json`
- Create: `packages/plugins/inventory/tsconfig.json`
- Create: `packages/plugins/inventory/src/schema.ts`
- Create: `packages/plugins/inventory/src/effects.ts`
- Create: `packages/plugins/inventory/src/index.ts`
- Modify: `apps/server/package.json`, `apps/server/tsconfig.json`, root `tsconfig.json`, `vitest.workspace.ts`, `apps/server/src/plugins/core-plugins.ts`, `Dockerfile.server`
- Test: `apps/server/test/inventory.test.ts`

**Interfaces:**
- Produces, from `packages/plugins/inventory/src/effects.js`:
  - `WeaponEffectsSchema` → `{ accuracy, damageMin, damageMax, bulletsPerShot, critChance, critMultiplier, armorPierce, minRankExp }`
  - `ArmorEffectsSchema` → `{ armor }`
  - `ConsumableEffectsSchema` → `{ heal }`
- Produces: default export `inventoryPlugin` (id `inventory`, `basePaths: ["/api/inventory"]`).

- [ ] **Step 1: Create the package files**

`packages/plugins/inventory/package.json` — copy `packages/plugins/bullets/package.json` verbatim and change `"name"` to `"@gl3/plugin-inventory"`.

`packages/plugins/inventory/tsconfig.json` — copy `packages/plugins/bullets/tsconfig.json` verbatim (no changes; the relative paths are identical).

- [ ] **Step 2: Write the effect schemas**

Create `packages/plugins/inventory/src/effects.ts`:

```ts
import { z } from "zod";

/**
 * `items.effects` is jsonb, so it is an external boundary and is zod-parsed on
 * every read — never trusted raw.
 *
 * Every weapon field except accuracy and the damage range DEFAULTS, so a
 * migrated V2 item that carried only `damage` (V2's itemEffects has no
 * accuracy, no range, and none of the rest) parses without backfill.
 */
export const WeaponEffectsSchema = z.object({
  accuracy: z.number().int().min(0).max(100),
  damageMin: z.number().int().nonnegative(),
  damageMax: z.number().int().nonnegative(),
  bulletsPerShot: z.number().int().positive().default(1),
  critChance: z.number().int().min(0).max(100).default(0),
  /** A float, and the only one. Damage stays integer: floor(damage × this). */
  critMultiplier: z.number().min(1).default(1),
  armorPierce: z.number().int().nonnegative().default(0),
  /**
   * An exp threshold, not a rank id. Ranks are UUID rows ordered by
   * exp_required, so "rank >= X" is really an exp comparison — this compares
   * against player_stats.exp directly, with no join and no dangling pointer
   * when an admin edits or deletes a rank row.
   */
  minRankExp: z.number().int().nonnegative().default(0),
}).refine((e) => e.damageMax >= e.damageMin, {
  message: "damageMax must be >= damageMin",
});

export const ArmorEffectsSchema = z.object({
  armor: z.number().int().nonnegative(),
});

export const ConsumableEffectsSchema = z.object({
  heal: z.number().int().positive(),
});

export type WeaponEffects = z.infer<typeof WeaponEffectsSchema>;
export type ArmorEffects = z.infer<typeof ArmorEffectsSchema>;
export type ConsumableEffects = z.infer<typeof ConsumableEffectsSchema>;

export const ITEM_TYPE_WEAPON = "weapon";
export const ITEM_TYPE_ARMOR = "armor";
export const ITEM_TYPE_CONSUMABLE = "consumable";
```

- [ ] **Step 3: Write the table mirrors**

Create `packages/plugins/inventory/src/schema.ts`:

```ts
import { bigint, integer, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";

/**
 * Read/write mirrors of core-owned tables — the pattern
 * `packages/plugins/bullets/src/schema.ts` established. Column names and
 * types match `apps/server/src/db/schema/*.ts` exactly. None is declared in
 * this plugin's manifest `tables` map and none gets a migration here: core
 * already owns and migrates all four.
 *
 * Only the columns this plugin touches are listed.
 */
export const items = pgTable("items", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  itemType: text("item_type").notNull(),
  effects: jsonb("effects").notNull(),
});

export const playerItems = pgTable("player_items", {
  playerId: uuid("player_id").notNull(),
  itemId: uuid("item_id").notNull(),
  qty: integer("qty").notNull(),
});

export const playerStats = pgTable("player_stats", {
  playerId: uuid("player_id").primaryKey(),
  exp: bigint("exp", { mode: "bigint" }).notNull(),
  health: integer("health").notNull(),
  rankId: uuid("rank_id"),
  weaponItemId: uuid("weapon_item_id"),
  armorItemId: uuid("armor_item_id"),
});

export const ranks = pgTable("ranks", {
  id: uuid("id").primaryKey(),
  maxHealth: integer("max_health").notNull(),
});
```

- [ ] **Step 4: Write the GET route and the manifest**

Create `packages/plugins/inventory/src/index.ts`:

```ts
import { definePlugin, PluginError, route } from "@gl3/plugin-sdk";
import { and, eq, gt } from "drizzle-orm";
import { items, playerItems, playerStats } from "./schema.js";

const listRoute = route({
  method: "GET",
  path: "/api/inventory",
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      const owned = await tx.db
        .select({
          itemId: items.id,
          name: items.name,
          itemType: items.itemType,
          effects: items.effects,
          qty: playerItems.qty,
        })
        .from(playerItems)
        .innerJoin(items, eq(items.id, playerItems.itemId))
        .where(and(eq(playerItems.playerId, player.id), gt(playerItems.qty, 0)));

      const [stats] = await tx.db
        .select({
          weaponItemId: playerStats.weaponItemId,
          armorItemId: playerStats.armorItemId,
        })
        .from(playerStats)
        .where(eq(playerStats.playerId, player.id));

      return {
        status: 200,
        body: {
          items: owned,
          equipped: {
            weaponItemId: stats?.weaponItemId ?? null,
            armorItemId: stats?.armorItemId ?? null,
          },
        },
      };
    });
  },
});

export default definePlugin({
  id: "inventory",
  version: "1.0.0",
  basePaths: ["/api/inventory"],
  routes: [listRoute],
  // No `menu`, `pages`, `events` or `jobs`: plugin-manifest-endpoint.test.ts:87
  // asserts a no-arg boot answers GET /api/plugins with exactly
  // { menu: [], pages: [], events: [] }, and buildApp throws at boot if a core
  // plugin declares jobs.
});
```

`effects` comes back as `unknown` from jsonb; the GET returns it as-is (the client renders it) and the write routes parse it. Do not cast it here.

- [ ] **Step 5: Complete all eight registration sites**

1. `apps/server/package.json` — add `"@gl3/plugin-inventory": "*",` to `dependencies`, then run `npm install`.
2. `apps/server/tsconfig.json` — add `{ "path": "../../packages/plugins/inventory" }` to `references`.
3. Root `tsconfig.json` — add `{ "path": "./packages/plugins/inventory" },` to `references`.
4. `vitest.workspace.ts` `srcAliases` — add:
   ```ts
         "@gl3/plugin-inventory": fileURLToPath(
           new URL("./packages/plugins/inventory/src/index.ts", import.meta.url),
         ),
   ```
5. `apps/server/src/plugins/core-plugins.ts` — `import inventoryPlugin from "@gl3/plugin-inventory";` and append `inventoryPlugin` to the `CORE_PLUGINS` array.
6. `Dockerfile.server` — five lines, matching the `gangs` pattern at lines 61, 89, 90, 135, 154:
   ```
   COPY packages/plugins/inventory/package.json packages/plugins/inventory/
   COPY packages/plugins/inventory/tsconfig.json packages/plugins/inventory/tsconfig.json
   COPY packages/plugins/inventory/src packages/plugins/inventory/src
   COPY packages/plugins/inventory/package.json packages/plugins/inventory/
   COPY --from=builder /app/packages/plugins/inventory/dist packages/plugins/inventory/dist
   ```
   placed each immediately after its `gangs` counterpart, in the same stage.
7. `vitest.workspace.ts` — add `"test/inventory.test.ts"` to the `@gl3/server` project `include` list.

Verify sites 3 and 6:

```bash
grep -c "packages/plugins/inventory" Dockerfile.server   # expect 5
npx tsc --build --force apps/server/tsconfig.json         # expect clean
```

- [ ] **Step 6: Write the failing test**

Create `apps/server/test/inventory.test.ts`. Copy the registration preamble from `apps/server/test/bank.test.ts`. Add a helper that seeds an item and grants it:

```ts
async function seedItem(
  db: Awaited<ReturnType<typeof testDb>>["db"],
  itemType: string,
  effects: Record<string, unknown>,
): Promise<string> {
  const id = uuidv7();
  await db.insert(items).values({ id, name: `${itemType}-${id.slice(-8)}`, itemType, effects });
  return id;
}

async function grant(
  db: Awaited<ReturnType<typeof testDb>>["db"],
  playerId: string, itemId: string, qty: number,
): Promise<void> {
  await db.insert(playerItems).values({ playerId, itemId, qty });
}
```

and the first two cases:

```ts
  it("returns an empty inventory for a new player", async () => {
    const res = await app.inject({
      method: "GET", url: "/api/inventory",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [], equipped: { weaponItemId: null, armorItemId: null } });
  });

  it("lists owned items with their effects, and hides zero-qty rows", async () => {
    const { db } = await testDb();
    const pistol = await seedItem(db, "weapon", { accuracy: 60, damageMin: 5, damageMax: 15 });
    const gone = await seedItem(db, "consumable", { heal: 20 });
    await grant(db, playerId, pistol, 1);
    await grant(db, playerId, gone, 0);

    const res = await app.inject({
      method: "GET", url: "/api/inventory",
      headers: { authorization: `Bearer ${token}` },
    });

    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ itemId: pistol, itemType: "weapon", qty: 1 });
    expect(body.items[0].effects).toMatchObject({ accuracy: 60, damageMin: 5, damageMax: 15 });
  });
```

- [ ] **Step 7: Run the test to verify it passes**

```bash
npx vitest run --project @gl3/server apps/server/test/inventory.test.ts
```

Expected: PASS, 2 tests. If it 404s, the plugin is not in `CORE_PLUGINS` or the `srcAliases` entry is missing.

- [ ] **Step 8: Run the full suite**

```bash
npm run verify > /tmp/verify.log 2>&1; echo "exit=$?"
```

Expected: `exit=0`.

- [ ] **Step 9: Commit**

```bash
git add packages/plugins/inventory apps/server/package.json apps/server/tsconfig.json \
        tsconfig.json vitest.workspace.ts apps/server/src/plugins/core-plugins.ts \
        Dockerfile.server apps/server/test/inventory.test.ts package-lock.json
git commit -m "feat(inventory): add the inventory plugin with GET /api/inventory

Effect schemas default every weapon field except accuracy and the damage
range, so a migrated V2 item carrying only 'damage' parses without
backfill. minRankExp is an exp threshold rather than a rank id: ranks are
admin-editable rows, and an exp comparison cannot dangle."
```

---

### Task 7: `PUT /api/inventory/equip`

**Files:**
- Modify: `packages/plugins/inventory/src/index.ts`
- Modify: `apps/server/test/inventory.test.ts`

**Interfaces:**
- Consumes: `WeaponEffectsSchema`, `ArmorEffectsSchema`, `ITEM_TYPE_WEAPON`, `ITEM_TYPE_ARMOR` from `./effects.js`; `items`, `playerItems`, `playerStats` from `./schema.js`.
- Produces: `equipRoute` added to the manifest's `routes` array.

Body: `{ weaponItemId?: uuid | null, armorItemId?: uuid | null }`. An explicit `null` unequips that slot; an absent key leaves it alone. Distinguishing the two needs `.optional().nullable()` plus a `key in body` check — `undefined` and `null` must not collapse.

Rejects: `409 not_owned`, `400 wrong_slot`, `409 rank_too_low`. `accessInJail: false`, `accessInHospital: false`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/server/test/inventory.test.ts`:

```ts
  it("equips a weapon and an armor in one call", async () => {
    const { db } = await testDb();
    const pistol = await seedItem(db, "weapon", { accuracy: 60, damageMin: 5, damageMax: 15 });
    const vest = await seedItem(db, "armor", { armor: 20 });
    await grant(db, playerId, pistol, 1);
    await grant(db, playerId, vest, 1);

    const res = await app.inject({
      method: "PUT", url: "/api/inventory/equip",
      headers: { authorization: `Bearer ${token}` },
      payload: { weaponItemId: pistol, armorItemId: vest },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ weaponItemId: pistol, armorItemId: vest });
  });

  it("unequips with an explicit null and leaves an absent slot alone", async () => {
    const { db } = await testDb();
    const pistol = await seedItem(db, "weapon", { accuracy: 60, damageMin: 5, damageMax: 15 });
    const vest = await seedItem(db, "armor", { armor: 20 });
    await grant(db, playerId, pistol, 1);
    await grant(db, playerId, vest, 1);
    await app.inject({
      method: "PUT", url: "/api/inventory/equip",
      headers: { authorization: `Bearer ${token}` },
      payload: { weaponItemId: pistol, armorItemId: vest },
    });

    const res = await app.inject({
      method: "PUT", url: "/api/inventory/equip",
      headers: { authorization: `Bearer ${token}` },
      payload: { weaponItemId: null },
    });

    // weapon cleared by the explicit null; armor untouched because absent.
    expect(res.json()).toEqual({ weaponItemId: null, armorItemId: vest });
  });

  it("409s an item the player does not own", async () => {
    const { db } = await testDb();
    const pistol = await seedItem(db, "weapon", { accuracy: 60, damageMin: 5, damageMax: 15 });

    const res = await app.inject({
      method: "PUT", url: "/api/inventory/equip",
      headers: { authorization: `Bearer ${token}` },
      payload: { weaponItemId: pistol },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "not_owned" });
  });

  it("400s armor in the weapon slot", async () => {
    const { db } = await testDb();
    const vest = await seedItem(db, "armor", { armor: 20 });
    await grant(db, playerId, vest, 1);

    const res = await app.inject({
      method: "PUT", url: "/api/inventory/equip",
      headers: { authorization: `Bearer ${token}` },
      payload: { weaponItemId: vest },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "wrong_slot" });
  });

  it("409s a weapon whose minRankExp exceeds the player's exp", async () => {
    const { db } = await testDb();
    const cannon = await seedItem(db, "weapon", {
      accuracy: 90, damageMin: 50, damageMax: 90, minRankExp: 1_000_000,
    });
    await grant(db, playerId, cannon, 1);
    await db.update(playerStats).set({ exp: 10n }).where(eq(playerStats.playerId, playerId));

    const res = await app.inject({
      method: "PUT", url: "/api/inventory/equip",
      headers: { authorization: `Bearer ${token}` },
      payload: { weaponItemId: cannon },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "rank_too_low" });
  });
```

- [ ] **Step 2: Run to verify they fail**

```bash
npx vitest run --project @gl3/server apps/server/test/inventory.test.ts
```

Expected: FAIL — 404 on `PUT /api/inventory/equip`.

- [ ] **Step 3: Write the route**

Add to `packages/plugins/inventory/src/index.ts` (extend the existing imports with `PluginError`, `z`, `ArmorEffectsSchema`, `WeaponEffectsSchema`, `ITEM_TYPE_ARMOR`, `ITEM_TYPE_WEAPON`, and `playerStats`):

```ts
/**
 * `.optional().nullable()` on both, because `undefined` and `null` mean
 * different things here and must not collapse: an absent key leaves the slot
 * alone, an explicit `null` unequips it. The handler distinguishes them with
 * an `in` check, not a truthiness test.
 */
const EquipSchema = z.object({
  weaponItemId: z.string().uuid().nullable().optional(),
  armorItemId: z.string().uuid().nullable().optional(),
});

const equipRoute = route({
  method: "PUT",
  path: "/api/inventory/equip",
  accessInJail: false,
  accessInHospital: false,
  body: EquipSchema,
  handler: async (ctx, { body }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    const wantsWeapon = "weaponItemId" in body;
    const wantsArmor = "armorItemId" in body;

    return ctx.transaction(async (tx) => {
      // The player's own row only — no second participant, so the single-id
      // form of the standard ascending-order lock.
      await tx.locks.player([player.id]);

      const [stats] = await tx.db
        .select({
          exp: playerStats.exp,
          weaponItemId: playerStats.weaponItemId,
          armorItemId: playerStats.armorItemId,
        })
        .from(playerStats)
        .where(eq(playerStats.playerId, player.id));
      if (!stats) throw new PluginError("unauthorized", 401);

      /** Verifies ownership, slot, and (for weapons) the rank gate. */
      const validate = async (itemId: string, slot: "weapon" | "armor"): Promise<void> => {
        const [owned] = await tx.db
          .select({ itemType: items.itemType, effects: items.effects, qty: playerItems.qty })
          .from(playerItems)
          .innerJoin(items, eq(items.id, playerItems.itemId))
          .where(and(eq(playerItems.playerId, player.id), eq(playerItems.itemId, itemId)));

        if (!owned || owned.qty <= 0) throw new PluginError("not_owned", 409);

        const expectedType = slot === "weapon" ? ITEM_TYPE_WEAPON : ITEM_TYPE_ARMOR;
        if (owned.itemType !== expectedType) throw new PluginError("wrong_slot", 400);

        if (slot === "weapon") {
          const parsed = WeaponEffectsSchema.safeParse(owned.effects);
          // A malformed weapon is unusable rather than a 500: the jsonb is an
          // external boundary and an admin can put anything in it.
          if (!parsed.success) throw new PluginError("wrong_slot", 400);
          if (BigInt(parsed.data.minRankExp) > stats.exp) {
            throw new PluginError("rank_too_low", 409);
          }
        } else {
          const parsed = ArmorEffectsSchema.safeParse(owned.effects);
          if (!parsed.success) throw new PluginError("wrong_slot", 400);
        }
      };

      const nextWeapon = wantsWeapon ? (body.weaponItemId ?? null) : stats.weaponItemId;
      const nextArmor = wantsArmor ? (body.armorItemId ?? null) : stats.armorItemId;

      if (wantsWeapon && body.weaponItemId != null) await validate(body.weaponItemId, "weapon");
      if (wantsArmor && body.armorItemId != null) await validate(body.armorItemId, "armor");

      await tx.db
        .update(playerStats)
        .set({ weaponItemId: nextWeapon, armorItemId: nextArmor })
        .where(eq(playerStats.playerId, player.id));

      return { status: 200, body: { weaponItemId: nextWeapon, armorItemId: nextArmor } };
    });
  },
});
```

Add `equipRoute` to the manifest's `routes` array.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run --project @gl3/server apps/server/test/inventory.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Run the full suite, then commit**

```bash
npm run verify > /tmp/verify.log 2>&1; echo "exit=$?"
git add packages/plugins/inventory/src/index.ts apps/server/test/inventory.test.ts
git commit -m "feat(inventory): add PUT /api/inventory/equip

An absent slot key leaves the slot alone; an explicit null unequips it.
A malformed effects jsonb makes the item unusable (400) rather than a
500 — the column is an external boundary an admin can put anything in."
```

---

### Task 8: `POST /api/inventory/use/:itemId` and the seeded starter items

**Files:**
- Modify: `packages/plugins/inventory/src/index.ts`
- Modify: `apps/server/src/db/seed.ts`
- Modify: `apps/server/test/inventory.test.ts`

**Interfaces:**
- Consumes: `ConsumableEffectsSchema`, `ITEM_TYPE_CONSUMABLE` from `./effects.js`; `ranks` from `./schema.js`.
- Produces: `useRoute` added to the manifest.

Consumables only. Decrements with `UPDATE … qty = qty - 1 WHERE qty > 0 RETURNING` — never a read-then-write, which is the same check-then-act shape rule 2 forbids on Redis and is equally wrong here. Heals up to the rank's `max_health`. Rejects: `409 not_owned`, `400 wrong_slot`, `409 already_full`. `accessInHospital: false` is what structurally enforces "heal items do not clear hospital."

- [ ] **Step 1: Write the failing tests**

Append to `apps/server/test/inventory.test.ts`:

```ts
  it("heals a wounded player and consumes one unit", async () => {
    const { db } = await testDb();
    const medkit = await seedItem(db, "consumable", { heal: 30 });
    await grant(db, playerId, medkit, 2);
    await db.update(playerStats).set({ health: 50 }).where(eq(playerStats.playerId, playerId));

    const res = await app.inject({
      method: "POST", url: `/api/inventory/use/${medkit}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ health: 80, healed: 30, qty: 1 });
  });

  it("caps the heal at the rank max health", async () => {
    const { db } = await testDb();
    const megadose = await seedItem(db, "consumable", { heal: 999 });
    await grant(db, playerId, megadose, 1);
    await db.update(playerStats).set({ health: 90 }).where(eq(playerStats.playerId, playerId));

    const res = await app.inject({
      method: "POST", url: `/api/inventory/use/${megadose}`,
      headers: { authorization: `Bearer ${token}` },
    });

    // Default max health is 100 for a player with no rank row.
    expect(res.json()).toMatchObject({ health: 100, healed: 10 });
  });

  it("409s a player already at full health", async () => {
    const { db } = await testDb();
    const medkit = await seedItem(db, "consumable", { heal: 30 });
    await grant(db, playerId, medkit, 1);
    await db.update(playerStats).set({ health: 100 }).where(eq(playerStats.playerId, playerId));

    const res = await app.inject({
      method: "POST", url: `/api/inventory/use/${medkit}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "already_full" });
  });

  it("400s a non-consumable", async () => {
    const { db } = await testDb();
    const pistol = await seedItem(db, "weapon", { accuracy: 60, damageMin: 5, damageMax: 15 });
    await grant(db, playerId, pistol, 1);
    await db.update(playerStats).set({ health: 50 }).where(eq(playerStats.playerId, playerId));

    const res = await app.inject({
      method: "POST", url: `/api/inventory/use/${pistol}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "wrong_slot" });
  });

  it("never drives qty below zero", async () => {
    const { db } = await testDb();
    const medkit = await seedItem(db, "consumable", { heal: 10 });
    await grant(db, playerId, medkit, 1);
    await db.update(playerStats).set({ health: 10 }).where(eq(playerStats.playerId, playerId));

    const first = await app.inject({
      method: "POST", url: `/api/inventory/use/${medkit}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST", url: `/api/inventory/use/${medkit}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: "not_owned" });

    const [row] = await db.select().from(playerItems)
      .where(and(eq(playerItems.playerId, playerId), eq(playerItems.itemId, medkit)));
    expect(row?.qty).toBe(0);
  });

  it("423s a use attempt from hospital, so heal items cannot clear a sentence", async () => {
    const { db } = await testDb();
    const medkit = await seedItem(db, "consumable", { heal: 30 });
    await grant(db, playerId, medkit, 1);
    await db.update(playerStats)
      .set({ health: 0, hospitalUntil: new Date(Date.now() + 60_000) })
      .where(eq(playerStats.playerId, playerId));

    const res = await app.inject({
      method: "POST", url: `/api/inventory/use/${medkit}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(423);
    expect(res.json()).toMatchObject({ error: "hospitalised" });
  });
```

- [ ] **Step 2: Run to verify they fail**

```bash
npx vitest run --project @gl3/server apps/server/test/inventory.test.ts
```

Expected: FAIL — 404 on the use route.

- [ ] **Step 3: Write the route**

Add to `packages/plugins/inventory/src/index.ts` (import `sql` from `drizzle-orm`, plus `ConsumableEffectsSchema`, `ITEM_TYPE_CONSUMABLE`, `ranks`):

```ts
const useRoute = route({
  method: "POST",
  path: "/api/inventory/use/:itemId",
  accessInJail: false,
  // What structurally enforces "a heal item does not get you out of hospital":
  // the loader answers 423 before this handler runs.
  accessInHospital: false,
  params: z.object({ itemId: z.string().uuid() }),
  handler: async (ctx, { params }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      await tx.locks.player([player.id]);

      const [owned] = await tx.db
        .select({ itemType: items.itemType, effects: items.effects, qty: playerItems.qty })
        .from(playerItems)
        .innerJoin(items, eq(items.id, playerItems.itemId))
        .where(and(eq(playerItems.playerId, player.id), eq(playerItems.itemId, params.itemId)));
      if (!owned || owned.qty <= 0) throw new PluginError("not_owned", 409);
      if (owned.itemType !== ITEM_TYPE_CONSUMABLE) throw new PluginError("wrong_slot", 400);

      const parsed = ConsumableEffectsSchema.safeParse(owned.effects);
      if (!parsed.success) throw new PluginError("wrong_slot", 400);

      const [stats] = await tx.db
        .select({ health: playerStats.health, maxHealth: ranks.maxHealth })
        .from(playerStats)
        .leftJoin(ranks, eq(ranks.id, playerStats.rankId))
        .where(eq(playerStats.playerId, player.id));
      if (!stats) throw new PluginError("unauthorized", 401);

      // 100 matches core's `ranks.max_health` column default, used when the
      // player has no rank row yet.
      const maxHealth = stats.maxHealth ?? 100;
      if (stats.health >= maxHealth) throw new PluginError("already_full", 409);

      // The decrement is the guard, not a preceding read: `qty > 0` in the
      // WHERE makes a concurrent second use match zero rows instead of driving
      // the count negative. Same reasoning as CLAUDE.md rule 2's ban on
      // check-then-act, applied to Postgres.
      const decremented = await tx.db
        .update(playerItems)
        .set({ qty: sql`${playerItems.qty} - 1` })
        .where(and(
          eq(playerItems.playerId, player.id),
          eq(playerItems.itemId, params.itemId),
          gt(playerItems.qty, 0),
        ))
        .returning({ qty: playerItems.qty });
      const remaining = decremented[0]?.qty;
      if (remaining === undefined) throw new PluginError("not_owned", 409);

      const health = Math.min(maxHealth, stats.health + parsed.data.heal);
      await tx.db.update(playerStats).set({ health }).where(eq(playerStats.playerId, player.id));

      return {
        status: 200,
        body: { health, healed: health - stats.health, qty: remaining },
      };
    });
  },
});
```

Add `useRoute` to the manifest's `routes` array.

- [ ] **Step 4: Seed the starter items**

In `apps/server/src/db/seed.ts`, add a `seedItems` function following the file's
**actual** convention, verified against the source: every seed function generates
ids with `uuidv7()` and guards re-runs with an "is this table already populated?"
early return — **not** fixed UUID literals and **not** `onConflictDoNothing()`.
Match `seedCrimes` / `seedRanks` / `seedLocations` exactly:

```ts
/**
 * Two starter items so equip is not inert before a shop exists: one weapon to
 * fight with, one consumable to heal with.
 *
 * Same shape as the other seeds in this file — uuidv7 ids and an
 * already-populated early return, so a re-run is a no-op rather than a
 * duplicate.
 */
export async function seedItems(db: Db): Promise<void> {
  const existing = await db.select({ id: items.id }).from(items).limit(1);
  if (existing.length > 0) return;

  await db.insert(items).values([
    {
      id: uuidv7(),
      name: "Rusty Pistol",
      itemType: "weapon",
      effects: {
        accuracy: 55, damageMin: 8, damageMax: 18,
        bulletsPerShot: 1, critChance: 5, critMultiplier: 1.5,
        armorPierce: 0, minRankExp: 0,
      },
    },
    { id: uuidv7(), name: "First Aid Kit", itemType: "consumable", effects: { heal: 25 } },
  ]);
}
```

Add `items` to the file's schema import, and call `seedItems` from wherever
`seedCrimes` / `seedRanks` / `seedLocations` are called (`apps/server/src/index.ts`
imports all three — follow that).

Note the consequence of the populated-guard convention: because the ids are
generated, **no test may hardcode a starter item's id**. A test that needs one
looks it up by `name`.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx vitest run --project @gl3/server apps/server/test/inventory.test.ts
```

Expected: PASS, 13 tests.

- [ ] **Step 6: Run the full suite, then commit**

```bash
npm run verify > /tmp/verify.log 2>&1; echo "exit=$?"
git add packages/plugins/inventory/src/index.ts apps/server/src/db/seed.ts \
        apps/server/test/inventory.test.ts
git commit -m "feat(inventory): add POST /api/inventory/use and seed starter items

The qty decrement carries its own 'qty > 0' guard rather than reading
first — a concurrent second use matches zero rows instead of going
negative. accessInHospital: false is what enforces that a heal item
cannot clear a hospital sentence."
```

---

### Task 9: `combat` plugin — package, settings, and the pure resolver

The arithmetic lives in `resolve.ts` with no database and no ctx, so its tests need neither Postgres nor Redis and run in the `@gl3/server:unit` project. This is the only part of combat with interesting logic; keeping it pure is what makes it cheap to test exhaustively.

**Files:**
- Create: `packages/plugins/combat/package.json`, `tsconfig.json`
- Create: `packages/plugins/combat/src/effects.ts`, `settings.ts`, `resolve.ts`, `schema.ts`
- Create: `packages/plugins/combat/src/index.ts` (manifest with an empty route list for now)
- Modify: the eight registration sites
- Test: `apps/server/test/combat-resolve.test.ts`

**Interfaces:**
- Produces, from `packages/plugins/combat/src/resolve.js`:
  ```ts
  export interface WeaponProfile {
    accuracy: number; damageMin: number; damageMax: number;
    bulletsPerShot: number; critChance: number; critMultiplier: number;
    armorPierce: number; minRankExp: number;
  }
  export interface ShotOutcome {
    hit: boolean; crit: boolean; damage: number;
    armorAbsorbed: number; bulletsSpent: number;
  }
  export interface Rolls { hitRoll: number; damageRoll: number; critRoll: number }
  export function resolveShot(weapon: WeaponProfile, targetArmor: number, rolls: Rolls): ShotOutcome;
  export function rollFor(weapon: WeaponProfile): Rolls;   // node:crypto randomInt
  ```
- Produces, from `packages/plugins/combat/src/settings.js`: `readCombatSettings(get: (key: string) => string | null): CombatSettings`.

`resolveShot` takes its rolls as a parameter and does no randomness itself — that is what makes it exhaustively testable without injecting an RNG into shipped code. `rollFor` is the thin `node:crypto` wrapper the route calls.

- [ ] **Step 1: Create the package files**

`packages/plugins/combat/package.json` — copy `packages/plugins/bullets/package.json`, rename to `"@gl3/plugin-combat"`.
`packages/plugins/combat/tsconfig.json` — copy `packages/plugins/bullets/tsconfig.json` verbatim.

- [ ] **Step 2: Write the failing resolver test**

Create `apps/server/test/combat-resolve.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveShot, rollFor, type WeaponProfile } from "@gl3/plugin-combat/resolve";

const base: WeaponProfile = {
  accuracy: 60, damageMin: 10, damageMax: 20, bulletsPerShot: 1,
  critChance: 0, critMultiplier: 2, armorPierce: 0, minRankExp: 0,
};

describe("resolveShot", () => {
  it("misses when the hit roll is at or above accuracy", () => {
    const out = resolveShot(base, 0, { hitRoll: 60, damageRoll: 20, critRoll: 0 });
    expect(out).toEqual({ hit: false, crit: false, damage: 0, armorAbsorbed: 0, bulletsSpent: 1 });
  });

  it("hits when the roll is below accuracy", () => {
    const out = resolveShot(base, 0, { hitRoll: 59, damageRoll: 15, critRoll: 99 });
    expect(out.hit).toBe(true);
    expect(out.damage).toBe(15);
  });

  it("subtracts armor from the rolled damage", () => {
    const out = resolveShot(base, 6, { hitRoll: 0, damageRoll: 15, critRoll: 99 });
    expect(out.damage).toBe(9);
    expect(out.armorAbsorbed).toBe(6);
  });

  it("reports a hit absorbed to zero as a hit, not a miss", () => {
    const out = resolveShot(base, 100, { hitRoll: 0, damageRoll: 15, critRoll: 99 });
    expect(out.hit).toBe(true);
    expect(out.damage).toBe(0);
    expect(out.armorAbsorbed).toBe(15);
  });

  it("multiplies damage on a crit BEFORE armor subtracts", () => {
    const weapon = { ...base, critChance: 100, critMultiplier: 2 };
    const out = resolveShot(weapon, 10, { hitRoll: 0, damageRoll: 15, critRoll: 0 });
    // 15 × 2 = 30, then −10 armor = 20. Armor blunts a crit; it does not
    // bypass armor. Pierce is the stat that beats armor.
    expect(out.crit).toBe(true);
    expect(out.damage).toBe(20);
    expect(out.armorAbsorbed).toBe(10);
  });

  it("floors a fractional crit so damage stays an integer", () => {
    const weapon = { ...base, critChance: 100, critMultiplier: 1.5 };
    const out = resolveShot(weapon, 0, { hitRoll: 0, damageRoll: 15, critRoll: 0 });
    expect(out.damage).toBe(22); // floor(15 × 1.5) = 22
    expect(Number.isInteger(out.damage)).toBe(true);
  });

  it("reduces effective armor by armorPierce", () => {
    const weapon = { ...base, armorPierce: 8 };
    const out = resolveShot(weapon, 10, { hitRoll: 0, damageRoll: 15, critRoll: 99 });
    expect(out.armorAbsorbed).toBe(2); // 10 − 8
    expect(out.damage).toBe(13);
  });

  it("never lets pierce turn armor into bonus damage", () => {
    const weapon = { ...base, armorPierce: 50 };
    const out = resolveShot(weapon, 10, { hitRoll: 0, damageRoll: 15, critRoll: 99 });
    expect(out.armorAbsorbed).toBe(0);
    expect(out.damage).toBe(15);
  });

  it("charges bulletsPerShot on a miss as well as a hit", () => {
    const weapon = { ...base, bulletsPerShot: 7, accuracy: 0 };
    const out = resolveShot(weapon, 0, { hitRoll: 50, damageRoll: 15, critRoll: 99 });
    expect(out.hit).toBe(false);
    expect(out.bulletsSpent).toBe(7);
  });

  it("accuracy 100 always hits and accuracy 0 never does", () => {
    expect(resolveShot({ ...base, accuracy: 100 }, 0, { hitRoll: 99, damageRoll: 1, critRoll: 99 }).hit).toBe(true);
    expect(resolveShot({ ...base, accuracy: 0 }, 0, { hitRoll: 0, damageRoll: 1, critRoll: 99 }).hit).toBe(false);
  });
});

describe("rollFor", () => {
  it("stays inside the declared bounds over many draws", () => {
    const weapon = { ...base, damageMin: 5, damageMax: 9 };
    for (let i = 0; i < 200; i += 1) {
      const rolls = rollFor(weapon);
      expect(rolls.hitRoll).toBeGreaterThanOrEqual(0);
      expect(rolls.hitRoll).toBeLessThan(100);
      expect(rolls.critRoll).toBeGreaterThanOrEqual(0);
      expect(rolls.critRoll).toBeLessThan(100);
      expect(rolls.damageRoll).toBeGreaterThanOrEqual(5);
      expect(rolls.damageRoll).toBeLessThanOrEqual(9);
    }
  });

  it("produces more than one distinct damage value across draws", () => {
    // A loose sanity check, not an exact distribution assertion: this is the
    // one thing item-stat pinning cannot cover.
    const weapon = { ...base, damageMin: 1, damageMax: 100 };
    const seen = new Set(Array.from({ length: 50 }, () => rollFor(weapon).damageRoll));
    expect(seen.size).toBeGreaterThan(5);
  });
});
```

The import path `@gl3/plugin-combat/resolve` needs a subpath export. Simpler alternative: re-export `resolveShot`, `rollFor` and the types from the package's `index.ts` and import from `@gl3/plugin-combat` instead. Prefer that — it avoids adding an `exports` subpath that no other plugin has. Adjust the import line accordingly.

Add `"test/combat-resolve.test.ts"` to the `@gl3/server:unit` project `include` list — it touches neither Postgres nor Redis.

- [ ] **Step 3: Run to verify it fails**

```bash
npx vitest run --project @gl3/server:unit apps/server/test/combat-resolve.test.ts
```

Expected: FAIL — cannot resolve `@gl3/plugin-combat`.

- [ ] **Step 4: Write `resolve.ts`**

Create `packages/plugins/combat/src/resolve.ts`:

```ts
import { randomInt } from "node:crypto";

export interface WeaponProfile {
  accuracy: number;
  damageMin: number;
  damageMax: number;
  bulletsPerShot: number;
  critChance: number;
  critMultiplier: number;
  armorPierce: number;
  minRankExp: number;
}

export interface ShotOutcome {
  hit: boolean;
  crit: boolean;
  damage: number;
  armorAbsorbed: number;
  bulletsSpent: number;
}

/** The three draws a shot needs, taken by the caller so this stays pure. */
export interface Rolls {
  hitRoll: number;
  damageRoll: number;
  critRoll: number;
}

/**
 * `node:crypto`, never `Math.random` (spec §7). Kept separate from
 * `resolveShot` so the arithmetic can be tested exhaustively without an RNG
 * injected into shipped code — the shape the bullets port rejected.
 */
export function rollFor(weapon: WeaponProfile): Rolls {
  return {
    hitRoll: randomInt(0, 100),
    damageRoll: randomInt(weapon.damageMin, weapon.damageMax + 1),
    critRoll: randomInt(0, 100),
  };
}

/**
 * Two-stage: roll to hit, then roll damage.
 *
 * A crit multiplies BEFORE armor subtracts, so armor blunts a crit rather
 * than a crit bypassing armor. Pierce is the stat that beats armor; crit is
 * the stat that beats health. Two counters, two distinct roles.
 *
 * A hit reduced to zero by armor still reports `hit: true` — "your armor
 * held" is different information from "he missed."
 *
 * Bullets are spent either way: ammo is the cost of shooting, not of hitting.
 */
export function resolveShot(
  weapon: WeaponProfile,
  targetArmor: number,
  rolls: Rolls,
): ShotOutcome {
  const bulletsSpent = weapon.bulletsPerShot;

  if (rolls.hitRoll >= weapon.accuracy) {
    return { hit: false, crit: false, damage: 0, armorAbsorbed: 0, bulletsSpent };
  }

  const crit = rolls.critRoll < weapon.critChance;
  // floor keeps damage an integer despite critMultiplier being a float — no
  // float may reach a bigint or the ledger.
  const raw = crit
    ? Math.floor(rolls.damageRoll * weapon.critMultiplier)
    : rolls.damageRoll;

  const effectiveArmor = Math.max(0, targetArmor - weapon.armorPierce);
  const damage = Math.max(0, raw - effectiveArmor);
  const armorAbsorbed = raw - damage;

  return { hit: true, crit, damage, armorAbsorbed, bulletsSpent };
}
```

- [ ] **Step 5: Write `effects.ts`, `settings.ts` and `schema.ts`**

`packages/plugins/combat/src/effects.ts` — a verbatim copy of `packages/plugins/inventory/src/effects.ts`. A plugin may not import another plugin, so this is duplicated deliberately; add a header comment saying so and naming the other file, since the two must be kept in step.

Create `packages/plugins/combat/src/settings.ts`:

```ts
export interface CombatSettings {
  cooldownSeconds: number;
  hospitalSeconds: number;
  newbieExpThreshold: bigint;
  defaultWeaponAccuracy: number;
  unarmed: {
    accuracy: number;
    damageMin: number;
    damageMax: number;
    bulletsPerShot: number;
  };
}

/**
 * Every key has a default, so a fresh database with an empty `settings` table
 * still plays. A malformed value falls back rather than throwing: `settings`
 * is admin-edited free text and a typo must not take the route down.
 */
function num(get: (key: string) => string | null, key: string, fallback: number): number {
  const raw = get(key);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function big(get: (key: string) => string | null, key: string, fallback: bigint): bigint {
  const raw = get(key);
  if (raw === null) return fallback;
  try {
    const parsed = BigInt(raw);
    return parsed >= 0n ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function readCombatSettings(get: (key: string) => string | null): CombatSettings {
  return {
    cooldownSeconds: Math.max(1, num(get, "combat.cooldown_seconds", 60)),
    hospitalSeconds: Math.max(1, num(get, "combat.hospital_seconds", 600)),
    newbieExpThreshold: big(get, "combat.newbie_exp_threshold", 100n),
    defaultWeaponAccuracy: Math.min(100, num(get, "combat.default_weapon_accuracy", 50)),
    unarmed: {
      accuracy: Math.min(100, num(get, "combat.unarmed.accuracy", 25)),
      damageMin: num(get, "combat.unarmed.damage_min", 1),
      damageMax: num(get, "combat.unarmed.damage_max", 5),
      bulletsPerShot: Math.max(1, num(get, "combat.unarmed.bullets_per_shot", 1)),
    },
  };
}
```

`cooldownSeconds` is floored at 1 deliberately: a zero TTL makes Redis `SET ... EX 0` fail, which is the exact live crash `travel_cooldown_seconds = 0` still has (see `docs/STATUS.md`). Do not copy that bug into a new module.

Create `packages/plugins/combat/src/schema.ts` — mirrors for `player_stats` (`playerId`, `cash`, `exp`, `bullets`, `health`, `rankId`, `gangId`, `locationId`, `weaponItemId`, `armorItemId`, `jailedUntil`, `hospitalUntil`), `players` (`id`, `username`), `items` (`id`, `itemType`, `effects`), `ranks` (`id`, `maxHealth`), `gangMembers` (`gangId`, `playerId`), and `combatLog` (all nine columns from Task 2). Follow `packages/plugins/bullets/src/schema.ts` for the header comment and style; types must match `apps/server/src/db/schema/*.ts` exactly.

- [ ] **Step 6: Write the manifest stub**

Create `packages/plugins/combat/src/index.ts`:

```ts
import { definePlugin } from "@gl3/plugin-sdk";

export { resolveShot, rollFor } from "./resolve.js";
export type { Rolls, ShotOutcome, WeaponProfile } from "./resolve.js";

export default definePlugin({
  id: "combat",
  version: "1.0.0",
  basePaths: ["/api/combat"],
  routes: [],
});
```

An empty `routes` array is a deliberate intermediate state — Task 10 fills it. Confirm `definePlugin` accepts it; if the validator rejects an empty route list, fold Task 10's `attackRoute` skeleton in here instead of shipping a manifest that cannot load.

- [ ] **Step 7: Complete all eight registration sites**

Exactly as Task 6 Step 5, substituting `combat` for `inventory` and `@gl3/plugin-combat` for `@gl3/plugin-inventory`. Then:

```bash
grep -c "packages/plugins/combat" Dockerfile.server   # expect 5
npx tsc --build --force apps/server/tsconfig.json      # expect clean
```

- [ ] **Step 8: Run the resolver test to verify it passes**

```bash
npx vitest run --project @gl3/server:unit apps/server/test/combat-resolve.test.ts
```

Expected: PASS, 12 tests.

- [ ] **Step 9: Run the full suite, then commit**

```bash
npm run verify > /tmp/verify.log 2>&1; echo "exit=$?"
git add packages/plugins/combat apps/server/package.json apps/server/tsconfig.json \
        tsconfig.json vitest.workspace.ts apps/server/src/plugins/core-plugins.ts \
        Dockerfile.server apps/server/test/combat-resolve.test.ts package-lock.json
git commit -m "feat(combat): add the combat plugin package and the pure shot resolver

resolveShot takes its three rolls as a parameter and does no randomness
itself, so the arithmetic is exhaustively testable without injecting an
RNG into shipped code. A crit multiplies before armor subtracts: armor
blunts a crit, pierce is the stat that beats armor."
```

---

### Task 10: `POST /api/combat/attack/:targetId` — legality only

This task builds the route as far as the seven legality checks and the bullet debit, returning a stub body. Task 11 adds resolution and events; Task 12 adds death. Splitting here is deliberate: the legality gate is seven independent rules a reviewer can accept or reject on its own, and it is where a wrong answer is a gameplay exploit rather than a bug.

**Files:**
- Modify: `packages/plugins/combat/src/index.ts`
- Test: `apps/server/test/combat.test.ts`
- Modify: `vitest.workspace.ts` (`@gl3/server` project)

**Interfaces:**
- Consumes: `readCombatSettings` (Task 9), the schema mirrors (Task 9), `settleHospital` **via the loader gate** for the attacker and via `tx.db` for the target.
- Produces: `attackRoute` in the manifest.

**Order of operations inside the transaction, and why:**

1. `tx.locks.player([attacker, target])` — **first statement**, ascending UUID via the existing helper. Everything read afterwards is read under the lock.
2. Settle the target's hospital state. The attacker's is settled by the loader gate before the handler runs; the target's must be settled here, inside the lock, or a player whose sentence just elapsed sits at `health = 0` and is instantly re-killable.
3. Read both stat rows, the attacker's weapon, the target's armor, both gang memberships.
4. The seven checks.
5. Debit bullets.

**The seven checks, in order:**

| Check | Error |
|---|---|
| target is self | `400 self_attack` |
| target row missing | `404 no_such_target` |
| target in hospital | `409 target_hospitalised` |
| target in jail | `409 target_jailed` |
| different `location_id` | `409 target_elsewhere` |
| same gang (both non-null and equal) | `409 same_gang` |
| either side below `newbie_exp_threshold` | `409 protected` |
| attacker bullets < `bulletsPerShot` | `409 insufficient_bullets` |

Newbie protection is **mutual** — below the threshold you can neither be attacked nor attack. One-way protection would let a newbie farm with impunity.

**The cooldown is claimed before the transaction and is not released on a 4xx.** Releasing it would be a check-then-act on Redis (rule 2), and keeping it denies a client a free-probe primitive for scanning who is in hospital at no cost.

- [ ] **Step 1: Write the failing tests**

Create `apps/server/test/combat.test.ts`. Copy the registration preamble from `bank.test.ts`, but register **two** players (attacker and target) and keep both ids and the attacker's token. Add helpers:

```ts
/** Puts both players in the same location with enough exp to clear newbie protection. */
async function makeAttackable(
  db: Awaited<ReturnType<typeof testDb>>["db"],
  attackerId: string, targetId: string,
): Promise<string> {
  const locationId = uuidv7();
  await db.insert(locations).values({
    id: locationId, name: `loc-${locationId.slice(-8)}`,
    travelCost: 0n, travelCooldownSeconds: 60, bulletStock: 0, bulletCost: 1n,
  });
  await db.update(playerStats)
    .set({ locationId, exp: 100_000n, bullets: 1000n, health: 100, gangId: null,
           jailedUntil: null, hospitalUntil: null })
    .where(inArray(playerStats.playerId, [attackerId, targetId]));
  return locationId;
}

async function equipWeapon(
  db: Awaited<ReturnType<typeof testDb>>["db"],
  playerId: string, effects: Record<string, unknown>,
): Promise<string> {
  const id = uuidv7();
  await db.insert(items).values({ id, name: `w-${id.slice(-8)}`, itemType: "weapon", effects });
  await db.insert(playerItems).values({ playerId, itemId: id, qty: 1 });
  await db.update(playerStats).set({ weaponItemId: id }).where(eq(playerStats.playerId, playerId));
  return id;
}

const attack = (targetId: string) => app.inject({
  method: "POST", url: `/api/combat/attack/${targetId}`,
  headers: { authorization: `Bearer ${attackerToken}` },
});
```

The `locations` insert must match the real column set — read `apps/server/src/db/schema/content.ts` and adjust rather than trusting the field list above.

**Every test must clear the attacker's Redis cooldown first**, or the second case in the file gets a 429. Add a `beforeEach` that deletes the cooldown key; read `apps/server/src/game/cooldown.ts`'s `cooldownKey` to get the exact format, and delete it through the same `createRedis()` the test already uses. Do **not** use `FLUSHDB`.

The cases:

```ts
  it("400s an attack on yourself", async () => {
    const { db } = await testDb();
    await makeAttackable(db, attackerId, targetId);
    const res = await attack(attackerId);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "self_attack" });
  });

  it("404s an unknown target", async () => {
    const { db } = await testDb();
    await makeAttackable(db, attackerId, targetId);
    const res = await attack(uuidv7());
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "no_such_target" });
  });

  it("409s a hospitalised target", async () => {
    const { db } = await testDb();
    await makeAttackable(db, attackerId, targetId);
    await db.update(playerStats)
      .set({ hospitalUntil: new Date(Date.now() + 60_000), health: 0 })
      .where(eq(playerStats.playerId, targetId));
    const res = await attack(targetId);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "target_hospitalised" });
  });

  it("409s a jailed target", async () => {
    const { db } = await testDb();
    await makeAttackable(db, attackerId, targetId);
    await db.update(playerStats)
      .set({ jailedUntil: new Date(Date.now() + 60_000) })
      .where(eq(playerStats.playerId, targetId));
    const res = await attack(targetId);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "target_jailed" });
  });

  it("409s a target in another location", async () => {
    const { db } = await testDb();
    await makeAttackable(db, attackerId, targetId);
    const elsewhere = uuidv7();
    await db.insert(locations).values({
      id: elsewhere, name: `far-${elsewhere.slice(-8)}`,
      travelCost: 0n, travelCooldownSeconds: 60, bulletStock: 0, bulletCost: 1n,
    });
    await db.update(playerStats).set({ locationId: elsewhere })
      .where(eq(playerStats.playerId, targetId));
    const res = await attack(targetId);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "target_elsewhere" });
  });

  it("409s a gang mate", async () => {
    const { db } = await testDb();
    await makeAttackable(db, attackerId, targetId);
    const gangId = uuidv7();
    await db.insert(gangs).values({ id: gangId, name: `g-${gangId.slice(-8)}`, bossPlayerId: attackerId });
    await db.insert(gangMembers).values([
      { gangId, playerId: attackerId }, { gangId, playerId: targetId },
    ]);
    await db.update(playerStats).set({ gangId })
      .where(inArray(playerStats.playerId, [attackerId, targetId]));
    const res = await attack(targetId);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "same_gang" });
  });

  it("409s when the TARGET is below the newbie threshold", async () => {
    const { db } = await testDb();
    await makeAttackable(db, attackerId, targetId);
    await db.update(playerStats).set({ exp: 0n }).where(eq(playerStats.playerId, targetId));
    const res = await attack(targetId);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "protected" });
  });

  it("409s when the ATTACKER is below the newbie threshold — protection is mutual", async () => {
    const { db } = await testDb();
    await makeAttackable(db, attackerId, targetId);
    await db.update(playerStats).set({ exp: 0n }).where(eq(playerStats.playerId, attackerId));
    const res = await attack(targetId);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "protected" });
  });

  it("409s when the attacker is out of bullets", async () => {
    const { db } = await testDb();
    await makeAttackable(db, attackerId, targetId);
    await equipWeapon(db, attackerId, { accuracy: 100, damageMin: 1, damageMax: 1, bulletsPerShot: 5 });
    await db.update(playerStats).set({ bullets: 4n }).where(eq(playerStats.playerId, attackerId));
    const res = await attack(targetId);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "insufficient_bullets" });
  });

  it("429s a second attack inside the cooldown", async () => {
    const { db } = await testDb();
    await makeAttackable(db, attackerId, targetId);
    await equipWeapon(db, attackerId, { accuracy: 100, damageMin: 1, damageMax: 1 });
    const first = await attack(targetId);
    expect(first.statusCode).toBe(200);

    const second = await attack(targetId);
    expect(second.statusCode).toBe(429);
    expect(second.headers["retry-after"]).toBeDefined();
  });

  it("burns the cooldown even when the attack is illegal", async () => {
    const { db } = await testDb();
    await makeAttackable(db, attackerId, targetId);
    await equipWeapon(db, attackerId, { accuracy: 100, damageMin: 1, damageMax: 1 });
    await db.update(playerStats)
      .set({ jailedUntil: new Date(Date.now() + 60_000) })
      .where(eq(playerStats.playerId, targetId));

    expect((await attack(targetId)).statusCode).toBe(409);

    // Deliberate: releasing on a 4xx would be a check-then-act on Redis, and
    // keeping it denies a free probe for scanning who is attackable.
    await db.update(playerStats).set({ jailedUntil: null }).where(eq(playerStats.playerId, targetId));
    expect((await attack(targetId)).statusCode).toBe(429);
  });

  it("debits bullets on a miss", async () => {
    const { db } = await testDb();
    await makeAttackable(db, attackerId, targetId);
    await equipWeapon(db, attackerId, { accuracy: 0, damageMin: 5, damageMax: 5, bulletsPerShot: 3 });
    await db.update(playerStats).set({ bullets: 10n }).where(eq(playerStats.playerId, attackerId));

    const res = await attack(targetId);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ hit: false, damage: 0, bulletsSpent: 3 });
    const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, attackerId));
    expect(row?.bullets).toBe(7n);
  });
```

Add `"test/combat.test.ts"` to the `@gl3/server` project `include` list.

- [ ] **Step 2: Run to verify they fail**

```bash
npx vitest run --project @gl3/server apps/server/test/combat.test.ts
```

Expected: FAIL — 404 on the attack route.

- [ ] **Step 3: Write the route's legality half**

Add to `packages/plugins/combat/src/index.ts`:

```ts
const attackRoute = route({
  method: "POST",
  path: "/api/combat/attack/:targetId",
  accessInJail: false,
  accessInHospital: false,
  params: z.object({ targetId: z.string().uuid() }),
  handler: async (ctx, { params }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    if (params.targetId === player.id) throw new PluginError("self_attack", 400);

    const config = readCombatSettings((key) => ctx.settings.get(key));

    // Claimed BEFORE the transaction, and deliberately never released on a
    // 4xx: releasing would be a check-then-act on Redis (CLAUDE.md rule 2),
    // and keeping it denies a client a free probe for scanning who is
    // attackable at no cost.
    const acquired = await ctx.cooldown.acquire("combat.attack", player.id, config.cooldownSeconds);
    if (!acquired) {
      const remaining = await ctx.cooldown.peek("combat.attack", player.id);
      throw new PluginError("cooldown", 429, undefined, { "retry-after": String(remaining) });
    }

    return ctx.transaction(async (tx) => {
      // FIRST statement. Ascending UUID via the shared helper, which is what
      // makes A-shoots-B and B-shoots-A safe against each other (no ABBA).
      await tx.locks.player([player.id, params.targetId]);

      // The attacker's own hospital state was settled by the loader gate
      // before this handler ran. The target's must be settled HERE, inside
      // the lock: a target whose sentence just elapsed otherwise sits at
      // health 0 and is instantly re-killable.
      await settleTargetHospital(tx, params.targetId);

      const [attacker] = await tx.db.select().from(playerStats)
        .where(eq(playerStats.playerId, player.id));
      const [target] = await tx.db.select().from(playerStats)
        .where(eq(playerStats.playerId, params.targetId));
      if (!attacker) throw new PluginError("unauthorized", 401);
      if (!target) throw new PluginError("no_such_target", 404);

      const now = Date.now();
      if (target.hospitalUntil && target.hospitalUntil.getTime() > now) {
        throw new PluginError("target_hospitalised", 409);
      }
      if (target.jailedUntil && target.jailedUntil.getTime() > now) {
        throw new PluginError("target_jailed", 409);
      }
      if (attacker.locationId === null || attacker.locationId !== target.locationId) {
        throw new PluginError("target_elsewhere", 409);
      }
      if (attacker.gangId !== null && attacker.gangId === target.gangId) {
        throw new PluginError("same_gang", 409);
      }
      // Mutual: below the threshold you can neither be attacked NOR attack.
      // One-way protection would let a newbie farm with impunity.
      if (attacker.exp < config.newbieExpThreshold || target.exp < config.newbieExpThreshold) {
        throw new PluginError("protected", 409);
      }

      const weapon = await loadWeapon(tx, attacker.weaponItemId, config);
      if (attacker.bullets < BigInt(weapon.bulletsPerShot)) {
        throw new PluginError("insufficient_bullets", 409);
      }

      await tx.db
        .update(playerStats)
        .set({ bullets: sql`${playerStats.bullets} - ${weapon.bulletsPerShot}` })
        .where(eq(playerStats.playerId, player.id));

      // Task 11 replaces this stub with the resolution, log and events.
      return {
        status: 200,
        body: { hit: false, damage: 0, bulletsSpent: weapon.bulletsPerShot },
      };
    });
  },
});
```

with two module-level helpers:

```ts
/**
 * The target's elapsed sentence, cleared inside the caller's lock. Duplicates
 * core's `settleHospital` because a plugin may not import from `apps/server`;
 * kept to the same two statements so the two cannot diverge in behaviour.
 */
async function settleTargetHospital(tx: PluginTx, targetId: string): Promise<void> {
  const [row] = await tx.db
    .select({ hospitalUntil: playerStats.hospitalUntil, maxHealth: ranks.maxHealth })
    .from(playerStats)
    .leftJoin(ranks, eq(ranks.id, playerStats.rankId))
    .where(eq(playerStats.playerId, targetId));
  if (!row?.hospitalUntil) return;
  if (row.hospitalUntil.getTime() > Date.now()) return;
  await tx.db
    .update(playerStats)
    .set({ hospitalUntil: null, health: row.maxHealth ?? 100 })
    .where(and(eq(playerStats.playerId, targetId), isNotNull(playerStats.hospitalUntil)));
}

/** The equipped weapon's stats, or the unarmed profile when nothing is equipped. */
async function loadWeapon(
  tx: PluginTx,
  weaponItemId: string | null,
  config: CombatSettings,
): Promise<WeaponProfile> {
  const unarmed: WeaponProfile = {
    accuracy: config.unarmed.accuracy,
    damageMin: config.unarmed.damageMin,
    damageMax: config.unarmed.damageMax,
    bulletsPerShot: config.unarmed.bulletsPerShot,
    critChance: 0, critMultiplier: 1, armorPierce: 0, minRankExp: 0,
  };
  if (weaponItemId === null) return unarmed;

  const [row] = await tx.db.select({ effects: items.effects, itemType: items.itemType })
    .from(items).where(eq(items.id, weaponItemId));
  if (!row || row.itemType !== ITEM_TYPE_WEAPON) return unarmed;

  const parsed = WeaponEffectsSchema.safeParse(row.effects);
  // A malformed weapon falls back to unarmed rather than 500ing: the jsonb is
  // an external boundary. A V2-migrated item with no accuracy is the expected
  // case for the settings fallback below, not this branch.
  if (!parsed.success) return unarmed;
  return parsed.data;
}
```

Add `attackRoute` to the manifest's `routes` array. Imports needed: `PluginError`, `route`, `type PluginTx` from `@gl3/plugin-sdk`; `and`, `eq`, `isNotNull`, `sql` from `drizzle-orm`; `z` from `zod`; the schema mirrors; `ITEM_TYPE_WEAPON`, `WeaponEffectsSchema`; `readCombatSettings`, `type CombatSettings`; `type WeaponProfile`.

Check `PluginError`'s constructor signature in `packages/plugin-sdk/src/` before writing the 429 — the `headers` argument position may differ from the `(code, status, details, headers)` assumed above. Match the real signature.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run --project @gl3/server apps/server/test/combat.test.ts
```

Expected: PASS, 12 tests.

- [ ] **Step 5: Run the full suite, then commit**

```bash
npm run verify > /tmp/verify.log 2>&1; echo "exit=$?"
git add packages/plugins/combat/src/index.ts apps/server/test/combat.test.ts vitest.workspace.ts
git commit -m "feat(combat): add the attack route's legality gate

Seven checks under a two-player ascending-UUID lock taken as the first
statement. Newbie protection is mutual — one-way protection would let a
newbie farm with impunity. The target's elapsed hospital sentence is
settled inside the lock, or they sit at 0 health and are re-killable."
```

---

### Task 11: Resolution, `combat_log`, and the `player.attacked` event

Replaces Task 10's stub return with the real outcome. Non-fatal shots only; Task 12 adds death.

**Files:**
- Modify: `packages/plugins/combat/src/index.ts`
- Modify: `apps/server/test/combat.test.ts`

**Interfaces:**
- Consumes: `resolveShot`, `rollFor` (Task 9); `combatLog` mirror (Task 9); `tx.events.publishCore`.
- Produces: the full non-fatal response body `{ hit, crit, damage, armorAbsorbed, targetHealth, targetKilled, payout, bulletsSpent }`.

**Audience: attacker and victim only, never global.** A global audience would broadcast every shot in the game to every connected socket and leak position — anyone watching the firehose learns who is where. Since `GameEvent.audience` has no two-player kind, this means **two `publishCore` calls with the same payload**, one addressed to each player. Check `AudienceSchema` in `packages/shared/src/primitives.ts` first: if a `players: string[]` kind exists, use it and publish once.

A miss still publishes `player.attacked` with `damage: 0` — the victim needs to know someone is shooting at them.

- [ ] **Step 1: Write the failing tests**

Append to `apps/server/test/combat.test.ts`:

```ts
  it("lands a pinned hit and reduces the target's health", async () => {
    const { db } = await testDb();
    await makeAttackable(db, attackerId, targetId);
    await equipWeapon(db, attackerId, { accuracy: 100, damageMin: 25, damageMax: 25 });

    const res = await attack(targetId);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      hit: true, crit: false, damage: 25, armorAbsorbed: 0,
      targetHealth: 75, targetKilled: false, payout: "0", bulletsSpent: 1,
    });
    const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, targetId));
    expect(row?.health).toBe(75);
  });

  it("subtracts the target's equipped armor", async () => {
    const { db } = await testDb();
    await makeAttackable(db, attackerId, targetId);
    await equipWeapon(db, attackerId, { accuracy: 100, damageMin: 30, damageMax: 30 });
    const vest = uuidv7();
    await db.insert(items).values({ id: vest, name: "vest", itemType: "armor", effects: { armor: 12 } });
    await db.insert(playerItems).values({ playerId: targetId, itemId: vest, qty: 1 });
    await db.update(playerStats).set({ armorItemId: vest }).where(eq(playerStats.playerId, targetId));

    const res = await attack(targetId);

    expect(res.json()).toMatchObject({ hit: true, damage: 18, armorAbsorbed: 12, targetHealth: 82 });
  });

  it("reports a fully-absorbed hit as a hit with zero damage, not a miss", async () => {
    const { db } = await testDb();
    await makeAttackable(db, attackerId, targetId);
    await equipWeapon(db, attackerId, { accuracy: 100, damageMin: 5, damageMax: 5 });
    const plate = uuidv7();
    await db.insert(items).values({ id: plate, name: "plate", itemType: "armor", effects: { armor: 99 } });
    await db.insert(playerItems).values({ playerId: targetId, itemId: plate, qty: 1 });
    await db.update(playerStats).set({ armorItemId: plate }).where(eq(playerStats.playerId, targetId));

    const res = await attack(targetId);

    expect(res.json()).toMatchObject({ hit: true, damage: 0, armorAbsorbed: 5, targetHealth: 100 });
  });

  it("applies armorPierce against the target's armor", async () => {
    const { db } = await testDb();
    await makeAttackable(db, attackerId, targetId);
    await equipWeapon(db, attackerId, {
      accuracy: 100, damageMin: 30, damageMax: 30, armorPierce: 10,
    });
    const vest = uuidv7();
    await db.insert(items).values({ id: vest, name: "vest", itemType: "armor", effects: { armor: 12 } });
    await db.insert(playerItems).values({ playerId: targetId, itemId: vest, qty: 1 });
    await db.update(playerStats).set({ armorItemId: vest }).where(eq(playerStats.playerId, targetId));

    const res = await attack(targetId);

    expect(res.json()).toMatchObject({ damage: 28, armorAbsorbed: 2 });
  });

  it("crits when critChance is pinned to 100", async () => {
    const { db } = await testDb();
    await makeAttackable(db, attackerId, targetId);
    await equipWeapon(db, attackerId, {
      accuracy: 100, damageMin: 20, damageMax: 20, critChance: 100, critMultiplier: 2,
    });

    const res = await attack(targetId);

    expect(res.json()).toMatchObject({ crit: true, damage: 40, targetHealth: 60 });
  });

  it("uses the unarmed profile when nothing is equipped", async () => {
    const { db } = await testDb();
    await makeAttackable(db, attackerId, targetId);
    await db.update(playerStats).set({ weaponItemId: null }).where(eq(playerStats.playerId, attackerId));

    const res = await attack(targetId);

    expect(res.statusCode).toBe(200);
    // Unarmed defaults: accuracy 25, damage 1-5, 1 bullet. The outcome is
    // random, so assert only the invariants that hold either way.
    const body = res.json();
    expect(body.bulletsSpent).toBe(1);
    expect(body.damage).toBeGreaterThanOrEqual(0);
    expect(body.damage).toBeLessThanOrEqual(5);
  });

  it("logs every shot, hit or miss", async () => {
    const { db } = await testDb();
    await makeAttackable(db, attackerId, targetId);
    await equipWeapon(db, attackerId, { accuracy: 100, damageMin: 7, damageMax: 7 });

    await attack(targetId);

    const rows = await db.select().from(combatLog).where(eq(combatLog.targetId, targetId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      attackerId, targetId, hit: true, damage: 7, fatal: false, payout: 0n,
    });
  });

  it("publishes player.attacked to the attacker, with damage 0 on a miss", async () => {
    const { db } = await testDb();
    await makeAttackable(db, attackerId, targetId);
    await equipWeapon(db, attackerId, { accuracy: 0, damageMin: 5, damageMax: 5 });

    // Rule 4: filter by our OWN actorId — game:events is global across files.
    const event = await awaitOwnEvent(subscriber, attackerId, "player.attacked", async () => {
      await attack(targetId);
    });

    expect(event).toMatchObject({ type: "player.attacked", targetId, damage: 0 });
  });
```

`awaitOwnEvent`'s exact signature is in `apps/server/test/helpers/events.ts` — read it and match the call shape rather than trusting the form above. Import `combatLog` from `../src/db/schema/index.js`.

- [ ] **Step 2: Run to verify they fail**

```bash
npx vitest run --project @gl3/server apps/server/test/combat.test.ts
```

Expected: FAIL — the stub returns `hit: false, damage: 0` for every case, and no `combat_log` row exists.

- [ ] **Step 3: Replace the stub with the real resolution**

In `packages/plugins/combat/src/index.ts`, replace the Task 10 stub return with:

```ts
      const targetArmor = await loadArmor(tx, target.armorItemId);
      const outcome = resolveShot(weapon, targetArmor, rollFor(weapon));

      const targetHealth = Math.max(0, target.health - outcome.damage);
      if (outcome.damage > 0) {
        await tx.db
          .update(playerStats)
          .set({ health: targetHealth })
          .where(eq(playerStats.playerId, params.targetId));
      }

      // Task 12 sets `fatal` and `payout` on the death path.
      await tx.db.insert(combatLog).values({
        id: uuidv7(),
        attackerId: player.id,
        targetId: params.targetId,
        hit: outcome.hit,
        damage: outcome.damage,
        fatal: false,
        weaponItemId: attacker.weaponItemId,
        payout: 0n,
      });

      const [targetRow] = await tx.db.select({ username: players.username })
        .from(players).where(eq(players.id, params.targetId));
      const targetName = targetRow?.username ?? "unknown";

      // Attacker AND victim, never global: a global audience would broadcast
      // every shot to every socket and leak position to anyone watching the
      // firehose. Two calls because AudienceSchema has no two-player kind.
      // A miss publishes too — the victim needs to know someone is shooting.
      for (const audienceId of [player.id, params.targetId]) {
        await tx.events.publishCore({
          type: "player.attacked",
          actorId: player.id,
          actorName: player.username,
          audience: { kind: "player", playerId: audienceId },
          targetId: params.targetId,
          targetName,
          damage: outcome.damage,
        });
      }

      return {
        status: 200,
        body: {
          hit: outcome.hit,
          crit: outcome.crit,
          damage: outcome.damage,
          armorAbsorbed: outcome.armorAbsorbed,
          targetHealth,
          targetKilled: false,
          payout: "0",
          bulletsSpent: outcome.bulletsSpent,
        },
      };
```

and add the armor helper:

```ts
/** The target's equipped armor rating, or 0 when unarmored or malformed. */
async function loadArmor(tx: PluginTx, armorItemId: string | null): Promise<number> {
  if (armorItemId === null) return 0;
  const [row] = await tx.db.select({ effects: items.effects, itemType: items.itemType })
    .from(items).where(eq(items.id, armorItemId));
  if (!row || row.itemType !== ITEM_TYPE_ARMOR) return 0;
  const parsed = ArmorEffectsSchema.safeParse(row.effects);
  return parsed.success ? parsed.data.armor : 0;
}
```

New imports: `uuidv7` from `uuidv7`, `combatLog`, `players` from `./schema.js`, `resolveShot`, `rollFor` from `./resolve.js`, `ArmorEffectsSchema`, `ITEM_TYPE_ARMOR` from `./effects.js`. Add `uuidv7` to the package's dependencies if it is not already there (check `packages/plugins/gangs/package.json`, which inserts rows with generated ids).

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run --project @gl3/server apps/server/test/combat.test.ts
```

Expected: PASS, 20 tests.

- [ ] **Step 5: Run the full suite, then commit**

```bash
npm run verify > /tmp/verify.log 2>&1; echo "exit=$?"
git add packages/plugins/combat/src/index.ts apps/server/test/combat.test.ts
git commit -m "feat(combat): resolve shots, log them, and publish player.attacked

Events go to attacker and victim only, never global: a global audience
would broadcast every shot to every socket and leak position. A miss
publishes too, with damage 0 — the victim needs to know."
```

---

### Task 12: Death — cash transfer and hospital

**Files:**
- Modify: `packages/plugins/combat/src/index.ts`
- Test: `apps/server/test/combat-kill.test.ts`
- Modify: `vitest.workspace.ts` (`@gl3/server` project)

**Interfaces:**
- Consumes: `tx.economy.applyBalanceChange`, `tx.hospital.sendToHospital` (Task 4), `config.hospitalSeconds`.
- Produces: the fatal branch — `targetKilled: true`, a non-zero `payout`, a `fatal` log row, and a `player.killed` event.

On death: the killer takes the victim's **entire on-hand cash**, bank untouched. Two `applyBalanceChange` calls inside the already-locked transaction, so both sides are ledgered and `sum(ledger) == balance` holds. The transfer cannot overdraw — it moves exactly the balance read under the lock moments earlier — so no `InsufficientFundsError` catch is needed on this path.

A zero-cash victim must be handled: `applyBalanceChange` with `amount: 0n` may be a no-op or may write a zero ledger row. **Skip both calls when the victim has no cash**, which avoids depending on which.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/combat-kill.test.ts`. Reuse the two-player preamble and the `makeAttackable` / `equipWeapon` helpers from `combat.test.ts` (copy them; a shared helper module is not worth it for two files).

```ts
  it("kills, takes all on-hand cash, spares the bank, and hospitalises", async () => {
    const { db } = await testDb();
    await makeAttackable(db, attackerId, targetId);
    await equipWeapon(db, attackerId, { accuracy: 100, damageMin: 500, damageMax: 500 });
    await db.update(playerStats).set({ cash: 0n }).where(eq(playerStats.playerId, attackerId));
    await db.update(playerStats).set({ cash: 250_000n, bank: 900_000n, health: 100 })
      .where(eq(playerStats.playerId, targetId));

    const res = await attack(targetId);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      hit: true, targetKilled: true, targetHealth: 0, payout: "250000",
    });

    const [victim] = await db.select().from(playerStats).where(eq(playerStats.playerId, targetId));
    expect(victim?.cash).toBe(0n);
    expect(victim?.bank).toBe(900_000n);   // bank is the counterplay
    expect(victim?.health).toBe(0);
    expect(victim?.hospitalUntil).not.toBeNull();

    const [killer] = await db.select().from(playerStats).where(eq(playerStats.playerId, attackerId));
    expect(killer?.cash).toBe(250_000n);
  });

  it("ledgers both sides of the transfer", async () => {
    const { db } = await testDb();
    await makeAttackable(db, attackerId, targetId);
    await equipWeapon(db, attackerId, { accuracy: 100, damageMin: 500, damageMax: 500 });
    await db.update(playerStats).set({ cash: 0n }).where(eq(playerStats.playerId, attackerId));
    await db.update(playerStats).set({ cash: 120_000n }).where(eq(playerStats.playerId, targetId));

    await attack(targetId);

    for (const id of [attackerId, targetId]) {
      const rows = await db.select().from(transactions).where(eq(transactions.playerId, id));
      const cashSum = rows.reduce((acc, t) => acc + (t.balanceKind === "cash" ? t.amount : 0n), 0n);
      const [stats] = await db.select().from(playerStats).where(eq(playerStats.playerId, id));
      expect(cashSum).toBe(stats?.cash);
    }
  });

  it("writes a fatal log row carrying the payout", async () => {
    const { db } = await testDb();
    await makeAttackable(db, attackerId, targetId);
    await equipWeapon(db, attackerId, { accuracy: 100, damageMin: 500, damageMax: 500 });
    await db.update(playerStats).set({ cash: 5_000n }).where(eq(playerStats.playerId, targetId));

    await attack(targetId);

    const rows = await db.select().from(combatLog).where(eq(combatLog.targetId, targetId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ fatal: true, payout: 5_000n });
  });

  it("publishes player.killed after player.attacked", async () => {
    const { db } = await testDb();
    await makeAttackable(db, attackerId, targetId);
    await equipWeapon(db, attackerId, { accuracy: 100, damageMin: 500, damageMax: 500 });

    const event = await awaitOwnEvent(subscriber, attackerId, "player.killed", async () => {
      await attack(targetId);
    });

    expect(event).toMatchObject({ type: "player.killed", victimId: targetId });
  });

  it("kills a victim with no cash without writing a spurious ledger row", async () => {
    const { db } = await testDb();
    await makeAttackable(db, attackerId, targetId);
    await equipWeapon(db, attackerId, { accuracy: 100, damageMin: 500, damageMax: 500 });
    await db.update(playerStats).set({ cash: 0n }).where(eq(playerStats.playerId, targetId));

    const res = await attack(targetId);

    expect(res.json()).toMatchObject({ targetKilled: true, payout: "0" });
    const rows = await db.select().from(transactions).where(eq(transactions.playerId, targetId));
    expect(rows.filter((t) => t.reason === "combat.killed")).toHaveLength(0);
  });

  it("blocks a follow-up attack on the now-hospitalised victim", async () => {
    const { db } = await testDb();
    await makeAttackable(db, attackerId, targetId);
    await equipWeapon(db, attackerId, { accuracy: 100, damageMin: 500, damageMax: 500 });

    await attack(targetId);
    await clearCooldown(attackerId);   // the per-test cooldown helper

    const second = await attack(targetId);
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: "target_hospitalised" });
  });
```

Add `"test/combat-kill.test.ts"` to the `@gl3/server` project `include` list.

- [ ] **Step 2: Run to verify they fail**

```bash
npx vitest run --project @gl3/server apps/server/test/combat-kill.test.ts
```

Expected: FAIL — `targetKilled` is always false and no money moves.

- [ ] **Step 3: Add the death branch**

In `packages/plugins/combat/src/index.ts`, between the health UPDATE and the `combatLog` insert:

```ts
      const killed = targetHealth === 0 && outcome.damage > 0;
      let payout = 0n;

      if (killed) {
        // The killer takes the victim's entire ON-HAND cash; the bank is
        // untouched, which is what makes depositing real counterplay.
        // `target.cash` was read under the lock taken as this transaction's
        // first statement, so it cannot have moved — the transfer can never
        // overdraw and needs no InsufficientFundsError catch.
        payout = target.cash;
        if (payout > 0n) {
          await tx.economy.applyBalanceChange({
            playerId: params.targetId, amount: -payout, kind: "cash", reason: "combat.killed",
          });
          await tx.economy.applyBalanceChange({
            playerId: player.id, amount: payout, kind: "cash", reason: "combat.kill_payout",
          });
        }
        // Sets hospital_until AND health = 0 in one statement.
        await tx.hospital.sendToHospital(params.targetId, config.hospitalSeconds);
      }
```

Then change the `combatLog` insert's `fatal` to `killed` and `payout` to `payout`; change the response body's `targetKilled` to `killed` and `payout` to `payout.toString()`.

After the `player.attacked` publish loop, add:

```ts
      if (killed) {
        // AFTER player.attacked, deliberately: the buffer preserves relative
        // call order to the wire, and a client rendering "shot for 40" then
        // "killed" reads correctly while the reverse does not.
        for (const audienceId of [player.id, params.targetId]) {
          await tx.events.publishCore({
            type: "player.killed",
            actorId: player.id,
            actorName: player.username,
            audience: { kind: "player", playerId: audienceId },
            victimId: params.targetId,
            victimName: targetName,
          });
        }
      }
```

Note `sendToHospital` sets `health = 0` itself, so the earlier health UPDATE is redundant on the fatal path but not wrong — both write 0. Leave it; a conditional there would be a second branch for no gain.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run --project @gl3/server apps/server/test/combat-kill.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Run the full suite, then commit**

```bash
npm run verify > /tmp/verify.log 2>&1; echo "exit=$?"
git add packages/plugins/combat/src/index.ts apps/server/test/combat-kill.test.ts vitest.workspace.ts
git commit -m "feat(combat): transfer the victim's on-hand cash and hospitalise on death

Bank is untouched, which is what makes depositing real counterplay. The
victim's cash was read under the lock taken as the transaction's first
statement, so the transfer cannot overdraw. A zero-cash victim skips both
applyBalanceChange calls rather than relying on a 0n no-op."
```

---

### Task 13: `GET /api/combat/log`

**Files:**
- Modify: `packages/plugins/combat/src/index.ts`
- Modify: `apps/server/test/combat.test.ts`

**Interfaces:**
- Produces: `logRoute` in the manifest. Returns the caller's most recent 50 rows as attacker *or* target, newest first.

Bounded at 50 from the start. `GET /api/mail` and `GET /api/notifications` are both unbounded and unpaginated — a known issue in `docs/STATUS.md` that has to be fixed before deployment. Do not add a third.

- [ ] **Step 1: Write the failing tests**

Append to `apps/server/test/combat.test.ts`:

```ts
  it("returns an empty log for a player who has never fought", async () => {
    const res = await app.inject({
      method: "GET", url: "/api/combat/log",
      headers: { authorization: `Bearer ${attackerToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ entries: [] });
  });

  it("returns shots both taken and received, newest first", async () => {
    const { db } = await testDb();
    await makeAttackable(db, attackerId, targetId);
    // Two rows inserted directly so ordering is deterministic without
    // fighting the cooldown.
    const older = uuidv7();
    const newer = uuidv7();
    await db.insert(combatLog).values([
      { id: older, attackerId, targetId, hit: true, damage: 5, fatal: false, payout: 0n,
        createdAt: new Date(Date.now() - 60_000) },
      { id: newer, attackerId: targetId, targetId: attackerId, hit: false, damage: 0,
        fatal: false, payout: 0n, createdAt: new Date() },
    ]);

    const res = await app.inject({
      method: "GET", url: "/api/combat/log",
      headers: { authorization: `Bearer ${attackerToken}` },
    });

    const { entries } = res.json();
    expect(entries).toHaveLength(2);
    expect(entries[0].id).toBe(newer);
    expect(entries[1].id).toBe(older);
  });

  it("caps the log at 50 entries", async () => {
    const { db } = await testDb();
    await makeAttackable(db, attackerId, targetId);
    await db.insert(combatLog).values(
      Array.from({ length: 60 }, (_, i) => ({
        id: uuidv7(), attackerId, targetId, hit: true, damage: 1,
        fatal: false, payout: 0n, createdAt: new Date(Date.now() - i * 1000),
      })),
    );

    const res = await app.inject({
      method: "GET", url: "/api/combat/log",
      headers: { authorization: `Bearer ${attackerToken}` },
    });

    expect(res.json().entries).toHaveLength(50);
  });
```

- [ ] **Step 2: Run to verify they fail**

```bash
npx vitest run --project @gl3/server apps/server/test/combat.test.ts
```

Expected: FAIL — 404 on the log route.

- [ ] **Step 3: Write the route**

```ts
const logRoute = route({
  method: "GET",
  path: "/api/combat/log",
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      // Bounded from the start. GET /api/mail and GET /api/notifications are
      // both unbounded and unpaginated (docs/STATUS.md, open issue) — this
      // does not become the third.
      const entries = await tx.db
        .select()
        .from(combatLog)
        .where(or(
          eq(combatLog.attackerId, player.id),
          eq(combatLog.targetId, player.id),
        ))
        .orderBy(desc(combatLog.createdAt))
        .limit(50);

      return {
        status: 200,
        body: {
          entries: entries.map((e) => ({
            id: e.id,
            attackerId: e.attackerId,
            targetId: e.targetId,
            hit: e.hit,
            damage: e.damage,
            fatal: e.fatal,
            // Money crosses the wire as a decimal string, never a JSON number.
            payout: e.payout.toString(),
            createdAt: e.createdAt.toISOString(),
          })),
        },
      };
    });
  },
});
```

Add `logRoute` to the manifest. Import `desc`, `or` from `drizzle-orm`.

- [ ] **Step 4: Run the tests, the suite, then commit**

```bash
npx vitest run --project @gl3/server apps/server/test/combat.test.ts   # PASS, 23 tests
npm run verify > /tmp/verify.log 2>&1; echo "exit=$?"
git add packages/plugins/combat/src/index.ts apps/server/test/combat.test.ts
git commit -m "feat(combat): add GET /api/combat/log

Bounded at 50 from the start — mail and notifications are both unbounded
and unpaginated already (docs/STATUS.md); this is not the third."
```

---

### Task 14: The two concurrency tests, each demonstrated red

**This is the task most likely to be done badly, and the gate that matters most.**

CLAUDE.md's corollary to rule 6: *a concurrency test whose participants all acquire locks via the same helper proves only the case that was already safe.* The pre-existing M3 deadlock test agreed on ordering by construction and stayed green straight through a real bug for exactly that reason. **Both tests below must be demonstrated failing against deliberately broken code before they are accepted.** A green test that was never shown red proves nothing.

**Files:**
- Test: `apps/server/test/combat-lock-order.test.ts`
- Test: `apps/server/test/combat-concurrency.test.ts`
- Modify: `vitest.workspace.ts` (`@gl3/server` project, both files)

**Interfaces:** consumes only the shipped route. No production code changes if both tests pass — and if either does not, the fix is in `packages/plugins/combat/src/index.ts`.

- [ ] **Step 1: Write the mutual-attack deadlock test**

Create `apps/server/test/combat-lock-order.test.ts`. Two players in one location, each with a token, firing at each other simultaneously:

```ts
  it("survives A-shoots-B and B-shoots-A fired simultaneously", async () => {
    const { db } = await testDb();
    await makeAttackable(db, playerA, playerB);
    await equipWeapon(db, playerA, { accuracy: 100, damageMin: 1, damageMax: 1 });
    await equipWeapon(db, playerB, { accuracy: 100, damageMin: 1, damageMax: 1 });

    // Both directions, many rounds: a single pass can miss the interleaving.
    for (let round = 0; round < 15; round += 1) {
      await clearCooldown(playerA);
      await clearCooldown(playerB);
      await db.update(playerStats).set({ health: 100, hospitalUntil: null })
        .where(inArray(playerStats.playerId, [playerA, playerB]));

      const [ab, ba] = await Promise.all([
        app.inject({ method: "POST", url: `/api/combat/attack/${playerB}`,
                     headers: { authorization: `Bearer ${tokenA}` } }),
        app.inject({ method: "POST", url: `/api/combat/attack/${playerA}`,
                     headers: { authorization: `Bearer ${tokenB}` } }),
      ]);

      // A deadlock surfaces as 40P01 → an unhandled error → HTTP 500.
      expect(ab.statusCode).not.toBe(500);
      expect(ba.statusCode).not.toBe(500);
    }
  });
```

- [ ] **Step 2: Demonstrate it RED**

Temporarily break the lock order in `packages/plugins/combat/src/index.ts`: replace

```ts
      await tx.locks.player([player.id, params.targetId]);
```

with a hand-rolled pair that locks in **caller order** rather than sorted order — that is the ABBA the helper exists to prevent:

```ts
      // TEMPORARY — deliberately inverted to prove the test can fail.
      await tx.db.execute(sql`SELECT 1 FROM player_stats WHERE player_id = ${player.id} FOR UPDATE`);
      await tx.db.execute(sql`SELECT 1 FROM player_stats WHERE player_id = ${params.targetId} FOR UPDATE`);
```

Run:

```bash
npx vitest run --project @gl3/server apps/server/test/combat-lock-order.test.ts
```

**Expected: FAIL**, with a real `40P01 deadlock detected` in the server log. If it passes, the test is not exercising the cycle — likely both requests are serialising somewhere earlier (check that `Promise.all` really is concurrent and that the cooldown is not rejecting one of them). **Do not proceed until you have seen it red.** Record the observed failure output in the commit message.

- [ ] **Step 3: Restore the correct lock and confirm green**

Put `await tx.locks.player([player.id, params.targetId]);` back, then:

```bash
npx vitest run --project @gl3/server apps/server/test/combat-lock-order.test.ts
```

Expected: PASS.

- [ ] **Step 4: Write the double-payout test**

Create `apps/server/test/combat-concurrency.test.ts`. Three players: two attackers, one victim at 1 hp holding cash.

```ts
  it("pays exactly one killer when two shots land on a 1-hp victim", async () => {
    const { db } = await testDb();
    await makeAttackable(db, killer1, victim);
    await makeAttackable(db, killer2, victim);
    await equipWeapon(db, killer1, { accuracy: 100, damageMin: 50, damageMax: 50 });
    await equipWeapon(db, killer2, { accuracy: 100, damageMin: 50, damageMax: 50 });
    await db.update(playerStats).set({ cash: 0n })
      .where(inArray(playerStats.playerId, [killer1, killer2]));
    await db.update(playerStats).set({ health: 1, cash: 300_000n })
      .where(eq(playerStats.playerId, victim));

    const [r1, r2] = await Promise.all([
      app.inject({ method: "POST", url: `/api/combat/attack/${victim}`,
                   headers: { authorization: `Bearer ${token1}` } }),
      app.inject({ method: "POST", url: `/api/combat/attack/${victim}`,
                   headers: { authorization: `Bearer ${token2}` } }),
    ]);

    const codes = [r1.statusCode, r2.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    const loser = r1.statusCode === 409 ? r1 : r2;
    expect(loser.json()).toMatchObject({ error: "target_hospitalised" });

    // Exactly one payout — the duplication bug this lock prevents is two
    // killers both crediting from the same cash read.
    const [k1] = await db.select().from(playerStats).where(eq(playerStats.playerId, killer1));
    const [k2] = await db.select().from(playerStats).where(eq(playerStats.playerId, killer2));
    expect(k1!.cash + k2!.cash).toBe(300_000n);

    const [v] = await db.select().from(playerStats).where(eq(playerStats.playerId, victim));
    expect(v?.cash).toBe(0n);

    // And the ledger agrees, on all three players.
    for (const id of [killer1, killer2, victim]) {
      const rows = await db.select().from(transactions).where(eq(transactions.playerId, id));
      const sum = rows.reduce((acc, t) => acc + (t.balanceKind === "cash" ? t.amount : 0n), 0n);
      const [stats] = await db.select().from(playerStats).where(eq(playerStats.playerId, id));
      expect(sum).toBe(stats?.cash);
    }
  });
```

- [ ] **Step 5: Demonstrate it RED**

Temporarily comment out the lock line entirely:

```ts
      // TEMPORARY — removed to prove the test can fail.
      // await tx.locks.player([player.id, params.targetId]);
```

Run:

```bash
npx vitest run --project @gl3/server apps/server/test/combat-concurrency.test.ts
```

**Expected: FAIL** — most likely `codes` is `[200, 200]` and the two killers' cash sums to 600000 rather than 300000 (both credited from the same read). If it passes, the two requests are not overlapping; check that both really are in flight before either commits.

Note: without the lock this may instead surface as a serialisation error, which is also a legitimate red — what matters is that it fails, and that you record *how*.

- [ ] **Step 6: Restore the lock, confirm green, run the suite**

```bash
npx vitest run --project @gl3/server apps/server/test/combat-concurrency.test.ts   # PASS
npm run verify > /tmp/verify.log 2>&1; echo "exit=$?"
```

Both files must also be in the `@gl3/server` project `include` list, or they never run and look exactly like a green suite.

- [ ] **Step 7: Commit, recording both red observations**

```bash
git add apps/server/test/combat-lock-order.test.ts apps/server/test/combat-concurrency.test.ts \
        vitest.workspace.ts
git commit -m "test(combat): prove the two-player lock against deadlock and double payout

Both tests were demonstrated failing before being accepted, per CLAUDE.md
rule 6's corollary — a concurrency test whose participants lock through
the same helper proves only the case that was already safe.

combat-lock-order: with the sorted lock replaced by caller-order SELECT
FOR UPDATE, mutual attacks produced <PASTE THE OBSERVED 40P01 HERE>.

combat-concurrency: with the lock removed, both attackers were paid —
<PASTE THE OBSERVED CASH TOTALS HERE>."
```

Replace both placeholders with the real observed output. A commit message claiming a red that was not seen is worse than no claim.

---

### Task 15: Economy invariant sweep, docs, and final verification

**Files:**
- Modify: `apps/server/test/economy-invariant.test.ts`
- Modify: `docs/STATUS.md`
- Modify: `CLAUDE.md` (current-state paragraph)

- [ ] **Step 1: Add combat operations to the 1000-op sweep**

Read `apps/server/test/economy-invariant.test.ts` and follow its existing structure exactly — it drives plugin routes through `callPluginRoute` (`test/helpers/plugin-route.ts`) and counts `attempted` / `succeeded` per operation kind.

Add two operation kinds:

- **`kill`** — pick two distinct players in the same location, both above the newbie threshold, attacker with a pinned-accuracy weapon and the victim at low health. Call the combat plugin's attack route. Count a `PluginError` as an attempted-not-succeeded, the same way the existing kinds treat `insufficient_funds`.
- **`discharge`** — hospital's discharge is a **core route**, not a plugin route, so `callPluginRoute` cannot drive it. Either drive it via `app.inject` if the file already boots an app, or omit it and note the omission in the file. Do not fake it.

The sweep's existing final assertion (`sum(ledger) == balance` for every player) is what these must satisfy; do not add a weaker per-op assertion alongside it.

Pass `settings` through `callPluginRoute`'s new option (Task 1) so the combat route sees a usable `newbie_exp_threshold` — with an empty record it takes the `100n` default, which the seeded exp must clear.

- [ ] **Step 2: Run the invariant test**

```bash
npx vitest run --project @gl3/server apps/server/test/economy-invariant.test.ts
```

Expected: PASS. Record the reported `succeeded.kill` / `attempted.kill` counts for the commit message, the way the bullets port recorded `190/201`.

- [ ] **Step 3: Update `docs/STATUS.md`**

Add a section after "The gangs port (Plan 10)" covering:

- **What shipped:** the `combat` and `inventory` plugins, core hospital, `combat_log`, `accessInHospital`, `tx.hospital.sendToHospital`, settings loading.
- **The first gameplay that is not a port.** Nine ports preserved core's wire contract byte for byte; this is new GL3-native gameplay on GL2-derived columns, with no predecessor to preserve.
- **`ctx.settings.get()` was dead surface** until Task 1 — `PluginCtxDeps.settings` was `{}` at every construction site. Any plugin that read a setting before this got null.
- **Jail and hospital are core state facilities**, and why: a facility gates every plugin's routes, so its gate must live with the route loader. A third-party plugin can hold a player via a ctx capability but cannot gate other plugins' routes.
- **`combat_log` has no `location_id`**, and the rule-6 reasoning. This is the entry a future reader is most likely to want to "fix" without knowing why.
- **Player↔player is now a live lock pair** — the third order alongside gang↔player and location↔player. They do not intersect: combat takes no location or gang lock, only reads.
- **New known issues** (below).
- The new suite counts.

New watch items to add to "Known issues and watch items":

- **`GET /api/combat/log` is bounded at 50 but not paginated** — deliberately bounded, unlike mail and notifications, but there is no way to page back further.
- **Settings are read once at boot.** Changing a `combat.*` or `hospital.*` setting needs a restart. Acceptable for admin-edited config; surprising if someone expects live tuning.
- **`effects.ts` is duplicated** between `packages/plugins/combat` and `packages/plugins/inventory`. A plugin may not import another plugin, so the two copies must be kept in step by hand; nothing enforces it. The natural fix is the equipment/inventory split the design defers to the item-economy cluster.
- **`backfire` is still unused.** Column exists, no behaviour.
- **No kills leaderboard.** Deferred.
- **Deliberate scope note:** blackmarket, trading and shops are not in this work; the only way to obtain an item today is the two seeded rows or a direct insert.

- [ ] **Step 4: Update `CLAUDE.md`'s current-state paragraph**

Replace the "Current state" paragraph's M5 sentence so it records that the module-port track is complete **and** that the first non-port gameplay cluster (PvP combat) has shipped, with the new suite counts. Keep it to the same length — that section is a summary, and `docs/STATUS.md` holds the detail.

- [ ] **Step 5: Full verification**

```bash
npm run verify > /tmp/verify.log 2>&1; echo "exit=$?"
npx tsc --build --force apps/server/tsconfig.json
grep -c "packages/plugins/combat" Dockerfile.server      # expect 5
grep -c "packages/plugins/inventory" Dockerfile.server   # expect 5
```

All four must succeed. Then run `npm run verify` **a second time** — this repo has had failures that only appear on a repeat run, and "green across repeated back-to-back runs" is the standard `docs/STATUS.md` claims.

- [ ] **Step 6: Commit**

```bash
git add apps/server/test/economy-invariant.test.ts docs/STATUS.md CLAUDE.md
git commit -m "docs(combat): record the PvP combat cluster in STATUS and CLAUDE

Adds kill operations to the economy invariant sweep. Records that
player-to-player is now a live lock pair, that combat_log's missing
location_id is deliberate (rule 6), and that settings were dead surface
until this work."
```

---

## Self-review notes

**Spec coverage.** Every section of the design spec maps to a task: §3.1 combat plugin → Tasks 9–13; §3.2 inventory → Tasks 6–8; §3.3 core hospital → Tasks 3–5; §3.4 core additions → Task 2 (`combat_log`), Task 8 (seed items), and *no task* for `tx.locks.players`, which already exists (recorded under "Corrections"); §4 data model → Tasks 2, 6, 9; §5 resolution → Tasks 9–12; §6 inventory/hospital behaviour → Tasks 5, 7, 8; §7 errors → distributed across the route tasks and asserted in each one's tests; §8 concurrency → Task 14; §9 testing → every task, with §9.3's red-first gate as Task 14.

**Known soft spots an implementer must resolve rather than guess:**

1. `AudienceSchema` may or may not have a multi-player kind. Task 11 says to check; if it does, publish once instead of twice.
2. `PluginError`'s constructor signature for the `retry-after` header is assumed in Task 10; verify against the SDK.
3. The `locations` insert column list in Task 10's helper is written from memory of `content.ts`; read the real schema.
4. `bootTestServer`'s registration response shape is assumed in several tests; copy `bank.test.ts`'s preamble verbatim instead.
5. Whether `definePlugin` accepts an empty `routes` array (Task 9 Step 6) — if not, fold Task 10's route skeleton forward.
6. The seed file's id convention (fixed literals vs `uuidv7()` + id map) in Task 8 Step 4.

Each is a five-minute read of existing code, and each is called out at the point of use.
