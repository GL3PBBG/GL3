# Car Theft, Garage and Police Chase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a `theft` plugin that owns `cars`, `theft_tiers` and `garage`, lets a player steal a car by tier, survive or fail a police chase, and list / sell / repair the cars in their garage.

**Architecture:** One new workspace-local plugin package, `packages/plugins/theft`, holding three plugin-owned tables (`p_theft_cars`, `p_theft_tiers`, `p_theft_garage`), a pure outcome resolver, six player routes, two declarative pages and one admin page. Core relinquishes the three tables in a new migration; `apps/migrate` retargets its writes to the plugin-owned names through the existing `pg/plugin-tables.ts` seam. Every location↔player transaction locks the location first, which is what keeps the plugin off the shipped travel deadlock.

**Tech Stack:** TypeScript strict ESM, Fastify via the plugin loader, drizzle-orm on PostgreSQL 16, Redis 7 for cooldowns, zod at every boundary, vitest against real Postgres and Redis.

**Spec:** `docs/superpowers/specs/2026-08-15-car-theft-garage-police-chase-design.md`

## Global Constraints

- **Every balance movement goes through `tx.economy.applyBalanceChange`.** One transaction, one ledger row, `bigint` throughout, no floating point. `sum(ledger) == balance` is enforced by `apps/server/test/economy-invariant.test.ts`.
- **A foreign key is a lock.** Inserting a row whose FK references another row takes `FOR KEY SHARE` on it, which conflicts with `FOR UPDATE`. **Theft locks the location first**, via `tx.locks.location(locationId)` — never a hand-written `SELECT ... FOR UPDATE` — then `tx.locks.player([playerId])`.
- **Never check-then-act on Redis.** Cooldowns go through `ctx.cooldown.acquire/peek/release` only.
- **Publish events only after the transaction commits.** `tx.events.publish` / `tx.events.publishCore` buffer; the loader flushes after commit. Never publish outside the transaction callback.
- **This cluster adds no `GameEvent` variant.** Plugin events plus the existing `player.jailed`. If that decision is ever reversed, the change must run the whole of `npm run verify` — widening the union breaks `apps/web/src/lib/eventCopy.ts`, `apps/web/src/ws/invalidation.ts` and the `CORPUS` drift guard in `apps/server/test/plugin-ctx-core-events.test.ts`, and the third fails only under the integration suite.
- **No `any` in `packages/*`** — none, not even a cast. Type guards over casts.
- **ESM only; relative imports carry a `.js` extension** despite `.ts` sources.
- **Money is `bigint` in Postgres and TypeScript, and a decimal string on the wire** (`MoneySchema`). Never a JSON number.
- **Bigint column defaults are written `` .default(sql`0`) ``**, never `.default(0n)` — drizzle-kit's serialiser crashes on `BigInt`.
- **One SQL statement per plugin migration.** `runPluginMigrations` issues exactly one `tx.execute(sql.raw(migration.sql))` per declared migration and postgres.js rejects multi-statement strings through `unsafe()`. An index is its own migration.
- **A test that drives a plugin without `bootTestServer()` must run that plugin's migrations itself** — `await runPluginMigrations(db, [theftPlugin])`. The template database is built from core migrations only.
- **Zod-validates every external boundary** — HTTP bodies, route params, WS frames, bus messages.
- Integration tests run against **real** Postgres and Redis. No mocks for DB, queue or bus paths, ever.
- Conventional Commits.
- Run the suite with `npm run verify` **bare** — do not pipe it through `grep`/`tail` and do not append `; echo "exit=$?"`; both discard npm's exit status. Never run two full suites at once.
- **Never run `FLUSHALL` / `FLUSHDB`.** Redis is shared across every test file and every concurrent agent.
- Required env for the suite: `DATABASE_URL`, `REDIS_URL`, and — for `apps/migrate`'s 25 test files — `MYSQL_ADMIN_URL` (see `.env.example`).

## Plan-level rulings

Three details in the spec do not survive contact with the repo. Rulings, made here so no implementer has to guess:

1. **The core migration is `0009_relinquish_car_tables`, not `0008`.** `apps/server/drizzle/0008_sentence_expiry_indexes.sql` already exists (it shipped with spec 1). The spec's `0008` was written before that landed.
2. **The plugin event is `theft.sold`, not `garage.sold`.** Plugin events are namespaced by plugin id on the wire, so a plugin with id `theft` cannot emit a `garage.*` event. Declared name is `sold`; it reaches clients as `theft.sold`.
3. **`theft.resolved` carries one `describe` template, not two.** A manifest event declares a single template, so the two phrasings in spec §7 become one template `"{actorName} {outcome}"` with the phrase in the payload. The alternative — two event names — would fragment one outcome across two invalidation sets for no gain.

## File structure

| File | Responsibility |
|---|---|
| `packages/plugins/theft/package.json`, `tsconfig.json` | package identity and build |
| `packages/plugins/theft/src/schema.ts` | drizzle handles: three owned tables plus read-only mirrors of `players`, `player_stats`, `locations` |
| `packages/plugins/theft/src/migrations.ts` | four one-statement migrations |
| `packages/plugins/theft/src/settings.ts` | `readTheftSettings` — pure, total, every key defaulted |
| `packages/plugins/theft/src/resolve.ts` | `bracketWeight`, `resolveTheft` — pure, no DB, no randomness |
| `packages/plugins/theft/src/pages.ts` | the two player `PageSchema`s and the admin `PageSchema` |
| `packages/plugins/theft/src/index.ts` | routes + `definePlugin` manifest |
| `apps/server/drizzle/0009_relinquish_car_tables.sql` | core drops the three tables |
| `apps/migrate/src/pg/plugin-tables.ts` | mirrors for the three relinquished tables |

---

### Task 1: The `theft` plugin package, its tables and its settings

Creates the package, its three owned tables, the settings parser, one read-only route so the manifest is non-trivial, and **all** registration sites. No gameplay yet.

**Files:**
- Create: `packages/plugins/theft/package.json`
- Create: `packages/plugins/theft/tsconfig.json`
- Create: `packages/plugins/theft/src/schema.ts`
- Create: `packages/plugins/theft/src/migrations.ts`
- Create: `packages/plugins/theft/src/settings.ts`
- Create: `packages/plugins/theft/src/index.ts`
- Modify: `apps/server/package.json` (dependency), `apps/server/tsconfig.json` (reference), root `tsconfig.json` (reference), `vitest.workspace.ts` (srcAlias + unit-project include), `apps/server/src/plugins/core-plugins.ts` (import + `CORE_PLUGINS`), `Dockerfile.server` (five COPY lines)
- Test: `apps/server/test/theft-settings.test.ts`, `apps/server/test/theft-tiers.test.ts`

**Interfaces:**
- Produces: `theftPlugin` (default export of `@gl3/plugin-theft`); `THEFT_MIGRATIONS: { name: string; sql: string }[]`; `readTheftSettings(get: (key: string) => string | null): TheftSettings`; the drizzle handles `cars`, `theftTiers`, `garage`, `players`, `playerStats`, `locations` from `./schema.js`.
- Consumes: `@gl3/plugin-sdk`'s `definePlugin`, `route`, `PluginError`.

- [ ] **Step 1: Create the package manifest and tsconfig**

`packages/plugins/theft/package.json`:

```json
{
  "name": "@gl3/plugin-theft",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": { "build": "tsc --build" },
  "dependencies": { "@gl3/plugin-sdk": "*", "drizzle-orm": "^0.45.2", "zod": "^3.23.8" }
}
```

`packages/plugins/theft/tsconfig.json`:

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "./src", "outDir": "./dist" },
  "include": ["src/**/*"],
  "references": [{ "path": "../../plugin-sdk" }]
}
```

- [ ] **Step 2: Write the schema**

`packages/plugins/theft/src/schema.ts`:

```ts
import { bigint, integer, pgTable, text, uuid } from "drizzle-orm/pg-core";

/**
 * The three tables this plugin OWNS. Core relinquished them in
 * `0009_relinquish_car_tables`; `migrations.ts` is the definition and these
 * handles must be kept in step with it by hand.
 */
export const cars = pgTable("p_theft_cars", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  value: bigint("value", { mode: "bigint" }).notNull(),
  theftWeight: integer("theft_weight").notNull().default(1),
});

export const theftTiers = pgTable("p_theft_tiers", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  successChance: integer("success_chance").notNull(),
  maxDamage: integer("max_damage").notNull(),
  minCarValue: bigint("min_car_value", { mode: "bigint" }).notNull(),
  maxCarValue: bigint("max_car_value", { mode: "bigint" }).notNull(),
});

export const garage = pgTable("p_theft_garage", {
  id: uuid("id").primaryKey(),
  playerId: uuid("player_id").notNull(),
  carId: uuid("car_id").notNull(),
  damage: integer("damage").notNull().default(0),
  locationId: uuid("location_id"),
});

/**
 * Read/write mirrors of core-owned tables, the pattern
 * `packages/plugins/inventory/src/schema.ts` established. Only the columns
 * this plugin touches are listed, and none of these gets a migration here.
 *
 * The FKs that `p_theft_garage` really has are NOT declared above: drizzle
 * only needs `references` to generate DDL, and nothing here generates DDL.
 * The real constraints live in migrations.ts, and they are what rule 6's
 * lock graph is reasoned about.
 */
export const players = pgTable("players", {
  id: uuid("id").primaryKey(),
  username: text("username").notNull(),
});

export const playerStats = pgTable("player_stats", {
  playerId: uuid("player_id").primaryKey(),
  cash: bigint("cash", { mode: "bigint" }).notNull(),
  locationId: uuid("location_id"),
});

