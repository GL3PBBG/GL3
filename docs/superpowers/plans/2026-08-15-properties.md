# Properties Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `properties` plugin — buy/sell per-location businesses with lazy on-claim income — activating the last-but-one migrated-but-unread V2 table.

**Architecture:** One new workspace-local plugin `packages/plugins/properties` owning `p_properties_properties` (relinquished from core by `0010`), following the theft plugin's route/migration/settings shape but the bounties/detectives page shape: the player page is hand-written React in `apps/web` with its DTO in `@gl3/shared` (spec §5 — per-row actions on foreign rows exceed the declarative renderer). Three money routes with path params, one list route, admin routes + declarative admin page, three player-audience plugin events.

**Tech Stack:** TypeScript ESM strict, drizzle-orm, zod, @gl3/plugin-sdk, @gl3/shared, React + tanstack-query, vitest against real Postgres 16 + Redis 7.

**Spec:** `docs/superpowers/specs/2026-08-15-properties-design.md` — the plan argues from the spec; where they conflict, the spec wins.

## Global Constraints

- TypeScript strict; **no `any` in `packages/*`**, not even a cast. Relative imports carry `.js` despite `.ts` sources.
- Zod validates every external boundary: route params AND bodies. Money crosses the wire as a decimal string, bigint throughout.
- Every balance movement goes through `tx.economy.applyBalanceChange` inside one transaction (rule 3). No floating point.
- Publish events only after the transaction commits (rule 5) — `tx.events.publish` inside `ctx.transaction` buffers; the flush is post-commit.
- **A foreign key is a lock (rule 6).** Every player-route locks `locations[L]` FIRST, then `player_stats[P]` — `tx.locks.location` then `tx.locks.player`, never inverted. Admin routes hold exactly one lock.
- **All three plugin events publish `audience: { kind: "player", playerId: player.id }`** — spec §5's events table is binding (the B1 lesson).
- Plugin routes under `/api/admin/` declare `auth: "admin"`.
- No BullMQ job, no Redis cooldown — nothing async, so rule 1 is structurally inapplicable.
- A plugin package imports only `@gl3/plugin-sdk`, `zod` and `drizzle-orm` — `@gl3/shared` is off-limits to plugin code (gangs/src/index.ts:41). The shared DTO exists for `apps/web`.
- Never run `FLUSHALL`/`FLUSHDB`; never two full suites at once; `npm run verify` run BARE with its exit code read directly.
- Bigint column defaults written `.default(sql`0`)`, never `.default(0n)`.
- Conventional Commits.

---

### Task 1: Plugin scaffold — package, migrations, schema, settings

**Files:**
- Create: `packages/plugins/properties/package.json`, `packages/plugins/properties/tsconfig.json`
- Create: `packages/plugins/properties/src/migrations.ts`, `packages/plugins/properties/src/schema.ts`, `packages/plugins/properties/src/settings.ts`
- Test: `apps/server/test/properties-settings.test.ts` (unit — no DB)
- Modify: `apps/server/package.json` (+dep), `apps/server/tsconfig.json` (+reference), root `tsconfig.json` (+reference), `vitest.workspace.ts` (+srcAlias `@gl3/plugin-properties`, + the settings test file in `@gl3/server:unit`), `apps/server/src/plugins/core-plugins.ts` (+import/+register — stub manifest, routes arrive in Task 4)

**Interfaces:**
- Produces: `PROPERTIES_MIGRATIONS: { name: string; sql: string }[]`, table handle `propertiesTable` (drizzle pgTable for `p_properties_properties`), `readPropertiesSettings(get: (key: string) => string | null): PropertiesSettings` where `PropertiesSettings = { income: { cap: bigint; defaultRate: bigint }; admin: { canEditRate: boolean } }`.

- [ ] **Step 1: Create the package.** `package.json` byte-for-byte the theft manifest with `@gl3/plugin-properties` / `properties` substitutions; `tsconfig.json` identical to `packages/plugins/theft/tsconfig.json`.

- [ ] **Step 2: Write `migrations.ts`.** Two entries (one statement per entry — `runPluginMigrations` executes each `sql` raw; postgres.js rejects multi-statement strings):

```ts
export const PROPERTIES_MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "0001_properties",
    sql: `CREATE TABLE p_properties_properties (
      id               uuid PRIMARY KEY,
      location_id      uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      plugin_id        text NOT NULL,
      owner_player_id  uuid REFERENCES players(id) ON DELETE SET NULL,
      cost             bigint NOT NULL DEFAULT 0,
      profit           bigint NOT NULL DEFAULT 0,
      last_claimed_at  timestamptz,
      rate             bigint NOT NULL DEFAULT 0
    )`,
  },
  {
    name: "0002_location_unique",
    sql: `CREATE UNIQUE INDEX p_properties_location_key ON p_properties_properties (location_id)`,
  },
];
```