export const locations = pgTable("locations", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
});
```

- [ ] **Step 3: Write the migrations**

`packages/plugins/theft/src/migrations.ts`:

```ts
/**
 * Four migrations, not one: `runPluginMigrations` issues exactly one
 * `tx.execute(sql.raw(migration.sql))` per declaration, and postgres.js
 * rejects a multi-statement string through `unsafe()` unless `.simple()` is
 * used. So the index is its own entry.
 *
 * The foreign keys came ACROSS from core's `0000_core_schema` verbatim,
 * exactly as `p_bounties_bounties` and `p_detectives_searches` kept theirs.
 * Dropping one to dodge a lock edge would change behaviour AND change the
 * lock graph the design doc reasons about; keeping them leaves the graph
 * exactly as it was.
 *
 * Order matters: `p_theft_garage` references `p_theft_cars`, so the cars
 * table must be created first.
 */
export const THEFT_MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "0001_cars",
    sql: `CREATE TABLE p_theft_cars (
      id           uuid    PRIMARY KEY,
      name         text    NOT NULL,
      value        bigint  NOT NULL,
      theft_weight integer NOT NULL DEFAULT 1
    )`,
  },
  {
    name: "0002_tiers",
    sql: `CREATE TABLE p_theft_tiers (
      id             uuid    PRIMARY KEY,
      name           text    NOT NULL,
      success_chance integer NOT NULL,
      max_damage     integer NOT NULL,
      min_car_value  bigint  NOT NULL,
      max_car_value  bigint  NOT NULL
    )`,
  },
  {
    name: "0003_garage",
    sql: `CREATE TABLE p_theft_garage (
      id          uuid    PRIMARY KEY,
      player_id   uuid    NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      car_id      uuid    NOT NULL REFERENCES p_theft_cars(id) ON DELETE CASCADE,
      damage      integer NOT NULL DEFAULT 0,
      location_id uuid    REFERENCES locations(id) ON DELETE SET NULL
    )`,
  },
  {
    name: "0004_garage_player_idx",
    sql: `CREATE INDEX p_theft_garage_player_idx ON p_theft_garage (player_id)`,
  },
];
```

- [ ] **Step 4: Write the failing settings test**

`apps/server/test/theft-settings.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readTheftSettings } from "@gl3/plugin-theft/settings";

const from = (rows: Record<string, string>) => (key: string): string | null => rows[key] ?? null;

describe("readTheftSettings", () => {
  it("defaults every key on an empty settings table", () => {
    const s = readTheftSettings(from({}));
    expect(s.cooldownSeconds).toBe(300);
    expect(s.chase.escapeChance).toBe(40);
    expect(s.chase.jailSeconds).toBe(600);
    expect(s.repair.costPerPoint).toBe(500n);
  });

  it("reads BARE keys, not plugin-prefixed ones", () => {
    // The SDK namespaces: ctx.settings.get looks up `theft.<key>`. A parser
    // that asked for "theft.cooldown_seconds" would resolve
    // "theft.theft.cooldown_seconds" — never present, so every setting would
    // silently fall back with no error anywhere.
    expect(readTheftSettings(from({ cooldown_seconds: "45" })).cooldownSeconds).toBe(45);
    expect(readTheftSettings(from({ "theft.cooldown_seconds": "45" })).cooldownSeconds).toBe(300);
  });

  it("floors the cooldown at 1 so Redis SET ... EX 0 can never be issued", () => {
    expect(readTheftSettings(from({ cooldown_seconds: "0" })).cooldownSeconds).toBe(1);
  });

  it("treats a blank value as absent rather than as zero", () => {
    // Number("") === 0 and BigInt("") === 0n, both of which pass a >= 0
    // guard. Without the blank check a cleared admin field would mean
    // "escape is impossible" instead of "use the default".
    expect(readTheftSettings(from({ "chase.escape_chance": "   " })).chase.escapeChance).toBe(40);
    expect(readTheftSettings(from({ "repair.cost_per_point": "" })).repair.costPerPoint).toBe(500n);
  });

  it("clamps the escape chance into 0..100", () => {
    expect(readTheftSettings(from({ "chase.escape_chance": "250" })).chase.escapeChance).toBe(100);
    expect(readTheftSettings(from({ "chase.escape_chance": "-5" })).chase.escapeChance).toBe(40);
  });

  it("falls back rather than throwing on a malformed value", () => {
    expect(readTheftSettings(from({ "repair.cost_per_point": "not a number" })).repair.costPerPoint).toBe(500n);
  });
});
```

Note the import specifier `@gl3/plugin-theft/settings`: add a subpath export for it in `package.json` — `"./settings": { "types": "./dist/settings.d.ts", "default": "./dist/settings.js" }` — **and** a matching `vitest.workspace.ts` alias (Step 8). If the subpath proves awkward, import from `"@gl3/plugin-theft"` instead and re-export `readTheftSettings` from `src/index.ts`; either is acceptable, but pick one and use it consistently.

- [ ] **Step 5: Run the test to verify it fails**

Run: `npx vitest run --project '@gl3/server:unit' apps/server/test/theft-settings.test.ts`
Expected: FAIL — cannot resolve `@gl3/plugin-theft`.

- [ ] **Step 6: Write the settings parser**

`packages/plugins/theft/src/settings.ts`:

```ts
export interface TheftSettings {
  cooldownSeconds: number;
  chase: { escapeChance: number; jailSeconds: number };
  repair: { costPerPoint: bigint };
}

/**
 * The three helpers below are copied rather than shared. Every plugin that
 * reads settings owns its own parser today (`combat/src/settings.ts`,
 * `oc/src/settings.ts`, `inventory/src/index.ts`); the SDK exposes none, and
 * reaching into another plugin's package for one would invert the dependency
 * direction the loader relies on.
 *
 * The blank check is load-bearing, not defensive noise: BOTH parsers coerce
 * an empty or whitespace-only string to ZERO (`Number("") === 0`,
 * `BigInt("") === 0n`) and zero passes the `>= 0` guard, so without it a
 * cleared admin field silently means "zero" instead of "use the default".
 */
function blank(raw: string | null): raw is null {
  return raw === null || raw.trim() === "";
}