A unique INDEX, not an inline table constraint: the plugin migration runner executes raw SQL and `CREATE UNIQUE INDEX` gives the same one-row-per-location guarantee without depending on drizzle-kit's constraint naming. Comment this in the file, and carry the FKs-across-verbatim note from `theft/src/migrations.ts` — dropping an FK to dodge a lock edge would change the lock graph the design reasons about.

- [ ] **Step 3: Write `schema.ts`.** The owned table plus the two core read mirrors it needs (columns only — no FK declarations on mirrors; the real constraints live in migrations):

```ts
import { sql } from "drizzle-orm";
import { bigint, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const propertiesTable = pgTable("p_properties_properties", {
  id: uuid("id").primaryKey(),
  locationId: uuid("location_id").notNull(),
  pluginId: text("plugin_id").notNull(),
  ownerPlayerId: uuid("owner_player_id"),
  cost: bigint("cost", { mode: "bigint" }).notNull().default(sql`0`),
  profit: bigint("profit", { mode: "bigint" }).notNull().default(sql`0`),
  lastClaimedAt: timestamp("last_claimed_at", { withTimezone: true }),
  rate: bigint("rate", { mode: "bigint" }).notNull().default(sql`0`),
});
```

plus `locations` (`id`, `name`) and `playerStats` (`playerId`, `locationId`, `cash`) read-mirrors copied from `packages/plugins/theft/src/schema.ts`.

- [ ] **Step 4: Write `settings.ts`.** The theft parser pattern, copied (never shared — every plugin owns its parser):

```ts
export interface PropertiesSettings {
  income: { cap: bigint; defaultRate: bigint };
  admin: { canEditRate: boolean };
}

// blank/num/big copied verbatim from packages/plugins/theft/src/settings.ts
// (the blank check is load-bearing: BigInt("") === 0n passes a >= 0n guard)

function flag(get: (key: string) => string | null, key: string, fallback: boolean): boolean {
  const raw = get(key);
  if (raw === null || raw.trim() === "") return fallback;
  return raw.trim() === "true" ? true : raw.trim() === "false" ? false : fallback;
}

export function readPropertiesSettings(get: (key: string) => string | null): PropertiesSettings {
  return {
    income: {
      cap: big(get, "income.cap", 1_000_000n),
      defaultRate: big(get, "income.default_rate", 500n),
    },
    admin: { canEditRate: flag(get, "admin.can_edit_rate", true) },
  };
}
```

Bare keys (`income.cap`, not `properties.income.cap`) — the SDK prefixes `<pluginId>.` itself. `canEditRate` is informational (spec §4): the admin page always edits `rate`; the key exists so a future runmode can pin it. Nothing reads it yet — that is the spec's instruction, not dead code to delete.

- [ ] **Step 5: Register the stub.** `apps/server/src/plugins/core-plugins.ts` gains `import propertiesPlugin from "@gl3/plugin-properties"` and adds it to `CORE_PLUGINS` after `theftPlugin` with a minimal manifest (`id: "properties"`, `version: "1.0.0"`, `basePaths: ["/api/properties", "/api/admin/properties"]`, empty routes/events/pages/adminPages). Wire every registration site: `apps/server/package.json` (+`npm install`), both tsconfig references, `vitest.workspace.ts` srcAlias. The five `Dockerfile.server` COPY lines land in Task 8's checklist but write them NOW — a missing COPY fails only in CI.

- [ ] **Step 6: Write `properties-settings.test.ts`** (the theft-settings shape): defaults on empty (`cap` 1000000n, `defaultRate` 500n, `canEditRate` true); bare keys read (`{"income.cap": "2000"}` → 2000n; `{"properties.income.cap": "2000"}` → default — the double-prefix trap); blank `"  "` → default not zero; malformed → default; negative → default; `can_edit_rate` `"false"` → false, garbage → default.

- [ ] **Step 7: Run tests + typecheck.**

```bash
DATABASE_URL=postgres://gl3:gl3@localhost:5432/gl3 REDIS_URL=redis://localhost:6379 \
  npx vitest run apps/server/test/properties-settings.test.ts
npx tsc --build --force apps/server/tsconfig.json
```
Expected: pass, no type errors. The stub manifest keeps `plugin-manifest-endpoint.test.ts` green (no menu/pages/events declared yet).

- [ ] **Step 8: Commit.**

```bash
git add -A && git commit -m "feat(properties): scaffold the plugin — package, migrations, schema, settings"
```

---

### Task 2: Core `0010_relinquish_properties` + migrate retarget

**Files:**
- Create: `apps/server/drizzle/0010_relinquish_properties.sql`
- Modify: `apps/server/drizzle/meta/_journal.json` (idx 10), `apps/server/src/db/schema/economy.ts` (remove the `properties` table + its `locationIdx`), `apps/server/test/schema.test.ts` (census), `apps/migrate/src/migrators/properties.ts` (retarget + `last_claimed_at` stamping), `apps/migrate/src/pg/plugin-tables.ts` (+mirror), `apps/server/test/helpers/plugin-tables.ts` (+mirror)

**Interfaces:**
- Consumes: `PROPERTIES_MIGRATIONS` from Task 1 (`0001_properties` creates the table the migrator writes to).
- Produces: `p_properties_properties` exists after plugin migrations; both `plugin-tables.ts` helpers export a `properties`-table handle for tests and migrate.

- [ ] **Step 1: Write the core migration.** Same shape as `0009_relinquish_car_tables.sql`:

```sql
-- Core relinquishes the last-but-one table it never touched.
-- `properties` shipped in 0000_core_schema because the core schema predated
-- the plugin migration runner. Its single consumer is the `properties` plugin,
-- which now owns and creates it as p_properties_properties. 0007 and 0009 are
-- the precedent; DROP not RENAME for the reason 0007 gives.
DROP TABLE IF EXISTS "properties" CASCADE;
```

`_journal.json` gains idx 10 (`"tag": "0010_relinquish_properties"`). No snapshot file — `0005`/`0006`/`0009` set that precedent.

- [ ] **Step 2: Remove the core table handle.** Delete `properties` and `properties_location_idx` from `apps/server/src/db/schema/economy.ts`. Grep `apps/server/src` for imports of that `properties` export — must be zero references after.

- [ ] **Step 3: Update `schema.test.ts` census.** Table list: remove `"properties"`. FK census: `properties` carried 2 FKs (location cascade, owner set null) → total 36→34, `byRule["c"]` 22→21, `byRule["n"]` 14→13. Index census: `properties_location_idx` dropped → 28→27. Extend the census comments the way `0009` did, naming `p_properties_properties` as the recreating owner.