function num(get: (key: string) => string | null, key: string, fallback: number): number {
  const raw = get(key);
  if (blank(raw)) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function big(get: (key: string) => string | null, key: string, fallback: bigint): bigint {
  const raw = get(key);
  if (blank(raw)) return fallback;
  try {
    const parsed = BigInt(raw);
    return parsed >= 0n ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Keys are BARE — `cooldown_seconds`, not `theft.cooldown_seconds`. The SDK
 * namespaces them (`ctx.settings.get` looks up `<pluginId>.<key>`), which is
 * what stops one plugin reading another's configuration.
 *
 * `cooldownSeconds` is floored at 1 deliberately: a zero TTL makes Redis
 * `SET ... EX 0` fail, which is the exact live crash `travel_cooldown_seconds
 * = 0` still has. Not copied into a new module.
 */
export function readTheftSettings(get: (key: string) => string | null): TheftSettings {
  return {
    cooldownSeconds: Math.max(1, num(get, "cooldown_seconds", 300)),
    chase: {
      escapeChance: Math.min(100, num(get, "chase.escape_chance", 40)),
      jailSeconds: Math.max(1, num(get, "chase.jail_seconds", 600)),
    },
    repair: { costPerPoint: big(get, "repair.cost_per_point", 500n) },
  };
}
```

- [ ] **Step 7: Write the manifest with the tiers route**

`packages/plugins/theft/src/index.ts` — the tier listing route and a minimal manifest. `GET /api/theft/tiers` is read-only, takes no locks, and **must not spend the cooldown**: a player must never burn an action to discover a rule.

```ts
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { definePlugin, PluginError, route } from "@gl3/plugin-sdk";
import { cars, theftTiers } from "./schema.js";
import { THEFT_MIGRATIONS } from "./migrations.js";
import { readTheftSettings } from "./settings.js";

/**
 * Shaped as a TableRowsResponse (`{ rows: [{...strings}] }`) because it is
 * both the `table.source` and the `optionsSource` of the steal form's select.
 * Every value is a string for that reason. `id` is present as the select's
 * valueKey and is never rendered as a column.
 */
const tiersRoute = route({
  method: "GET",
  path: "/api/theft/tiers",
  accessInJail: true,
  accessInHospital: true,
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    const cooldownRemaining = await ctx.cooldown.peek("theft", player.id);

    return ctx.transaction(async (tx) => {
      const tiers = await tx.db.select().from(theftTiers).orderBy(theftTiers.minCarValue);
      const rows = [];
      for (const tier of tiers) {
        const [counted] = await tx.db
          .select({ n: sql<number>`count(*)::int` })
          .from(cars)
          .where(and(gte(cars.value, tier.minCarValue), lte(cars.value, tier.maxCarValue)));
        rows.push({
          id: tier.id,
          name: tier.name,
          successChance: String(tier.successChance),
          maxDamage: String(tier.maxDamage),
          minCarValue: tier.minCarValue.toString(),
          maxCarValue: tier.maxCarValue.toString(),
          cars: String(counted?.n ?? 0),
          cooldownRemaining: String(cooldownRemaining),
        });
      }
      return { status: 200, body: { rows } };
    });
  },
});

export default definePlugin({
  id: "theft",
  version: "1.0.0",
  basePaths: ["/api/theft", "/api/garage", "/api/admin/theft"],
  tables: {
    cars: "p_theft_cars",
    tiers: "p_theft_tiers",
    garage: "p_theft_garage",
  },
  migrations: THEFT_MIGRATIONS,
  routes: [tiersRoute],
});
```

`eq` and `readTheftSettings` are imported for later tasks; if the compiler flags them as unused at this stage, drop the import and re-add it in Task 4 rather than leaving a lint error.

- [ ] **Step 8: Register the plugin at all eight sites**

Three of these fail silently or only in CI. Do all eight:

1. `packages/plugins/theft/` — done above.
2. `apps/server/package.json` — add `"@gl3/plugin-theft": "*"` to `dependencies`, then run `npm install`.
3. `apps/server/tsconfig.json` — add `{ "path": "../../packages/plugins/theft" }` to `references`. **Missing this fails only in CI**; the root tsconfig makes `npm run typecheck` pass regardless.
4. Root `tsconfig.json` — add the same reference.
5. `vitest.workspace.ts` — add to `srcAliases.resolve.alias`:

```ts
      "@gl3/plugin-theft": fileURLToPath(
        new URL("./packages/plugins/theft/src/index.ts", import.meta.url),
      ),
      "@gl3/plugin-theft/settings": fileURLToPath(
        new URL("./packages/plugins/theft/src/settings.ts", import.meta.url),
      ),
      "@gl3/plugin-theft/resolve": fileURLToPath(
        new URL("./packages/plugins/theft/src/resolve.ts", import.meta.url),
      ),
```

   **Missing this fails nothing** and silently grades the last `tsc --build` against a stale `dist/`. The `resolve` alias is for Task 3; add it now so Task 3 needs no workspace edit. Create `packages/plugins/theft/src/resolve.ts` as a stub exporting nothing yet only if the alias errors without it — vitest aliases are lazy, so it normally will not.

   Also add the two new unit test files to the `@gl3/server:unit` project's `include` array in the same file, alongside `test/combat-resolve.test.ts`:

```ts
        "test/theft-settings.test.ts",
        "test/theft-resolve.test.ts",
```

6. `apps/server/src/plugins/core-plugins.ts` — `import theftPlugin from "@gl3/plugin-theft";` and append `theftPlugin` to the end of the `CORE_PLUGINS` array. Append, do not insert: manifest payload ordering in `plugin-manifest-endpoint.test.ts` follows this array.
7. There is no old `app.ts` registration to delete — `theft` is new, not a port.
8. `Dockerfile.server` — five COPY lines, mirroring `bullets` at lines 57, 91, 92, 151, 176:

```dockerfile
COPY packages/plugins/theft/package.json packages/plugins/theft/
COPY packages/plugins/theft/tsconfig.json packages/plugins/theft/tsconfig.json
COPY packages/plugins/theft/src packages/plugins/theft/src
COPY packages/plugins/theft/package.json packages/plugins/theft/
COPY --from=builder /app/packages/plugins/theft/dist packages/plugins/theft/dist
```

   Each goes beside the corresponding `bullets` line, in the same stage.

- [ ] **Step 9: Write the failing tiers/migrations test**

`apps/server/test/theft-tiers.test.ts`:

```ts
import theftPlugin from "@gl3/plugin-theft";
import { uuidv7 } from "uuidv7";
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { runPluginMigrations } from "../src/plugins/migrate.js";
import { testDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
afterAll(async () => { await conn.end(); });

describe("theft migrations", () => {
  it("creates all three owned tables and the garage index", async () => {
    await runPluginMigrations(db, [theftPlugin]);

    const tables = await db.execute(sql`
      SELECT tablename FROM pg_tables
      WHERE tablename IN ('p_theft_cars', 'p_theft_tiers', 'p_theft_garage')
      ORDER BY tablename`);
    expect(tables.map((r) => r.tablename)).toEqual(["p_theft_cars", "p_theft_garage", "p_theft_tiers"]);

    const idx = await db.execute(sql`
      SELECT indexname FROM pg_indexes WHERE indexname = 'p_theft_garage_player_idx'`);
    expect(idx).toHaveLength(1);
  });
});

describe("GET /api/theft/tiers", () => {
  it("lists tiers with their car counts and does not spend the cooldown", async () => {
    const server = await bootTestServer();
    try {
      const { db: sdb } = server;
      const cheapId = uuidv7();
      await sdb.execute(sql`
        INSERT INTO p_theft_cars (id, name, value, theft_weight)
        VALUES (${cheapId}, 'Beater', 1000, 3)`);
      const tierId = uuidv7();
      await sdb.execute(sql`
        INSERT INTO p_theft_tiers (id, name, success_chance, max_damage, min_car_value, max_car_value)
        VALUES (${tierId}, 'Backstreet', 60, 20, 500, 5000)`);

      const player = await server.registerPlayer();

      const first = await server.get("/api/theft/tiers", player);
      expect(first.statusCode).toBe(200);
      const row = first.json().rows.find((r: { id: string }) => r.id === tierId);
      expect(row).toMatchObject({ name: "Backstreet", cars: "1", cooldownRemaining: "0" });

      // Listing is not an action: a second call still reports no cooldown.
      const second = await server.get("/api/theft/tiers", player);
      expect(second.json().rows.find((r: { id: string }) => r.id === tierId).cooldownRemaining).toBe("0");
    } finally {
      await server.close();
    }
  });
});
```

Adapt the `bootTestServer` helper calls to this repo's actual helper surface — read `apps/server/test/helpers/server.ts` first and use whatever it really exports for booting, registering a player, and issuing an authenticated GET. Do not invent helper methods; the shape above is illustrative of the assertions, not of the helper API.

- [ ] **Step 10: Run the test to verify it fails, then passes**

Run: `npx vitest run apps/server/test/theft-tiers.test.ts apps/server/test/theft-settings.test.ts`
Expected first: FAIL (no tables / no route). After Steps 6-8: PASS.

- [ ] **Step 11: Prove the registration**

```bash
grep -c "packages/plugins/theft" Dockerfile.server   # must print 5
npx tsc --build --force apps/server/tsconfig.json    # the exact command the image build runs
```

Both must succeed. `npm run typecheck` passing is not evidence for the second.

- [ ] **Step 12: Commit**

```bash
git add packages/plugins/theft apps/server/package.json apps/server/tsconfig.json tsconfig.json \
        vitest.workspace.ts apps/server/src/plugins/core-plugins.ts Dockerfile.server \
        apps/server/test/theft-settings.test.ts apps/server/test/theft-tiers.test.ts package-lock.json
git commit -m "feat(theft): add the theft plugin with its three tables and settings"
```

---

### Task 2: Core relinquishes the car tables; `apps/migrate` retargets

Core drops `cars`, `theft_tiers` and `garage`; the migrator writes the plugin-owned names instead. Nothing about the migrator's SQL, id-map resolution or report counters changes — only the drizzle table objects it writes through.

**Files:**
- Create: `apps/server/drizzle/0009_relinquish_car_tables.sql`
- Modify: `apps/server/drizzle/meta/_journal.json`
- Modify: `apps/server/src/db/schema/content.ts` (remove `cars`, `theftTiers`), `apps/server/src/db/schema/economy.ts` (remove `garage`)
- Modify: `apps/server/test/schema.test.ts:30-31` (drop the three names)
- Modify: `apps/migrate/src/pg/plugin-tables.ts` (add three mirrors)
- Modify: `apps/migrate/src/migrators/cars.ts`, `apps/migrate/src/migrators/inventory.ts` (import source only)
- Modify: `apps/migrate/package.json`, `apps/migrate/tsconfig.json` (depend on `@gl3/plugin-theft`)
- Modify: `apps/migrate/test/helpers/fixtures.ts` (run theft's migrations in `createIsolatedPgTarget`)
- Test: `apps/migrate/test/migrators/cars.test.ts`, `apps/migrate/test/migrators/inventory.test.ts`, `apps/migrate/test/orchestrator-idempotency.test.ts` (import source only)

**Interfaces:**
- Consumes: `theftPlugin`, `THEFT_MIGRATIONS` from Task 1.
- Produces: `cars`, `theftTiers`, `garage` exported from `apps/migrate/src/pg/plugin-tables.ts`.

- [ ] **Step 1: Write the core migration**

`apps/server/drizzle/0009_relinquish_car_tables.sql`:

```sql
-- Core relinquishes three more tables it never touched.
--
-- `cars`, `theft_tiers` and `garage` shipped in 0000_core_schema because the
-- core schema predated the plugin migration runner — not because core code
-- ever read or wrote them. The single consumer of all three is the `theft`
-- plugin, which now owns and creates them as p_theft_cars / p_theft_tiers /
-- p_theft_garage. This is 0007_relinquish_plugin_tables applied to the next
-- three tables that qualify.
--
-- DROP, not RENAME, for the reason 0007 gives: a rename would leave the
-- plugin migrations doing CREATE TABLE IF NOT EXISTS, weaker than the plain
-- CREATE every other p_-prefixed table uses and weaker than the 42P07 that
-- plugin-migrate.test.ts relies on to prove a migration ran once.
--
-- Ordering: core migrations run to completion before loadPlugins calls
-- runPluginMigrations, so on a fresh database 0000 creates these, this drops
-- them, and the plugin recreates them under its own names — all in one boot.
--
-- `garage` is dropped FIRST because it holds the FKs to the other two;
-- CASCADE would handle it either way, but the explicit order documents that
-- the dependency was considered rather than delegated.
DROP TABLE IF EXISTS "garage" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "theft_tiers" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "cars" CASCADE;
```

- [ ] **Step 2: Add the journal entry**

Append to `entries` in `apps/server/drizzle/meta/_journal.json`, after the `0008_sentence_expiry_indexes` entry. Use a `when` value larger than `1786744364641`:

```json
  {
   "idx": 9,
   "version": "7",
   "when": 1786830000000,
   "tag": "0009_relinquish_car_tables",
   "breakpoints": true
  }
```

No snapshot file. `0005` and `0006` are hand-written migrations with no `meta/000N_snapshot.json` and this follows them; drizzle-kit is not being used to generate this migration.

- [ ] **Step 3: Remove the three tables from the core schema**

Delete the `cars` and `theftTiers` `pgTable` declarations from `apps/server/src/db/schema/content.ts` and the `garage` declaration from `apps/server/src/db/schema/economy.ts`, along with any now-unused imports. Remove `"cars"`, `"theft_tiers"` and `"garage"` from the expected-table list at `apps/server/test/schema.test.ts:30-31`.

- [ ] **Step 4: Add the mirrors to `apps/migrate`**

Append to `apps/migrate/src/pg/plugin-tables.ts`, matching the file's existing comment style and its stated rule that FKs are omitted because nothing here generates DDL:

```ts
/** Mirrors `packages/plugins/theft/src/migrations.ts` `0001_cars`. */
export const cars = pgTable("p_theft_cars", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  value: bigint("value", { mode: "bigint" }).notNull(),
  theftWeight: integer("theft_weight").notNull().default(1),
});

/** Mirrors `packages/plugins/theft/src/migrations.ts` `0002_tiers`. */
export const theftTiers = pgTable("p_theft_tiers", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  successChance: integer("success_chance").notNull(),
  maxDamage: integer("max_damage").notNull(),
  minCarValue: bigint("min_car_value", { mode: "bigint" }).notNull(),
  maxCarValue: bigint("max_car_value", { mode: "bigint" }).notNull(),
});

/** Mirrors `packages/plugins/theft/src/migrations.ts` `0003_garage`. */
export const garage = pgTable("p_theft_garage", {
  id: uuid("id").primaryKey(),
  playerId: uuid("player_id").notNull(),
  carId: uuid("car_id").notNull(),
  damage: integer("damage").notNull().default(0),
  locationId: uuid("location_id"),
});
```

Add `text` to the file's `drizzle-orm/pg-core` import list.

- [ ] **Step 5: Retarget the migrators and the fixture**

In `apps/migrate/src/migrators/cars.ts`, change

```ts
import { cars, theftTiers } from "../../../server/src/db/schema/index.js";
```

to

```ts
import { cars, theftTiers } from "../pg/plugin-tables.js";
```

In `apps/migrate/src/migrators/inventory.ts`, move `garage` out of the core-schema import and into a `../pg/plugin-tables.js` import, leaving `playerItems` where it is. **Nothing else in either file changes** — not the SQL, not `getOrCreateV3Id`, not `bumpTable`.

In `apps/migrate/test/helpers/fixtures.ts`, add `import theftPlugin from "@gl3/plugin-theft";` and extend the call to

```ts
    await runPluginMigrations(pluginDb.db, [bountiesPlugin, detectivesPlugin, theftPlugin]);
```

updating the "two plugin-owned target tables" comment to five.

Add `"@gl3/plugin-theft": "*"` to `apps/migrate/package.json` dependencies and `{ "path": "../../packages/plugins/theft" }` to `apps/migrate/tsconfig.json` references, then `npm install`.

- [ ] **Step 6: Retarget the migrate tests**

In `apps/migrate/test/migrators/cars.test.ts` and `apps/migrate/test/migrators/inventory.test.ts`, change the imports of `cars` / `theftTiers` / `garage` from `../../../server/src/db/schema/index.js` to `../../src/pg/plugin-tables.js`. Do the same in `apps/migrate/test/orchestrator-idempotency.test.ts` and `apps/migrate/test/orchestrator.test.ts`. **The assertions do not change** — the three-run idempotency test keeps all 26 table entries; three of them are now plugin tables.

- [ ] **Step 7: Run the affected suites**

```bash
npx vitest run apps/server/test/schema.test.ts apps/server/test/theft-tiers.test.ts
npx vitest run --project '@gl3/migrate'
```

`apps/migrate` needs `MYSQL_ADMIN_URL` exported alongside `DATABASE_URL` and `REDIS_URL`; without it its 25 files fail as a block on a missing env var, which reads like real failures and is not.

Expected: PASS. Confirm the idempotency test still reports 26 tables.

- [ ] **Step 8: Commit**

```bash
git add apps/server/drizzle apps/server/src/db/schema apps/server/test/schema.test.ts \
        apps/migrate package-lock.json
git commit -m "refactor(db): relinquish cars, theft_tiers and garage to the theft plugin"
```

---

### Task 3: The pure theft resolver

No database, no randomness, no clock. Every roll arrives as an argument, which is what makes the outcome table testable in the `@gl3/server:unit` project.

**Files:**
- Create: `packages/plugins/theft/src/resolve.ts`
- Test: `apps/server/test/theft-resolve.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface CatalogueCar { id: string; name: string; value: bigint; theftWeight: number }
  export interface TheftTier {
    id: string; name: string; successChance: number; maxDamage: number;
    minCarValue: bigint; maxCarValue: bigint;
  }
  export interface TheftRolls {
    successRoll: number; carRoll: number; damageRoll: number; escapeRoll: number;
  }
  export type TheftOutcome =
    | { kind: "stolen"; car: CatalogueCar; damage: number }
    | { kind: "escaped" }
    | { kind: "caught" }
    | { kind: "empty" };
  export function bracketWeight(tier: TheftTier, candidates: readonly CatalogueCar[]): number;
  export function resolveTheft(
    rolls: TheftRolls, tier: TheftTier, candidates: readonly CatalogueCar[], escapeChance: number,
  ): TheftOutcome;
  ```
- Consumed by: Task 4's steal route.

- [ ] **Step 1: Write the failing test**

`apps/server/test/theft-resolve.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { bracketWeight, resolveTheft, type CatalogueCar, type TheftRolls, type TheftTier }
  from "@gl3/plugin-theft/resolve";

const car = (name: string, value: bigint, theftWeight: number): CatalogueCar =>
  ({ id: `id-${name}`, name, value, theftWeight });

const TIER: TheftTier = {
  id: "t", name: "Backstreet", successChance: 60, maxDamage: 20,
  minCarValue: 1000n, maxCarValue: 5000n,
};

const rolls = (over: Partial<TheftRolls> = {}): TheftRolls =>
  ({ successRoll: 0, carRoll: 0, damageRoll: 0, escapeRoll: 0, ...over });

const BEATER = car("Beater", 1000n, 1);
const SEDAN = car("Sedan", 3000n, 4);
const SUPERCAR = car("Supercar", 90000n, 1);
const CATALOGUE = [BEATER, SEDAN, SUPERCAR];

describe("bracketWeight", () => {
  it("sums the weights of cars inside the tier's value bracket only", () => {
    expect(bracketWeight(TIER, CATALOGUE)).toBe(5); // Supercar is out of bracket
  });

  it("counts a car sitting exactly on either bound", () => {
    const edges = [car("Low", 1000n, 2), car("High", 5000n, 3)];
    expect(bracketWeight(TIER, edges)).toBe(5);
  });

  it("is zero when the bracket is empty", () => {
    expect(bracketWeight(TIER, [SUPERCAR])).toBe(0);
  });

  it("ignores a negative weight rather than subtracting it", () => {
    // theft_weight is admin-edited. A negative value must not shrink the
    // draw space, which would make the weighted scan skip real cars.
    expect(bracketWeight(TIER, [BEATER, car("Bad", 2000n, -10)])).toBe(1);
  });
});

describe("resolveTheft", () => {
  it("succeeds when successRoll is below the tier's chance", () => {
    const out = resolveTheft(rolls({ successRoll: 59 }), TIER, CATALOGUE, 40);
    expect(out.kind).toBe("stolen");
  });

  it("fails when successRoll equals the tier's chance", () => {
    // The boundary is `<`, so a 60% tier fails on exactly 60 out of 0..99.
    expect(resolveTheft(rolls({ successRoll: 60 }), TIER, CATALOGUE, 40).kind).not.toBe("stolen");
  });

  it("never succeeds at successChance 0 and always succeeds at 100", () => {
    const never = { ...TIER, successChance: 0 };
    const always = { ...TIER, successChance: 100 };
    expect(resolveTheft(rolls({ successRoll: 0 }), never, CATALOGUE, 0).kind).toBe("caught");
    expect(resolveTheft(rolls({ successRoll: 99 }), always, CATALOGUE, 0).kind).toBe("stolen");
  });

  it("draws the car by weight, in catalogue order", () => {
    // Beater has weight 1 and Sedan 4, so rolls 0 -> Beater and 1..4 -> Sedan.
    const pick = (carRoll: number) => {
      const out = resolveTheft(rolls({ successRoll: 0, carRoll }), TIER, CATALOGUE, 40);
      if (out.kind !== "stolen") throw new Error(`expected stolen, got ${out.kind}`);
      return out.car.name;
    };
    expect(pick(0)).toBe("Beater");
    expect(pick(1)).toBe("Sedan");
    expect(pick(4)).toBe("Sedan");
  });

  it("never draws a car outside the bracket", () => {
    for (let carRoll = 0; carRoll < 5; carRoll += 1) {
      const out = resolveTheft(rolls({ successRoll: 0, carRoll }), TIER, CATALOGUE, 40);
      if (out.kind !== "stolen") throw new Error("expected stolen");
      expect(out.car.name).not.toBe("Supercar");
    }
  });

  it("reports an empty bracket rather than throwing or picking nothing", () => {
    expect(resolveTheft(rolls({ successRoll: 0 }), TIER, [SUPERCAR], 40).kind).toBe("empty");
  });

  it("stays total when carRoll lands past the total weight", () => {
    // Defensive: a caller that drew against a stale weight must still get a
    // car, not undefined.
    const out = resolveTheft(rolls({ successRoll: 0, carRoll: 999 }), TIER, CATALOGUE, 40);
    expect(out.kind).toBe("stolen");
  });

  it("passes the damage roll through and clamps it to the tier's maximum", () => {
    const at = (damageRoll: number) => {
      const out = resolveTheft(rolls({ successRoll: 0, damageRoll }), TIER, CATALOGUE, 40);
      if (out.kind !== "stolen") throw new Error("expected stolen");
      return out.damage;
    };
    expect(at(7)).toBe(7);
    expect(at(999)).toBe(20);
    expect(at(-3)).toBe(0);
  });

  it("yields a pristine car for a tier whose maxDamage is 0", () => {
    const pristine = { ...TIER, maxDamage: 0 };
    const out = resolveTheft(rolls({ successRoll: 0, damageRoll: 0 }), pristine, CATALOGUE, 40);
    if (out.kind !== "stolen") throw new Error("expected stolen");
    expect(out.damage).toBe(0);
  });

  it("escapes when escapeRoll is below the escape chance, and is caught otherwise", () => {
    const failed = rolls({ successRoll: 99 });
    expect(resolveTheft({ ...failed, escapeRoll: 39 }, TIER, CATALOGUE, 40).kind).toBe("escaped");
    expect(resolveTheft({ ...failed, escapeRoll: 40 }, TIER, CATALOGUE, 40).kind).toBe("caught");
  });

  it("never escapes at chance 0 and always escapes at 100", () => {
    const failed = rolls({ successRoll: 99 });
    expect(resolveTheft({ ...failed, escapeRoll: 0 }, TIER, CATALOGUE, 0).kind).toBe("caught");
    expect(resolveTheft({ ...failed, escapeRoll: 99 }, TIER, CATALOGUE, 100).kind).toBe("escaped");
  });

  it("runs the chase even when the bracket is empty", () => {
    // An empty bracket is only reachable on the SUCCESS branch; a failed
    // theft is a chase regardless of what was on the street.
    expect(resolveTheft(rolls({ successRoll: 99, escapeRoll: 0 }), TIER, [], 40).kind).toBe("escaped");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project '@gl3/server:unit' apps/server/test/theft-resolve.test.ts`
Expected: FAIL — `@gl3/plugin-theft/resolve` has no `resolveTheft`.

- [ ] **Step 3: Write the resolver**

`packages/plugins/theft/src/resolve.ts`:

```ts
export interface CatalogueCar {
  id: string;
  name: string;
  value: bigint;
  theftWeight: number;
}

export interface TheftTier {
  id: string;
  name: string;
  successChance: number;
  maxDamage: number;
  minCarValue: bigint;
  maxCarValue: bigint;
}

/**
 * Every roll the outcome depends on, drawn by the caller with
 * `randomInt` from `node:crypto` and handed in. Keeping randomness out of
 * here is what makes the whole outcome table testable without a database —
 * the shape `packages/plugins/combat/src/resolve.ts` established.
 *
 * `successRoll` and `escapeRoll` are drawn over [0, 100). `carRoll` is drawn
 * over [0, bracketWeight(...)), which is why `bracketWeight` is exported:
 * the caller needs the bound before it can draw, and duplicating the filter
 * to compute it would be two definitions of the bracket.
 */
export interface TheftRolls {
  successRoll: number;
  carRoll: number;
  damageRoll: number;
  escapeRoll: number;
}

export type TheftOutcome =
  | { kind: "stolen"; car: CatalogueCar; damage: number }
  | { kind: "escaped" }
  | { kind: "caught" }
  | { kind: "empty" };

/** A negative weight is clamped, not subtracted: `theft_weight` is admin-edited. */
const weightOf = (car: CatalogueCar): number => Math.max(0, Math.floor(car.theftWeight));

function inBracket(tier: TheftTier, candidates: readonly CatalogueCar[]): CatalogueCar[] {
  return candidates.filter((c) => c.value >= tier.minCarValue && c.value <= tier.maxCarValue);
}

export function bracketWeight(tier: TheftTier, candidates: readonly CatalogueCar[]): number {
  return inBracket(tier, candidates).reduce((sum, c) => sum + weightOf(c), 0);
}

export function resolveTheft(
  rolls: TheftRolls,
  tier: TheftTier,
  candidates: readonly CatalogueCar[],
  escapeChance: number,
): TheftOutcome {
  // The chase comes first because it is the only branch that does not care
  // what was parked on the street.
  if (rolls.successRoll >= tier.successChance) {
    return rolls.escapeRoll < escapeChance ? { kind: "escaped" } : { kind: "caught" };
  }

  const pool = inBracket(tier, candidates);
  const total = pool.reduce((sum, c) => sum + weightOf(c), 0);
  if (pool.length === 0 || total <= 0) return { kind: "empty" };

  const damage = Math.min(Math.max(0, Math.floor(rolls.damageRoll)), tier.maxDamage);

  let acc = 0;
  for (const car of pool) {
    acc += weightOf(car);
    if (rolls.carRoll < acc) return { kind: "stolen", car, damage };
  }

  // Unreachable for a roll drawn over [0, total). Kept so the function is
  // total: a caller that drew against a stale weight gets a car, not
  // undefined threaded into an insert.
  const last = pool[pool.length - 1];
  if (last === undefined) return { kind: "empty" };
  return { kind: "stolen", car: last, damage };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --project '@gl3/server:unit' apps/server/test/theft-resolve.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/theft/src/resolve.ts apps/server/test/theft-resolve.test.ts
git commit -m "feat(theft): add the pure theft outcome resolver"
```

---

### Task 4: Stealing a car, and the police chase

The steal route, its cooldown discipline, the location-first lock order, and both events.

**Files:**
- Modify: `packages/plugins/theft/src/index.ts`
- Test: `apps/server/test/theft-routes.test.ts`, `apps/server/test/theft-chase.test.ts`

**Interfaces:**
- Consumes: `resolveTheft`, `bracketWeight`, `TheftRolls` (Task 3); `readTheftSettings` (Task 1); `cars`, `theftTiers`, `garage`, `playerStats` (Task 1).
- Produces: `POST /api/theft/steal` with body `{ tierId: string (uuid) }`; the manifest events `resolved` and `sold` (the latter is declared here, published in Task 5).

- [ ] **Step 1: Write the failing route tests**

`apps/server/test/theft-routes.test.ts` — end-to-end success path. Read `apps/server/test/helpers/server.ts` and `apps/server/test/helpers/events.ts` first and use their real surfaces; in particular use `awaitOwnEvent()` for every event assertion, filtered on this test's own `actorId` (CLAUDE.md rule 4 — `game:events` is global across test files and five files have already shipped this bug).

Cases this file must prove:

1. **A successful steal parks the car at the caller's current location.** Seed a tier with `success_chance: 100` and `max_damage: 0`, one car in bracket, boot, steal, assert `201`, assert exactly one `p_theft_garage` row for the player with `location_id` equal to the player's `player_stats.location_id` and `damage: 0`.
2. **The cooldown is claimed.** A second immediate steal returns `429` with a `retry-after` header, and `GET /api/theft/tiers` then reports a non-zero `cooldownRemaining`.
3. **An unknown `tierId` is `404` and costs nothing.** Post a well-formed but absent uuid, assert `404`, then assert a real steal immediately afterwards still succeeds — the cooldown was never claimed.
4. **A malformed `tierId` is `400`, not `500`.** Post `{ tierId: "not-a-uuid" }`. The zod body schema is what produces the clean 400; an unvalidated value would reach Postgres.
5. **An empty bracket is `409 no_cars_in_tier` and does not spend the cooldown.** Seed a tier whose bracket contains no car; assert `409` with that code, then assert a steal against a populated tier immediately afterwards succeeds.
6. **A jailed player cannot steal.** `accessInJail: false` — assert the loader's jail rejection, matching how other `accessInJail: false` routes are asserted elsewhere in the suite.
7. **The garage row survives.** After a successful steal, `GET /api/garage` (Task 5) is not yet available; assert directly against the table instead, and leave the route assertion to Task 5.

`apps/server/test/theft-chase.test.ts` — the failure branches, both driven by settings rather than by luck:

1. **Escape.** `theft.chase.escape_chance = 100`, tier `success_chance: 0`. Assert `200`, no garage row, and that the player is **not** jailed. Assert exactly one own-event, `plugin.event` with `pluginId: "theft"`, `name: "resolved"`, whose payload `outcome` says the player got away.
2. **Capture.** `theft.chase.escape_chance = 0`, `theft.chase.jail_seconds = 600`, tier `success_chance: 0`. Assert `200`, no garage row, the player's jail deadline is roughly 600 seconds out, and **two** own-events arrive in this order: the `plugin.event` `theft.resolved` first, then the core `player.jailed`. Order is the assertion — the module's own outcome first, the state change second, which is the ordering `game/crimes/worker.ts` established and which `tx.events`' single buffer preserves.
3. **Nothing publishes on rollback.** Not a separate test here — it is already proven for the buffer in `plugin-ctx-core-events.test.ts`.

Both files drive the plugin through `bootTestServer()`, so they do **not** need their own `runPluginMigrations` call. Set the settings rows by inserting into core's `settings` table with the **prefixed** key (`theft.chase.escape_chance`) — the prefix is added on the read side, so the stored rows carry it.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run apps/server/test/theft-routes.test.ts apps/server/test/theft-chase.test.ts`
Expected: FAIL — `POST /api/theft/steal` is not registered (404 from the loader).

- [ ] **Step 3: Write the steal route**

Add to `packages/plugins/theft/src/index.ts`:

```ts
import { randomInt } from "node:crypto";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { bracketWeight, resolveTheft, type CatalogueCar, type TheftTier } from "./resolve.js";

const stealRoute = route({
  method: "POST",
  path: "/api/theft/steal",
  accessInJail: false,
  accessInHospital: true,
  body: z.object({ tierId: z.string().uuid() }),
  handler: async (ctx, { body }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    const config = readTheftSettings((key) => ctx.settings.get(key));

    // Look the tier up and check the bracket BEFORE claiming the cooldown, so
    // a bad id or an empty catalogue costs the player nothing — the ordering
    // `packages/plugins/crimes/src/index.ts` established. Both reads are
    // unlocked; the authoritative reads happen under the locks below.
    const [tier] = await ctx.transaction(async (tx) =>
      await tx.db.select().from(theftTiers).where(eq(theftTiers.id, body.tierId)));
    if (tier === undefined) throw new PluginError("tier_not_found", 404);

    const [precount] = await ctx.transaction(async (tx) =>
      await tx.db
        .select({ n: sql<number>`count(*)::int` })
        .from(cars)
        .where(and(gte(cars.value, tier.minCarValue), lte(cars.value, tier.maxCarValue))));
    if ((precount?.n ?? 0) === 0) throw new PluginError("no_cars_in_tier", 409);

    // Redis SET NX EX inside the SDK, so rule 2 is satisfied structurally.
    const claimed = await ctx.cooldown.acquire("theft", player.id, config.cooldownSeconds);
    if (!claimed) {
      const retryAfter = await ctx.cooldown.peek("theft", player.id);
      throw new PluginError("cooldown_active", 429, { retryAfter });
    }

    try {
      return await ctx.transaction(async (tx) => {
        // Where the car will be parked has to be READ before it can be
        // locked, so this read is unlocked and is re-checked below.
        const [before] = await tx.db
          .select({ locationId: playerStats.locationId })
          .from(playerStats)
          .where(eq(playerStats.playerId, player.id));
        if (before?.locationId == null) throw new PluginError("no_location", 409);

        // RULE 6, and the load-bearing line of this plugin. Inserting a
        // p_theft_garage row reaches `locations` implicitly through
        // location_id's FK (FOR KEY SHARE). Locking the player first and
        // arriving at the location afterwards is the shipped travel deadlock
        // exactly — bullets locks location->player, so the inverse order
        // deadlocks against it under load. Location first, then the player.
        await tx.locks.location(before.locationId);
        await tx.locks.player([player.id]);

        // Lock-then-recheck (TOCTOU): a player who travelled between the
        // unlocked read and the lock must not park a car in the city they
        // left.
        const [after] = await tx.db
          .select({ locationId: playerStats.locationId })
          .from(playerStats)
          .where(eq(playerStats.playerId, player.id));
        if (after?.locationId !== before.locationId) throw new PluginError("wrong_location", 409);
        const locationId = after.locationId;

        const catalogue: CatalogueCar[] = await tx.db
          .select({ id: cars.id, name: cars.name, value: cars.value, theftWeight: cars.theftWeight })
          .from(cars);
        const tierRow: TheftTier = tier;
        const total = bracketWeight(tierRow, catalogue);

        const outcome = resolveTheft({
          successRoll: randomInt(0, 100),
          // `randomInt(n, n)` throws, so the zero-weight case never draws —
          // resolveTheft answers `empty` from the same fact.
          carRoll: total > 0 ? randomInt(0, total) : 0,
          // maxDamage 0 -> randomInt(0, 1) -> 0. Pristine, and no throw.
          damageRoll: randomInt(0, tierRow.maxDamage + 1),
          escapeRoll: randomInt(0, 100),
        }, tierRow, catalogue, config.chase.escapeChance);

        if (outcome.kind === "empty") throw new PluginError("no_cars_in_tier", 409);

        if (outcome.kind === "stolen") {
          await tx.db.insert(garage).values({
            id: uuidv7(),
            playerId: player.id,
            carId: outcome.car.id,
            damage: outcome.damage,
            locationId,
          });
          await tx.events.publish({
            name: "resolved",
            actorId: player.id,
            actorName: player.username,
            audience: { kind: "global" },
            payload: {
              outcome: `stole a ${outcome.car.name}`,
              carName: outcome.car.name,
              success: "true",
            },
          });
          return {
            status: 201,
            body: { outcome: "stolen", car: outcome.car.name, damage: outcome.damage },
          };
        }

        const escaped = outcome.kind === "escaped";
        // The module's own outcome first, the state change second — the
        // crimes ordering, preserved by tx.events' single buffer.
        await tx.events.publish({
          name: "resolved",
          actorId: player.id,
          actorName: player.username,
          audience: { kind: "global" },
          payload: {
            outcome: escaped ? "was spotted lifting a car and got away" : "was caught lifting a car",
            carName: "",
            success: "false",
          },
        });

        if (escaped) return { status: 200, body: { outcome: "escaped" } };

        const until = await tx.jail.sendToJail(player.id, config.chase.jailSeconds);
        await tx.events.publishCore({
          type: "player.jailed",
          actorId: player.id,
          actorName: player.username,
          audience: { kind: "global" },
          until: until.toISOString(),
          reason: "caught stealing a car",
        });
        return { status: 200, body: { outcome: "caught", until: until.toISOString() } };
      });
    } catch (err) {
      // The action did not happen, so the player must not pay for it.
      await ctx.cooldown.release("theft", player.id);
      throw err;
    }
  },
});
```

Declare both events in the manifest and register the route:

```ts
const resolvedEvent = {
  name: "resolved",
  payload: z.object({ outcome: z.string(), carName: z.string(), success: z.string() }),
  // One template, not the design doc's two: a manifest event declares a
  // single `describe`, so the phrasing lives in the payload.
  describe: "{actorName} {outcome}",
  invalidates: ["theft", "garage", "me"],
};

const soldEvent = {
  name: "sold",
  payload: z.object({ carName: z.string(), payout: z.string() }),
  describe: "{actorName} sold a {carName} for {payout}",
  invalidates: ["garage", "me"],
};
```

with `routes: [tiersRoute, stealRoute]` and `events: [resolvedEvent, soldEvent]`.

Check `PluginError`'s real constructor before using the third argument above. If it takes no options bag, set the `retry-after` header the way the crimes plugin's 429 does — read `packages/plugins/crimes/src/index.ts:87` and copy that mechanism exactly rather than inventing one.

`tx.jail.sendToJail` takes the player lock itself, in the same order as `economy.applyBalanceChange`, so no extra lock call is needed for the jailing.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run apps/server/test/theft-routes.test.ts apps/server/test/theft-chase.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/theft/src/index.ts \
        apps/server/test/theft-routes.test.ts apps/server/test/theft-chase.test.ts
git commit -m "feat(theft): steal a car by tier, with the police chase on failure"
```

---

### Task 5: The garage — list, sell, repair

**Files:**
- Modify: `packages/plugins/theft/src/index.ts`
- Test: `apps/server/test/garage.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1 and 4.
- Produces: `GET /api/garage`, `POST /api/garage/sell` body `{ garageId: string (uuid) }`, `POST /api/garage/repair` body `{ garageId: string (uuid) }`.

- [ ] **Step 1: Write the failing tests**

`apps/server/test/garage.test.ts`, through `bootTestServer()`. Cases:

1. **`GET /api/garage` shapes a `TableRowsResponse`.** Seed a car and a garage row for the caller; assert `rows[0]` carries `id`, `carName`, `damage`, `locationName`, `saleValue`, `repairCost` and a `here` flag, all strings, and that the response has no other top-level key than `rows`.
2. **Sell pays value scaled by damage, truncating toward the house.** Car value `10001`, damage `10` → `10001n * 90n / 100n = 9000n` (not 9000.9). Assert the cash delta is exactly `9000`, that one ledger row exists with reason `theft.sell`, and that the garage row is gone.
3. **Sell of an undamaged car pays the full value.** Damage `0` → payout equals the car's value exactly.
4. **Sell from the wrong city is `409 wrong_location`,** the garage row survives, and no ledger row is written.
5. **Repair restores damage to 0 and charges `cost_per_point * damage`.** With `theft.repair.cost_per_point = 500` and damage `10`, assert a `5000` debit, reason `theft.repair`, and `damage = 0` afterwards.
6. **Repairing a pristine car is `204`,** writes no ledger row, and leaves the row untouched. A no-op is not a mistake; charging for it or 4xx-ing it both punish a double click.
7. **Repair with insufficient cash is `409 insufficient_funds`,** with no debit and no damage change.
8. **Repair from the wrong city is `409 wrong_location`.**
9. **Neither route touches another player's car.** Post a garage id belonging to a second player; assert `404`, not `403` — the row is not the caller's to know about.
10. **`theft.sold` publishes after a sell** and carries the payout as a decimal string. Use `awaitOwnEvent()`.

`sum(ledger) == balance` is enforced globally by `economy-invariant.test.ts`; nothing here needs to re-assert it, but every money movement must go through `tx.economy.applyBalanceChange` for that test to keep passing.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run apps/server/test/garage.test.ts`
Expected: FAIL — the three routes are not registered.

- [ ] **Step 3: Write the garage routes**

Add to `packages/plugins/theft/src/index.ts`. All three share one shape: read the garage row joined to its car and its location, check ownership, then — for the two mutating routes — lock the location before the player and re-read.

```ts
const listGarageRoute = route({
  method: "GET",
  path: "/api/garage",
  accessInJail: true,
  accessInHospital: true,
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    const config = readTheftSettings((key) => ctx.settings.get(key));

    return ctx.transaction(async (tx) => {
      const [me] = await tx.db
        .select({ locationId: playerStats.locationId })
        .from(playerStats)
        .where(eq(playerStats.playerId, player.id));

      const owned = await tx.db
        .select({
          id: garage.id,
          damage: garage.damage,
          locationId: garage.locationId,
          carName: cars.name,
          carValue: cars.value,
          locationName: locations.name,
        })
        .from(garage)
        .innerJoin(cars, eq(cars.id, garage.carId))
        .leftJoin(locations, eq(locations.id, garage.locationId))
        .where(eq(garage.playerId, player.id));

      return {
        status: 200,
        body: {
          rows: owned.map((row) => ({
            // `id` is the select's valueKey and is never rendered as a
            // column — the rule test/admin-ids-hidden.test.ts enforces on the
            // admin side, kept here for the same reason.
            id: row.id,
            carName: row.carName,
            damage: String(row.damage),
            locationName: row.locationName ?? "Unknown",
            saleValue: saleValueOf(row.carValue, row.damage).toString(),
            repairCost: (config.repair.costPerPoint * BigInt(row.damage)).toString(),
            here: row.locationId === me?.locationId ? "yes" : "no",
          })),
        },
      };
    });
  },
});

/**
 * bigint division truncates, which is the correct direction: the house keeps
 * the fraction. Shared by the list route and the sell route so the number a
 * player is shown is the number they are paid, by construction.
 */
function saleValueOf(value: bigint, damage: number): bigint {
  const intact = BigInt(Math.min(100, Math.max(0, damage)));
  return (value * (100n - intact)) / 100n;
}
```

The sell route:

```ts
const sellRoute = route({
  method: "POST",
  path: "/api/garage/sell",
  accessInJail: false,
  accessInHospital: true,
  body: z.object({ garageId: z.string().uuid() }),
  handler: async (ctx, { body }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      // Unlocked read, only to learn WHICH location to lock.
      const [before] = await tx.db
        .select({ locationId: garage.locationId })
        .from(garage)
        .where(and(eq(garage.id, body.garageId), eq(garage.playerId, player.id)));
      if (before?.locationId == null) throw new PluginError("car_not_found", 404);

      // Rule 6: the location first, then the player. Deleting the garage row
      // still touches locations through the FK.
      await tx.locks.location(before.locationId);
      await tx.locks.player([player.id]);

      // Lock-then-recheck.
      const [row] = await tx.db
        .select({
          id: garage.id, damage: garage.damage, locationId: garage.locationId,
          carName: cars.name, carValue: cars.value,
        })
        .from(garage)
        .innerJoin(cars, eq(cars.id, garage.carId))
        .where(and(eq(garage.id, body.garageId), eq(garage.playerId, player.id)));
      if (row === undefined) throw new PluginError("car_not_found", 404);

      const [me] = await tx.db
        .select({ locationId: playerStats.locationId })
        .from(playerStats)
        .where(eq(playerStats.playerId, player.id));
      if (me?.locationId !== row.locationId) throw new PluginError("wrong_location", 409);

      const payout = saleValueOf(row.carValue, row.damage);
      await tx.db.delete(garage).where(eq(garage.id, row.id));
      await tx.economy.applyBalanceChange({
        playerId: player.id, amount: payout, kind: "cash", reason: "theft.sell",
      });
      await tx.events.publish({
        name: "sold",
        actorId: player.id,
        actorName: player.username,
        audience: { kind: "player", playerId: player.id },
        payload: { carName: row.carName, payout: payout.toString() },
      });

      return { status: 200, body: { payout: payout.toString() } };
    });
  },
});
```

The repair route follows the same read → lock(location, player) → re-read → act shape, with:

```ts
      if (row.damage === 0) return { status: 204 };

      const cost = config.repair.costPerPoint * BigInt(row.damage);
      const [stats] = await tx.db
        .select({ cash: playerStats.cash })
        .from(playerStats)
        .where(eq(playerStats.playerId, player.id));
      // Checked under the lock, so the balance cannot move between the check
      // and the debit.
      if (stats === undefined || stats.cash < cost) {
        throw new PluginError("insufficient_funds", 409);
      }
      await tx.economy.applyBalanceChange({
        playerId: player.id, amount: -cost, kind: "cash", reason: "theft.repair",
      });
      await tx.db.update(garage).set({ damage: 0 }).where(eq(garage.id, row.id));
      return { status: 200, body: { cost: cost.toString() } };
```

The `204` check goes **after** the wrong-location check: a pristine car in another city is still the wrong city, and answering `204` there would tell the player their no-op succeeded.

Register all three in `routes`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run apps/server/test/garage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/theft/src/index.ts apps/server/test/garage.test.ts
git commit -m "feat(theft): list, sell and repair cars in the garage"
```

---

### Task 6: The lock-order regression test

The spec's load-bearing claim, proven — and proven capable of failing.

**Files:**
- Test: `apps/server/test/theft-lock-order.test.ts`

**Interfaces:**
- Consumes: `POST /api/theft/steal` (Task 4), plus the **real** bullets purchase route and the **real** travel route.

- [ ] **Step 1: Read the existing lock-order tests**

Read `apps/server/test/travel-lock-order.test.ts` and `apps/server/test/combat-lock-order.test.ts` and follow their structure. The CLAUDE.md corollary is the reason this task exists as its own gate: *a concurrency test whose participants all acquire locks via the same helper proves only the case that was already safe.* The pre-existing gang deadlock test agreed on ordering by construction and stayed green straight through a real bug.

- [ ] **Step 2: Write the test**

`apps/server/test/theft-lock-order.test.ts`. Requirements:

- Boot once with `bootTestServer()` so bullets, travel and theft are all live plugins.
- Seed: two locations (theft's city and a travel destination), bullet stock at theft's city, one car and one tier whose bracket contains it with `success_chance: 100`, and N players (at least 8) standing in theft's city with enough cash to buy bullets and travel.
- Set `theft.cooldown_seconds = 1` so a player can steal repeatedly within the run.
- Fire, concurrently and repeatedly (at least 20 rounds), an interleaving of: `POST /api/theft/steal`, the real bullets purchase route, and the real travel route — all against the same location rows.
- Assert **no** response is a 500 and that no error carries Postgres code `40P01` (`deadlock detected`). Business-level failures (`409 wrong_location` from a player who travelled, `429` from a cooldown) are expected and must be tolerated explicitly, not swallowed by a bare try/catch.
- Do not use a shared helper to drive the three routes' locking. The whole point is that bullets and travel take their locks through *their own* code paths.

- [ ] **Step 3: Prove the test can fail**

Temporarily invert theft's lock order in `packages/plugins/theft/src/index.ts` — swap the two lines so `tx.locks.player([player.id])` runs before `tx.locks.location(...)` in the steal route — and run the test.

Run: `npx vitest run apps/server/test/theft-lock-order.test.ts`
Expected: FAIL, with a deadlock (`40P01`) or a 500 arising from one.

**The task is not complete without this.** Paste the failing output verbatim into the task report. A green acceptance test that was never shown turning red proves nothing. If it stays green with the order inverted, the test is not exercising the contention it claims to — increase the player count, the round count, or the overlap, and try again.

- [ ] **Step 4: Restore the correct order and re-run**

Restore location-first, then run the test again.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/test/theft-lock-order.test.ts
git commit -m "test(theft): prove theft locks the location before the player"
```

---

### Task 7: The web pages and the admin page

Two declarative player pages plus one admin page, all through the manifest — the loader's page renderer, not hand-written React. `theft` is the first core plugin to declare `pages`, which is the point: keeping the UI in the manifest is what would make it installable from the registry without touching core.

**Files:**
- Create: `packages/plugins/theft/src/pages.ts`
- Modify: `packages/plugins/theft/src/index.ts` (admin routes + `pages`/`adminPages`/`menu`)
- Modify: `apps/server/test/plugin-manifest-endpoint.test.ts:93-111`
- Test: `apps/server/test/admin-theft.test.ts`

**Interfaces:**
- Consumes: the player routes from Tasks 4 and 5.
- Produces: `GET/POST /api/admin/theft/cars`, `POST /api/admin/theft/cars/update`, `GET/POST /api/admin/theft/tiers`, `POST /api/admin/theft/tiers/update` — all `auth: "admin"`.

- [ ] **Step 1: Write the pages**

`packages/plugins/theft/src/pages.ts`. A `view` is **static**: all data arrives through `table.source` (`GET` returning `TableRowsResponse`) and `select.optionsSource` (`GET` + `valueKey` + `labelKey`). Per-row action buttons are not expressible in the ten-kind vocabulary, hence select-then-submit — the shape the admin pages already use.

```ts
import type { PageSchema } from "@gl3/plugin-sdk";

export const theftPage: PageSchema = {
  id: "theft.index",
  path: "/theft",
  menu: { label: "Car theft", order: 40 },
  view: {
    kind: "panel",
    title: "Car theft",
    children: [
      { kind: "text", value: "Pick a tier. A better tier pays more and gets you caught more." },
      { kind: "table", source: "GET /api/theft/tiers", columns: [
        { key: "name", label: "Tier" },
        { key: "successChance", label: "Success %" },
        { key: "maxDamage", label: "Max damage" },
        { key: "minCarValue", label: "Min value" },
        { key: "maxCarValue", label: "Max value" },
        { key: "cars", label: "Cars" },
      ] },
      { kind: "form", action: "POST /api/theft/steal", submitLabel: "Steal a car", fields: [
        { name: "tierId", label: "Tier", type: "select",
          optionsSource: "GET /api/theft/tiers", valueKey: "id", labelKey: "name" },
      ] },
    ],
  },
};

export const garagePage: PageSchema = {
  id: "theft.garage",
  path: "/garage",
  menu: { label: "Garage", order: 41 },
  view: {
    kind: "panel",
    title: "Garage",
    children: [
      { kind: "text", value: "Cars stay in the city you stole them in. Sell or repair them there." },
      { kind: "table", source: "GET /api/garage", columns: [
        { key: "carName", label: "Car" },
        { key: "damage", label: "Damage" },
        { key: "locationName", label: "City" },
        { key: "saleValue", label: "Sells for" },
        { key: "repairCost", label: "Repair cost" },
        { key: "here", label: "In this city" },
      ] },
      { kind: "form", action: "POST /api/garage/sell", submitLabel: "Sell", fields: [
        { name: "garageId", label: "Car", type: "select",
          optionsSource: "GET /api/garage", valueKey: "id", labelKey: "carName" },
      ] },
      { kind: "form", action: "POST /api/garage/repair", submitLabel: "Repair", fields: [
        { name: "garageId", label: "Car", type: "select",
          optionsSource: "GET /api/garage", valueKey: "id", labelKey: "carName" },
      ] },
    ],
  },
};

export const adminPage: PageSchema = {
  id: "theft-admin",
  path: "/admin/theft",
  view: {
    kind: "panel",
    title: "Car theft",
    children: [
      { kind: "panel", title: "Cars", children: [
        { kind: "table", source: "GET /api/admin/theft/cars", columns: [
          { key: "name", label: "Name" },
          { key: "value", label: "Value" },
          { key: "theftWeight", label: "Weight" },
        ] },
        { kind: "form", action: "POST /api/admin/theft/cars", submitLabel: "Add car", fields: [
          { name: "name", label: "Name", type: "text" },
          { name: "value", label: "Value", type: "money" },
          { name: "theftWeight", label: "Theft weight", type: "number" },
        ] },
        { kind: "form", action: "POST /api/admin/theft/cars/update", submitLabel: "Update car", fields: [
          { name: "id", label: "Car", type: "select",
            optionsSource: "GET /api/admin/theft/cars", valueKey: "id", labelKey: "name" },
          { name: "name", label: "Rename to (optional)", type: "text" },
          { name: "value", label: "Value", type: "money" },
          { name: "theftWeight", label: "Theft weight", type: "number" },
        ] },
      ] },
      { kind: "panel", title: "Tiers", children: [
        { kind: "table", source: "GET /api/admin/theft/tiers", columns: [
          { key: "name", label: "Name" },
          { key: "successChance", label: "Success %" },
          { key: "maxDamage", label: "Max damage" },
          { key: "minCarValue", label: "Min value" },
          { key: "maxCarValue", label: "Max value" },
        ] },
        { kind: "form", action: "POST /api/admin/theft/tiers", submitLabel: "Add tier", fields: [
          { name: "name", label: "Name", type: "text" },
          { name: "successChance", label: "Success %", type: "number" },
          { name: "maxDamage", label: "Max damage", type: "number" },
          { name: "minCarValue", label: "Min value", type: "money" },
          { name: "maxCarValue", label: "Max value", type: "money" },
        ] },
        { kind: "form", action: "POST /api/admin/theft/tiers/update", submitLabel: "Update tier", fields: [
          { name: "id", label: "Tier", type: "select",
            optionsSource: "GET /api/admin/theft/tiers", valueKey: "id", labelKey: "name" },
          { name: "name", label: "Rename to (optional)", type: "text" },
          { name: "successChance", label: "Success %", type: "number" },
          { name: "maxDamage", label: "Max damage", type: "number" },
          { name: "minCarValue", label: "Min value", type: "money" },
          { name: "maxCarValue", label: "Max value", type: "money" },
        ] },
      ] },
    ],
  },
};
```

No UUID is rendered in any of the three: ids travel only as each `select`'s `valueKey`, which `apps/server/test/admin-ids-hidden.test.ts` enforces across every loaded plugin.

- [ ] **Step 2: Write the admin routes**

Six routes in `packages/plugins/theft/src/index.ts`, all with `auth: "admin"` (the loader enforces this for anything under `/api/admin/`, and refuses to boot otherwise). Follow `packages/plugins/inventory/src/index.ts`'s admin routes for the update semantics — a blank optional field keeps the current value.

The catalogue editor must keep the property the spec's §3 argument rests on: **it takes `FOR UPDATE` on exactly one `p_theft_cars` row and locks nothing else.** A transaction holding exactly one lock cannot be half of a deadlock cycle, which is why the new `p_theft_cars` node introduces none. Do not grow a second lock in these routes. Add that sentence as a comment above the update route.

- [ ] **Step 3: Declare the pages in the manifest**

```ts
  pages: [theftPage, garagePage],
  adminPages: [adminPage],
```

- [ ] **Step 4: Update the manifest tripwire**

`apps/server/test/plugin-manifest-endpoint.test.ts:93-111` asserts the exact `GET /api/plugins` payload of a no-arg boot — today `{ menu: [], pages: [], events: [inventory.purchased] }`. That assertion is the intended tripwire for exactly this change, not collateral damage. Update it to include theft's two menu entries, two pages and two events.

Run the test first and read the actual payload out of the failure diff rather than guessing the ordering; entries follow `CORE_PLUGINS` order, and Task 1 appended `theftPlugin` to the end.

- [ ] **Step 5: Write the admin test**

`apps/server/test/admin-theft.test.ts`, through `bootTestServer()` with an administrator. Cases: a non-admin gets `403` on each of the six routes; creating a car then listing it returns it as a `TableRowsResponse`; updating a car with a blank name keeps the old name; creating a tier with `minCarValue > maxCarValue` is rejected with a `400` (validate it — an inverted bracket silently means "no cars in this tier forever"); every list route emits `id` only as a `valueKey`, never as a rendered column.

- [ ] **Step 6: Run the affected tests**

```bash
npx vitest run apps/server/test/plugin-manifest-endpoint.test.ts apps/server/test/admin-theft.test.ts
npx vitest run --project '@gl3/server:unit' apps/server/test/admin-ids-hidden.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/plugins/theft/src/pages.ts packages/plugins/theft/src/index.ts \
        apps/server/test/plugin-manifest-endpoint.test.ts apps/server/test/admin-theft.test.ts
git commit -m "feat(theft): declare the theft, garage and admin pages in the manifest"
```

---

### Task 8: Full verification and documentation

**Files:**
- Modify: `docs/STATUS.md`, `CLAUDE.md`

- [ ] **Step 1: Run the full suite**

```bash
export DATABASE_URL=postgres://gl3:gl3@localhost:5432/gl3
export REDIS_URL=redis://localhost:6379
export MYSQL_ADMIN_URL=...   # see .env.example — apps/migrate's 25 files need it
npm run verify
```

Run it **bare**. Do not pipe it through `grep`/`tail`, which discards npm's exit status, and do not append `; echo "exit=$?"`, which does the same. Read the exit code directly: an unhandled rejection anywhere makes vitest exit non-zero while still printing a green summary, which is exactly how the gateway's missing `.catch` survived two runs reported as passing. Any non-zero exit is a failure even when every test passed.

Do not start this while another agent's suite is running.

- [ ] **Step 2: Confirm the CI-only checks**

```bash
grep -c "packages/plugins/theft" Dockerfile.server   # 5
grep -c "packages/plugins/theft" apps/server/tsconfig.json tsconfig.json
npx tsc --build --force apps/server/tsconfig.json
```

- [ ] **Step 3: Update the docs**

In `CLAUDE.md`:

- Add the theft cluster to the "Current state" paragraph, noting that it is the second activation of a migrated-but-unread table set and that core migration `0009_relinquish_car_tables` moved `cars`, `theft_tiers` and `garage` out of core — so **six** of fifteen plugins declare migrations, not five.
- Update the plugin count from fourteen to fifteen wherever it appears.
- Update the suite counts (files / tests) to whatever `npm run verify` actually printed.
- Add theft's location→player order to rule 6's list of proven paths, alongside bullets and travel, naming `test/theft-lock-order.test.ts`.

In `docs/STATUS.md`: record the cluster, the new plugin, the relinquish migration, the two new declarative pages (theft is the first core plugin to declare `pages`), and the fact that theft's tests are the only specification of its behaviour — it is not a port.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/STATUS.md
git commit -m "docs: record the theft plugin and the car-table relinquish"
```

---

## Self-review

**Spec coverage.** §1 scope → Tasks 4, 5, 7. §2 table ownership → Tasks 1, 2. §3 lock order → Task 4 (implementation) and Task 6 (proof, with the mandatory red demonstration). §4 stealing → Tasks 3, 4. §5 garage → Task 5. §6 settings → Task 1. §7 events → Task 4 (both declared) and Task 5 (`sold` published). §8 web → Task 7, including the manifest tripwire. §9 admin → Task 7. §10 testing → every task's own test step, plus Task 2 for the `apps/migrate` half. §11 registration → Task 1 Step 8, with the CI-only checks repeated in Task 8.

**Three spec details corrected here, not silently:** the core migration number (`0009`, since `0008` is taken), the event name (`theft.sold`, since plugin events are namespaced by plugin id), and the single `describe` template. All three are recorded under "Plan-level rulings" above.

**Type consistency.** `resolveTheft`, `bracketWeight`, `TheftRolls`, `TheftOutcome`, `CatalogueCar` and `TheftTier` are defined in Task 3 and consumed with the same names in Task 4. `readTheftSettings`/`TheftSettings` are defined in Task 1 and consumed in Tasks 4, 5. `saleValueOf` is defined once in Task 5 and used by both the list and the sell route, which is what makes the number a player is shown the number they are paid. The cooldown action string is `"theft"` in all three places it appears.