- [ ] **Step 4: Retarget the migrator.** In `apps/migrate/src/migrators/properties.ts`: import the mirror from `../pg/plugin-tables.js` instead of the core schema; insert into `p_properties_properties`; stamp `lastClaimedAt: ownerPlayerId !== null ? new Date() : null` (spec §2: migrated owners do not inherit a phantom back-accrual from 2015); `rate` from the `properties.income.default_rate` setting, default 500. Add the mirror to both `plugin-tables.ts` files (all columns; FKs omitted per each file's convention).

- [ ] **Step 5: Update migrate tests.** `apps/migrate/test/migrators/properties.test.ts` and the idempotency suite assert the new table name; check whether `apps/migrate/test/helpers/fixtures.ts` enumerates plugin DDL. Run FIRST, read the actual failures, then fix (never guess at assertions).

- [ ] **Step 6: Run the affected suites.**

```bash
DATABASE_URL=postgres://gl3:gl3@localhost:5432/gl3 REDIS_URL=redis://localhost:6379 \
  npx vitest run apps/server/test/schema.test.ts
export MYSQL_ADMIN_URL=mysql://gl3_migrate_root:gl3_migrate_root@127.0.0.1:3306/mysql
npx vitest run --project '@gl3/migrate'
```
Expected: all green.

- [ ] **Step 7: Commit.**

```bash
git add -A && git commit -m "feat(properties): relinquish the table to the plugin and retarget the migrator"
```

---

### Task 3: Pure accrual resolver

**Files:**
- Create: `packages/plugins/properties/src/resolve.ts`
- Test: `apps/server/test/properties-resolve.test.ts` (pure — no DB)
- Modify: `vitest.workspace.ts` (+test file in `@gl3/server:unit`)

**Interfaces:**
- Produces: `accruedSince(lastClaimedAt: Date | null, rate: bigint, cap: bigint, now: Date): bigint` — Task 4's routes import it.

- [ ] **Step 1: Write the resolver.** Whole file:

```ts
/**
 * The lazy income formula, pure. `now` is handed in by the caller (inside
 * the transaction) so tests never need a fake clock.
 *
 * Whole-hour units deliberately (spec §3): profit arrives in complete hours,
 * so a claim inside the first hour banks nothing — deterministic, and it
 * makes the double-claim case answer 0 without any extra state.
 */
export function accruedSince(
  lastClaimedAt: Date | null,
  rate: bigint,
  cap: bigint,
  now: Date,
): bigint {
  if (lastClaimedAt === null || rate <= 0n) return 0n;
  const elapsedMs = now.getTime() - lastClaimedAt.getTime();
  if (elapsedMs <= 0) return 0n;
  const wholeHours = BigInt(Math.floor(elapsedMs / 3_600_000));
  const accrued = rate * wholeHours;
  return accrued > cap ? cap : accrued;
}
```

- [ ] **Step 2: Write the tests.** Exact values: null timestamp → `0n`; zero rate → `0n`; negative elapsed (clock skew) → `0n`; 59 minutes → `0n`; exactly 3600000ms → `rate`; 3h at rate 500n → `1500n`; cap clamps (`rate 500n`, cap `1000n`, 100h → `1000n`); uncapped path when cap exceeds accrual; cap boundary exact-equal passes through uncapped.

- [ ] **Step 3: Run.**

```bash
npx vitest run apps/server/test/properties-resolve.test.ts
```

- [ ] **Step 4: Red demonstration.** Temporarily change `Math.floor` to `Math.ceil`, run, show the 59-minute case fail, restore. Record the verbatim diff in the report.

- [ ] **Step 5: Commit.**

```bash
git add -A && git commit -m "feat(properties): pure whole-hour lazy income resolver"
```

---

### Task 4: Buy, sell, claim, list + the three events

**Files:**
- Modify: `packages/plugins/properties/src/index.ts` (four routes + three events + manifest wiring)
- Test: `apps/server/test/properties-routes.test.ts`, `apps/server/test/properties-events.test.ts`
- Modify: `vitest.workspace.ts` (+both files in `@gl3/server`), `apps/server/test/plugin-manifest-endpoint.test.ts` (events expectations — the tripwire)

**Interfaces:**
- Consumes: `readPropertiesSettings`, `propertiesTable`/`locations`/`playerStats` handles, `accruedSince`, `PROPERTIES_MIGRATIONS`, the Task 1 stub manifest.
- Produces: `GET /api/properties`, `POST /api/properties/:id/buy`, `POST /api/properties/:id/sell`, `POST /api/properties/:id/claim`; manifest events `bought`/`sold`/`income`. **The manifest declares NO player pages** — the page is hand-written React (Task 6), the bounties/detectives pattern.

- [ ] **Step 1: Write the four routes.** Ids in the PATH (spec §3: `/api/properties/:id/buy`), validated with `params` — the gangs/travel/detectives precedent:

```ts
const PropertyParamsSchema = z.object({ id: z.string().uuid() });
```

Every money route is the same lock skeleton (spec §6):

```ts
const buyRoute = route({
  method: "POST",
  path: "/api/properties/:id/buy",
  accessInJail: false,
  accessInHospital: true,
  params: PropertyParamsSchema,
  handler: async (ctx, { params }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    return ctx.transaction(async (tx) => {
      // Unlocked read, only to learn WHICH row (and location) we act on.
      const [before] = await tx.db
        .select({ id: propertiesTable.id, locationId: propertiesTable.locationId,
                  ownerPlayerId: propertiesTable.ownerPlayerId, cost: propertiesTable.cost })
        .from(propertiesTable)
        .where(eq(propertiesTable.id, params.id));
      if (before === undefined) throw new PluginError("property_not_found", 404);

      // RULE 6: the row's insert/update reaches locations and players by FK
      // (FOR KEY SHARE). Location first, then the player — the established
      // order for the location↔player pair; inverting it is the shipped
      // travel/bullets deadlock.
      await tx.locks.location(before.locationId);
      await tx.locks.player([player.id]);

      const [row] = await tx.db
        .select().from(propertiesTable)
        .where(eq(propertiesTable.id, params.id))
        .for("update");
      if (row === undefined) throw new PluginError("property_not_found", 404);
      if (row.ownerPlayerId !== null) throw new PluginError("already_owned", 409);

      const [stats] = await tx.db
        .select({ cash: playerStats.cash })
        .from(playerStats)
        .where(eq(playerStats.playerId, player.id));
      if (stats === undefined || stats.cash < row.cost) {
        throw new PluginError("insufficient_funds", 409);
      }
      const now = new Date();
      await tx.economy.applyBalanceChange({
        playerId: player.id, amount: -row.cost, kind: "cash", reason: "properties.buy",
      });
      await tx.db.update(propertiesTable)
        .set({ ownerPlayerId: player.id, lastClaimedAt: now })
        .where(eq(propertiesTable.id, row.id));
      await tx.events.publish({
        name: "bought",
        actorId: player.id, actorName: player.username,
        audience: { kind: "player", playerId: player.id },
        payload: { propertyName: locationName, cost: row.cost.toString() },
      });
      return { status: 200, body: { propertyId: row.id } };
    });
  },
});
```

Fetch `locationName` under the lock with the same transaction (join or second select on the locked `locations` row) before publishing — the event payload needs it.

`sellRoute` (`:id/sell`): same skeleton; `row.ownerPlayerId !== player.id` → 404 `not_owned` (404-not-403 — existence not probeable); payout = `cost + accruedSince(row.lastClaimedAt, row.rate, cap, now)`; `applyBalanceChange(+payout, "properties.sell")`; set `ownerPlayerId: null, lastClaimedAt: null, profit: row.profit + accruedPortion` (the accrued portion counts as paid out — plan ruling 3); publish `sold` with `{ propertyName, payout }`.

`claimRoute` (`:id/claim`): same skeleton; `not_owned` 404; `accrued = accruedSince(...)`; if `accrued === 0n` return `{ status: 200, body: { claimed: "0" } }` WITHOUT touching `last_claimed_at` (double-click free, spec §3); else `applyBalanceChange(+accrued, "properties.income")`, set `lastClaimedAt: now`, `profit += accrued`; publish `income` only when `accrued > 0n`.

`listRoute` (`GET /api/properties`): every property joined to `locations` (name) and `players` (owner username); response `{ rows: [...] }`, every value a string (spec §5): `id`, `locationName`, `pluginId`, `rate`, `ownerName` (or `"—"`), `cost`, `accrued` — `accrued` computed only for rows the caller owns, `"0"` otherwise. No locks (read-only).

- [ ] **Step 2: Declare the three events in the manifest.** Spec §5's binding table — wire names `bought`/`sold`/`income`, all `invalidates: ["properties", "me"]`, all player-audience at publish time:

```ts
const boughtEvent = {
  name: "bought",
  payload: z.object({ propertyName: z.string(), cost: z.string() }),
  describe: "{actorName} bought {propertyName} for {cost}",
  invalidates: ["properties", "me"],
};
const soldEvent = {
  name: "sold",
  payload: z.object({ propertyName: z.string(), payout: z.string() }),
  describe: "{actorName} sold {propertyName} for {payout}",
  invalidates: ["properties", "me"],
};
const incomeEvent = {
  name: "income",
  payload: z.object({ propertyName: z.string(), amount: z.string() }),
  describe: "{actorName} claimed {amount} from {propertyName}",
  invalidates: ["properties", "me"],
};
```

- [ ] **Step 3: Write `properties-routes.test.ts`** (`bootTestServer()`-driven; seed via the `plugin-tables.ts` mirror). Cases: list shape (all strings, `{rows}`); buy happy path (row owned, cash debited, `last_claimed_at` set, one ledger row reason `properties.buy`); buy any owned row (another's or own) → 409 `already_owned`, no money moved; insufficient funds → 409, row unchanged, no ledger row; unknown id → 404; sell happy path (seeded `last_claimed_at` 3h back at rate 500 → payout = cost + 1500; row back to market, `owner null`, `last_claimed_at null`, `profit` incremented by 1500); sell foreign → 404 `not_owned`; claim banks accrued and resets `last_claimed_at`; claim twice immediately → second answers `{ claimed: "0" }` and does NOT move `last_claimed_at`; claim foreign → 404; `sum(ledger) == balance` spot-asserted for the three money movers. One describe per file (N1).

- [ ] **Step 4: Write `properties-events.test.ts`.** All three events via `awaitOwnEvent`, envelope `{ type: "plugin.event", pluginId: "properties", name, payload }`, money as decimal strings, audience player; assert the zero-claim publishes nothing.

- [ ] **Step 5: Update `plugin-manifest-endpoint.test.ts`.** Run it FIRST and read the failure diff, then update: events array gains the three (order follows `CORE_PLUGINS` — properties after theft). `menu` and `pages` stay empty — the player page is hand-written (Task 6), so nothing appears here for it.

- [ ] **Step 6: Run everything affected.**

```bash
DATABASE_URL=postgres://gl3:gl3@localhost:5432/gl3 REDIS_URL=redis://localhost:6379 \
  npx vitest run apps/server/test/properties-routes.test.ts \
  apps/server/test/properties-events.test.ts apps/server/test/plugin-manifest-endpoint.test.ts
npx tsc --build --force apps/server/tsconfig.json
```

- [ ] **Step 7: Red demonstration.** Delete the `already_owned` re-read check in buy, run, show the 409 test fail, restore. Record verbatim.

- [ ] **Step 8: Commit.**

```bash
git add -A && git commit -m "feat(properties): buy, sell and claim with lazy income and three player events"
```

---

### Task 5: Admin routes and declarative admin page

**Files:**
- Create: `packages/plugins/properties/src/pages.ts` (`adminPage` only)
- Modify: `packages/plugins/properties/src/index.ts` (admin routes; manifest `adminPages`)
- Test: `apps/server/test/admin-properties.test.ts`
- Modify: `vitest.workspace.ts` (+test file)

**Interfaces:**
- Consumes: Task 4's routes and table handle.
- Produces: `adminPage` (`/admin/properties`); `GET /api/admin/properties` (list + the create form's location `optionsSource`), `POST /api/admin/properties` (create), `POST /api/admin/properties/update`.

- [ ] **Step 1: Write `pages.ts` — the admin page, declarative** (theft's `adminPage` pattern — admin pages ARE declarative; only the player page is hand-written): a `table` view node, columns `location`, `pluginId`, `owner`, `cost`, `rate`, `profit` — NO id column (ids travel as `select` `valueKey` only, the `admin-ids-hidden` convention). Create form (`locationId` select from `GET /api/admin/properties` listing unclaimed locations, `pluginId` text, `cost` money, `rate` money) and update form keyed off the same select.

- [ ] **Step 2: Write the three admin routes.** All `auth: "admin"`, under `/api/admin/properties`; ids in the BODY (form posts — the admin renderer's convention). Schemas `.strict()`; `cost`/`rate` as decimal-string money fields; the admin list also returns the location options. Create: unique-location violation → 409 `location_taken`. Update: select the row FOR UPDATE — **this route takes exactly one lock and touches no other table; the same mandated comment as theft's admin car editor goes above it** (a transaction holding exactly one lock cannot be half of a deadlock cycle). Unknown id → 404. Blank fields keep old values (theft's blank-keeps-old behavior).

- [ ] **Step 3: Write `admin-properties.test.ts`** — the admin-theft shape: 403 non-admin on every admin route (**vary `remoteAddress` across cases** — N2); create+list round-trip as `{rows}`; duplicate location → 409, no second row; blank-name update keeps old value; 404 unknown id; invalid `cost: "-5"` → 400, DB unchanged; page-shape walk asserting no `table` node's `columns[].key` matches `/^id$|Id$/` while `id` appears as a select's `valueKey`. One describe per file.

- [ ] **Step 4: Run + tripwires.**

```bash
npx vitest run apps/server/test/admin-properties.test.ts apps/server/test/plugin-manifest-endpoint.test.ts apps/server/test/admin-ids-hidden.test.ts
```

- [ ] **Step 5: Commit.**

```bash
git add -A && git commit -m "feat(properties): admin page and routes for cost, rate and creation"
```

---

### Task 6: Shared DTO, web page, menu and route

**Files:**
- Create: `packages/shared/src/dto/properties.ts`; `apps/web/src/pages/Properties.tsx`
- Modify: `packages/shared/src/index.ts` (+export), `packages/shared/package.json` (version `0.1.3`), `apps/web/src/api/keys.ts` (+`properties`), `apps/web/src/api/queries.ts` (+four hooks), `apps/web/src/App.tsx` (+route), `apps/web/src/components/Shell.tsx` (+LINKS entry)
- Test: `apps/web/test/properties-page.test.ts` (row-action logic — the pure functions, the detectives `rowState` pattern)

**Interfaces:**
- Consumes: Task 4's routes (`GET /api/properties`, `POST /api/properties/:id/buy|sell|claim`) and event `invalidates: ["properties", "me"]`.
- Produces: `PropertyRowSchema`/`PropertyListResponseSchema` in `@gl3/shared`; the `/properties` page at menu position after Detectives; `keys.properties()`.

- [ ] **Step 1: Write the shared DTO** (`packages/shared/src/dto/properties.ts`, exported from `packages/shared/src/index.ts`):

```ts
import { z } from "zod";

/** Mirrors the plugin's GET /api/properties rows — every value a string. */
export const PropertyRowSchema = z.object({
  id: z.string(),
  locationName: z.string(),
  pluginId: z.string(),
  rate: z.string(),
  ownerName: z.string(),
  cost: z.string(),
  accrued: z.string(),
});
export type PropertyRow = z.infer<typeof PropertyRowSchema>;

export const PropertyListResponseSchema = z.object({ rows: z.array(PropertyRowSchema) });
export type PropertyListResponse = z.infer<typeof PropertyListResponseSchema>;
```

The plugin cannot import `@gl3/shared` (off-limits to plugin packages); this DTO exists for `apps/web`, exactly as `detectives.ts` and `bounties.ts` do. Bump `packages/shared/package.json` to `0.1.3` (additive patch — same policy as `0.1.2`; the republish itself is Task 8, after verify).

- [ ] **Step 2: Add the query key and hooks.** `keys.ts`: `properties: () => ["properties"] as const` (the manifest's `invalidates: ["properties", ...]` resolves to this prefix — the two files must agree or an event refreshes nothing). `queries.ts`, the detectives/bounties shape:

```ts
export function useProperties() {
  return useQuery({
    queryKey: keys.properties(),
    queryFn: async () => PropertyListResponseSchema.parse(await api("/api/properties")),
  });
}
export function useBuyProperty() {
  return useMutation({
    mutationFn: async (propertyId: string) =>
      api(`/api/properties/${propertyId}/buy`, { method: "POST" }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: keys.properties() });
      void queryClient.invalidateQueries({ queryKey: keys.me() });
    },
  });
}
```

`useSellProperty`/`useClaimProperty` identical with `/sell` and `/claim`. The `:id` interpolation is URL-path construction on a UUID already parsed by `PropertyRowSchema` — no injection surface.

- [ ] **Step 3: Write `Properties.tsx`** — the bounties/detectives page pattern. A table of the world's properties (location, flavour label = `pluginId`, rate, owner or "—", cost when unowned) and the per-row action (spec §5): **Buy when unowned, Claim when yours (showing `accrued`), nothing when another's**. Extract that decision as a pure function:

```ts
function rowAction(row: PropertyRow, viewerUsername: string | undefined):
  { kind: "buy" } | { kind: "claim"; accrued: string } | { kind: "none" } {
  if (row.ownerName === "—") return { kind: "buy" };
  if (viewerUsername !== undefined && row.ownerName === viewerUsername) {
    return { kind: "claim", accrued: row.accrued };
  }
  return { kind: "none" };
}
```

Use `Panel`, `Loading`, `ErrorText`, `Money`, `styles` from `pages.module.css` — the established page furniture. Loading/error/mutation-error handling identical to `Bounties.tsx`.

- [ ] **Step 4: Wire the route and menu.** `App.tsx`: `<Route path="properties" element={<Properties />} />` beside the other hand-written plugin pages (`bounties`, `detectives`). `Shell.tsx` `LINKS`: `["/properties", "Properties"]` after `["/detectives", "Detectives"]`. Spec §5's "menu order 42" assumed a manifest menu entry; a hand-written page has no manifest entry, so LINKS position is the ruling (plan ruling 9).

- [ ] **Step 5: Write `properties-page.test.ts`** — unit-test `rowAction`: unowned → buy; owned-by-viewer → claim with accrued; owned-by-other → none; missing viewer → none even if names match. No DOM test (no existing precedent — every web test is a pure-function test).

- [ ] **Step 6: Register and run.**

```bash
npx vitest run --project '@gl3/web'
npx tsc --build --force apps/web/tsconfig.json 2>/dev/null || npx tsc --build --force apps/server/tsconfig.json
```
Add the test file to `vitest.workspace.ts`'s `@gl3/web` list (the ninth registration site's test-file sibling).

- [ ] **Step 7: Commit.**

```bash
git add -A && git commit -m "feat(web): properties page with per-row buy and claim actions"
```

---

### Task 7: Lock-order regression test

**Files:**
- Test: `apps/server/test/properties-lock-order.test.ts`
- Modify: `vitest.workspace.ts` (+file)

**Interfaces:**
- Consumes: Task 4's buy route; real `travel` and `bullets` routes as counterparties; the `plugin-tables.ts` mirror to seed.

- [ ] **Step 1: Write the test.** The `theft-lock-order.test.ts` shape, transposed:

Test 1 — the deterministic barrier: a blocker connection holds `locations[L]` FOR UPDATE; a real travel `L→C` parks behind it; a real buy (of the property at `L`) queues behind that; blocker rolls back. Under the shipped order the buy commits; under a player-first inversion the buy holds `player_stats[P]` wanting `locations[L]` while travel holds `locations[L]` wanting `player_stats[P]` — 40P01.

Test 2 — real load: 20 rounds × concurrent buys/sells/claims against two locations' properties, plus real bullets purchases and real travels contending. Refusals enumerated per route (buy: `already_owned`/`insufficient_funds`/`property_not_found`; sell/claim: `not_owned`; travel: `on_cooldown`/`already_there`/`location_changed`; buy-bullets: `insufficient_stock`/`insufficient_funds`/`no_location`); every response `< 500` and its body free of `40P01`/`deadlock`; floors on successful operations; per-player ledger invariant.

Test 3 — module counter asserting at least one successful buy AND at least one refusal occurred across the run (proves the load was real, not all no-ops).

- [ ] **Step 2: Run it green three times** (flake check — flaky means broken).

- [ ] **Step 3: Red demonstration.** Invert buy's two lock lines; run; expect the barrier test's 500 (40P01) and the load test's `< 500` failure. Capture the Postgres deadlock log lines (`/var/log/postgresql/postgresql-16-main.log`, only what this run appended) naming the two processes and their statements. Restore; re-run green.

- [ ] **Step 4: Commit.**

```bash
git add -A && git commit -m "test(properties): prove buy locks the location before the player"
```

---

### Task 8: Full verification, republish and documentation

**Files:**
- Modify: `docs/STATUS.md`, `CLAUDE.md`

- [ ] **Step 1: `npm run verify` BARE** (env: `DATABASE_URL`, `REDIS_URL`, `MYSQL_ADMIN_URL=mysql://gl3_migrate_root:gl3_migrate_root@127.0.0.1:3306/mysql`). No pipes, no `; echo` — read the exit code directly. Any non-zero exit is a failure even if the summary is green. If it fails: diagnose before fixing; fix only what this branch unambiguously introduced; report DONE_WITH_CONCERNS/BLOCKED rather than claiming a green suite that does not exist. If a new file times out at 5000ms under load, check whether it boots `bootTestServer()` inside a test body — `dbTestTimeout` already covers both Postgres projects, so a timeout means the file is genuinely slow and needs its own per-test timeout or a leaner boot.

- [ ] **Step 2: CI-only checks.**

```bash
grep -c "packages/plugins/properties" Dockerfile.server   # 5
npx tsc --build --force apps/server/tsconfig.json
```
Plus both tsconfig references, the `srcAliases` entry, and every vitest include entry re-confirmed.

- [ ] **Step 3: Republish `@gl3/shared` as `0.1.3`.** Only after verify is green. Build and publish from `packages/shared` to the private registry, the same way `0.1.2` went out (see `git log` around commit `5de598f` and the publish notes in CLAUDE.md/STATUS.md — `files` in the manifest is load-bearing; `dist/` is gitignored). Then record in CLAUDE.md that the registry serves `@gl3/shared` `0.1.2` and `0.1.3`. The SDK needs no bump — nothing it exposes changed.

- [ ] **Step 4: Docs.** CLAUDE.md: properties cluster in "Current state" (third of four; `0010` relinquish; **seven** of sixteen plugins declare migrations); suite counts to the measured figures; rule 6's proven-paths list gains properties' buy/sell/claim with `test/properties-lock-order.test.ts`; the shared-registry paragraph gains `0.1.3`. STATUS.md: the cluster section (routes, lazy income semantics, the events table, `plugin_id` dormant ruling, admin surface, hand-written page, test files), suite line, milestone row.

- [ ] **Step 5: Commit.**

```bash
git add CLAUDE.md docs/STATUS.md && git commit -m "docs: record the properties plugin and the table relinquish"
```

---

## Plan-level rulings (made at plan time, binding on implementers)

1. **Routes take the id in the PATH** (`/api/properties/:id/buy`), validated via `params` — spec §3's shape; gangs/travel/detectives precedent. Admin routes keep ids in the BODY (form posts).
2. **Unique index, not UNIQUE constraint** in migration `0002` — same guarantee, no reliance on drizzle-kit constraint naming.
3. **`profit` records lifetime income paid out**, incremented at claim and at sell (sell's accrued portion counts as paid); it is a ledger of record, not a claimable pool. The claimable pool is always computed fresh from `last_claimed_at`. (Spec §3 is silent on sell incrementing `profit`; this reading keeps the column meaning "paid out" consistent.)
4. **Zero-claim is a free 200** and does not move `last_claimed_at` — double-click safe (spec §3).
5. **Sell pays `cost + accrued`** — the owner recovers the purchase price plus banked-but-unclaimed income; the buyer pays `cost` only; there is no market (user decision 2026-08-15).
6. **`plugin_id` is dormant** — stored, listed, admin-editable, selects nothing (user decision 2026-08-15: label only).
7. **Admin update takes FOR UPDATE on exactly one row and touches no other table**, with the mandated single-lock comment — the theft admin-car-editor argument.
8. **Migration stamps `last_claimed_at = migration time` for owned rows** — migrated owners start accruing from migration, not 2015 (spec §2).
9. **Menu position is a LINKS entry after Detectives**, not a manifest menu order — spec §5 wrote "order 42" assuming a declarative page, then mandated a hand-written page, which has no manifest entry. LINKS position honors the intent.
10. **`canEditRate` parses but nothing reads it** — spec §4 creates it for a future runmode; deleting it would deviate from the spec's settings table.

## Self-review

**Spec coverage:** §1 scope → Tasks 4, 5, 6. §2 table ownership + migrator → Tasks 1, 2. §3 income model → Tasks 3, 4. §4 settings (all three keys) → Task 1. §5 events → Task 4; player page → Task 6; admin page → Task 5. §6 lock order → Task 4 (implementation), Task 7 (proof). §7 testing → each task's test steps + Task 2 (migrate half). §8 registration sites → Task 1 Step 5, Task 6 Step 4, Task 8 Step 2. §9 framing → Task 8 Step 4.

**Placeholder scan:** `locationName` in the Task 4 buy route is fetched under the lock — spelled out in prose immediately below the block. No TBD/TODO anywhere.

**Type consistency:** `accruedSince(lastClaimedAt, rate, cap, now)` defined Task 3, consumed Task 4. `PropertyRowSchema` fields match the list route's row shape (Task 4 Step 1 ↔ Task 6 Step 1 ↔ Step 3's `rowAction`). `keys.properties()` defined and consumed within Task 6. Events `bought`/`sold`/`income` consistent across manifest, publish sites, tests, and the tripwire.
