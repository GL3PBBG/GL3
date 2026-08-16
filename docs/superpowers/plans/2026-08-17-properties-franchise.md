# Properties as Franchises Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `properties.plugin_id` live — a property becomes a franchise of one
plugin in one town, bought at a price that plugin declares, earning money that
plugin pays, with the owner setting that plugin's local lever.

**Architecture:** Three phases, each independently mergeable. Phase 0 fixes an M4
migrator defect the V2 source reading exposed. Phase 1 adds a `providesProperties`
manifest field plus a loader registry, and re-keys the table to
`(location_id, plugin_id)`. Phase 2 deletes the flat-rate accrual, repurposes
`cost` as the owner's lever, exports `ownerAt`/`payOwner` for consumer plugins,
makes `bullets` the first consumer, and disowns a dead player's properties via a
`combat.killResolved` subscription.

**Tech Stack:** TypeScript (strict, ESM), Fastify, drizzle-orm, Postgres 16, zod,
vitest, React (apps/web), mysql2 (apps/migrate).

**Spec:** `docs/superpowers/specs/2026-08-16-properties-franchise-design.md`

## Global Constraints

Copied verbatim from `CLAUDE.md` and the spec. Every task's requirements
implicitly include this section.

- **No `any` in `packages/*`** — none, not even a cast. In `apps/*` prefer
  `unknown` plus a zod parse, and type guards over casts.
- **ESM only; relative imports carry a `.js` extension despite `.ts` sources.**
- **Money is `bigint`** in Postgres and TypeScript, and crosses the wire as a
  **decimal string**. Never a JSON number.
- Bigint column defaults are written `` .default(sql`0`) ``, never `.default(0n)`.
- **Zod validates every external boundary** — HTTP bodies, route params, WS frames
  both directions, bus messages.
- **Rule 3: every balance movement goes through `applyBalanceChange`** —
  in a plugin that is `tx.economy.applyBalanceChange`.
- **Rule 5: publish events only after the transaction commits** — inside a plugin
  that means `tx.events.publish` / `tx.events.publishCore`, which buffer and flush
  post-commit. Never a bare `publishEvent` inside `db.transaction`.
- **Rule 6: a foreign key is a lock.** Every location↔player path is
  locations-first: `tx.locks.location(locationId)` **before** `tx.locks.player([...])`.
  Every player↔player pair goes through ONE `tx.locks.player([a, b])` call, which
  sorts and dedupes.
- **Rule 4: tests asserting on `game:events` must filter by their own `actorId`** —
  use `awaitOwnEvent()` from `apps/server/test/helpers/events.ts`.
- **A test that drives a plugin without `bootTestServer()` must run that plugin's
  migrations itself** — `await runPluginMigrations(db, [thePlugin])`.
- **Every new `apps/server/test/*.test.ts` file must be added to
  `vitest.workspace.ts`** in the matching project's `include` array, or it never
  runs and `npm run verify` stays green without it. (`packages/plugin-sdk/test`
  uses a glob and needs no registration.)
- **The last run before a merge is the bare `npm run verify`**, read by exit code:
  `npm run verify > /tmp/verify.log 2>&1; echo "exit=$?"`. Any non-zero exit is a
  failure even when every test passed.
- Environment for every test run:
  ```bash
  export DATABASE_URL=postgres://gl3:gl3@localhost:5432/gl3
  export REDIS_URL=redis://localhost:6379
  export MYSQL_ADMIN_URL=<from .env.example>   # apps/migrate tests only
  ```
- **Never run `FLUSHALL` / `FLUSHDB`.** **Never run two full suites at once.**
- Conventional Commits.
- Acquisition price for `bullets` is **`100_000_000n`** cents ($1,000,000 — V2's
  hardcoded figure). Lever floor is **`10_000n`** cents (V2's `$100`).

---

## File Structure

**Phase 0 — M4 correctness**
- Modify: `apps/migrate/test/fixtures/v2-schema.sql` — real V2 `properties` DDL
- Modify: `apps/migrate/test/fixtures/v2-seed.sql` — `PR_user`, plus a `-1` row
- Modify: `apps/migrate/src/migrators/properties.ts` — read `PR_user`, `0`/`-1` sentinels
- Modify: `apps/migrate/test/migrators/properties.test.ts`
- Modify: `SPEC.md` (lines 75 and 165)

**Phase 1 — declared property types**
- Modify: `packages/plugin-sdk/src/manifest.ts` — `PropertyTypeDecl`, `providesProperties`
- Modify: `packages/plugin-sdk/src/index.ts` — re-export
- Create: `packages/plugin-sdk/test/property-types.test.ts`
- Create: `apps/server/src/plugins/property-types.ts` — `collectPropertyTypes`
- Modify: `apps/server/src/plugins/validate.ts` — duplicate-id boot failure
- Modify: `packages/plugin-sdk/src/ctx.ts` — `ctx.propertyTypes`
- Modify: `apps/server/src/plugins/ctx.ts`, `routes.ts`, `jobs.ts` — wire it
- Create: `apps/server/test/property-type-registry.test.ts`
- Modify: `packages/plugins/properties/src/migrations.ts` — `0003`, `0004`
- Modify: `packages/plugins/properties/src/index.ts` — admin type select + validation
- Modify: `packages/plugins/properties/src/pages.ts`
- Modify: `apps/server/test/admin-properties.test.ts`

**Phase 2 — consumer-paid income**
- Modify: `packages/plugins/properties/src/migrations.ts` — `0005`–`0007`
- Modify: `packages/plugins/properties/src/schema.ts`
- Delete: `packages/plugins/properties/src/settings.ts`, `resolve.ts`
- Delete: `apps/server/test/properties-settings.test.ts`, `properties-resolve.test.ts`
- Create: `packages/plugins/properties/src/api.ts` — `ownerAt`, `payOwner`
- Create: `packages/plugins/properties/src/seizure.ts` — `killResolved` subscription
- Modify: `packages/plugins/properties/src/index.ts` — routes, events, manifest
- Modify: `packages/plugins/properties/package.json` — `@gl3/plugin-combat` dep
- Modify: `packages/plugins/bullets/src/index.ts`, `package.json`, `tsconfig.json`
- Create: `apps/server/test/properties-pay-owner.test.ts`
- Create: `apps/server/test/properties-seizure.test.ts`
- Create: `apps/server/test/properties-consumer-lock-order.test.ts`
- Create: `apps/server/test/bullets-property.test.ts`
- Modify: `apps/server/test/properties-routes.test.ts`, `properties-events.test.ts`,
  `properties-lock-order.test.ts`
- Modify: `apps/migrate/src/pg/plugin-tables.ts`, `src/migrators/properties.ts`
- Modify: `packages/shared/src/dto/properties.ts`
- Modify: `apps/web/src/pages/Properties.tsx`, `src/api/queries.ts`
- Modify: `apps/web/test/properties-page.test.ts`
- Modify: `vitest.workspace.ts` — four new files in, two deleted files out
- Modify: `docs/STATUS.md`, `CLAUDE.md`, `packages/shared/package.json`,
  `packages/plugin-sdk/package.json`

---

# PHASE 0 — M4 correctness

### Task 1: Migrator reads `PR_user`, with the `0` and `-1` sentinels

The V2 column is `PR_user`, not `PR_owner`. `apps/migrate/src/migrators/properties.ts:13`
selects `PR_owner` and would die on a real V2 database with
`ERROR 1054 Unknown column 'PR_owner' in 'field list'`. The fixture hides it
because the fixture was reconstructed from the same wrong SPEC line. `0` means
unowned and `-1` means "closed"; both map to a null owner in GL3.

**Files:**
- Modify: `apps/migrate/test/fixtures/v2-schema.sql:230-238`
- Modify: `apps/migrate/test/fixtures/v2-seed.sql:111-113`
- Modify: `apps/migrate/src/migrators/properties.ts:7-8,13,23`
- Test: `apps/migrate/test/migrators/properties.test.ts`
- Modify: `SPEC.md:75`, `SPEC.md:165`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: nothing later tasks import. Task 5 later edits the same migrator to
  drop `rate` and `lastClaimedAt`.

- [ ] **Step 1: Correct the fixture DDL to the real V2 statement**

Replace the `properties` block in `apps/migrate/test/fixtures/v2-schema.sql`
(currently lines 230-238) with the real DDL from
`ChristopherDay/Gangster-Legends-V2` `install/schema.sql`. Note the absent unique
constraint, `VARCHAR(128)`, `PR_user`, and `ENGINE = InnoDB`:

```sql
-- Verbatim from V2 install/schema.sql. Do NOT "tidy" this: the absent unique
-- constraint on PR_location is real (V2 keys on (PR_location, PR_module) by
-- convention only), and PR_user NOT NULL DEFAULT 0 carries two sentinels —
-- 0 = unowned, -1 = closed.
CREATE TABLE IF NOT EXISTS `properties` (
  `PR_id` INT(11) NOT NULL PRIMARY KEY AUTO_INCREMENT ,
  `PR_location` INT(11) NOT NULL ,
  `PR_module` VARCHAR(128) NOT NULL ,
  `PR_user` int(11) NOT NULL DEFAULT 0,
  `PR_cost` int(11) NOT NULL DEFAULT 0,
  `PR_profit` INT(11) NOT NULL DEFAULT 0
) ENGINE = InnoDB;
```

- [ ] **Step 2: Correct the fixture seed and add sentinel rows**

Replace the `properties` INSERT in `apps/migrate/test/fixtures/v2-seed.sql`
(currently lines 111-113) with:

```sql
INSERT INTO properties (PR_location, PR_module, PR_user, PR_cost, PR_profit) VALUES
  (1, 'casino', 1, 5000, 100),
  (1, 'bullets', 0, 250, 0),     -- PR_user = 0: unowned
  (2, 'casino', -1, 0, 0),       -- PR_user = -1: closed, migrates as unowned
  (99, 'casino', 1, 5000, 100);  -- orphan: location 99 does not exist
```

Note the two rows on location 1: V2 allows several properties per town, and the
GL3 plugin table's `unique(location_id)` will reject the second one until Task 4
re-keys it. That is expected and is what Step 5 asserts.

- [ ] **Step 3: Run the migrator test to verify it fails**

```bash
export DATABASE_URL=postgres://gl3:gl3@localhost:5432/gl3
export REDIS_URL=redis://localhost:6379
export MYSQL_ADMIN_URL=$(grep MYSQL_ADMIN_URL .env.example | cut -d= -f2-)
npx vitest run --project @gl3/migrate apps/migrate/test/migrators/properties.test.ts
```

Expected: FAIL with `Unknown column 'PR_owner' in 'field list'`. This is the proof
the defect was real — record the exact message in the commit body.

- [ ] **Step 4: Fix the migrator**

In `apps/migrate/src/migrators/properties.ts`, change the row interface, the
SELECT, and the owner resolution:

```ts
interface PropertyRow {
  PR_id: number; PR_location: number; PR_module: string; PR_user: number; PR_cost: number; PR_profit: number;
}

export async function migrateProperties(pool: mysql.Pool, exec: Executor, report: MigrationReport): Promise<void> {
  const [rows] = await pool.query<(PropertyRow & mysql.RowDataPacket)[]>(
    "SELECT PR_id, PR_location, PR_module, PR_user, PR_cost, PR_profit FROM properties",
  );
```

and replace the owner lookup line with:

```ts
    // V2's PR_user is NOT NULL DEFAULT 0 and carries two sentinels: 0 means
    // unowned, -1 means "closed" (class/property.php getOwnership special-cases
    // it). GL3 has no closed state, so both become a null owner. Only a
    // positive id is a real user reference — passing 0 or -1 to lookupV3Id
    // would report a spurious orphan.
    const ownerPlayerId = row.PR_user > 0 ? await lookupV3Id(exec, "users", row.PR_user) : null;
```

- [ ] **Step 5: Update the test to cover the sentinels**

Replace the assertion block in `apps/migrate/test/migrators/properties.test.ts`
with:

```ts
      const report = createReport(false);
      await migrateProperties(pool, db, report);

      const vitoId = (await lookupV3Id(db, "users", 1))!;
      const rows = await db.select().from(propertiesPlugin);

      // Location 1 'casino' (owned), location 2 'casino' (PR_user = -1 → unowned).
      // The location-1 'bullets' row is rejected by the plugin table's current
      // unique(location_id) — Task 4 re-keys to (location_id, plugin_id) and
      // this count becomes 3. The location-99 row is dropped as an orphan.
      const casino1 = rows.find((r) => r.pluginId === "casino" && r.ownerPlayerId !== null);
      expect(casino1).toMatchObject({ pluginId: "casino", ownerPlayerId: vitoId, cost: 5000n, profit: 100n, rate: 500n });
      expect(casino1!.lastClaimedAt).not.toBeNull();

      const closed = rows.find((r) => r.ownerPlayerId === null);
      expect(closed).toBeDefined();
      expect(closed!.ownerPlayerId).toBeNull();
      expect(closed!.lastClaimedAt).toBeNull(); // unowned rows get no accrual clock

      expect(report.orphans).toContainEqual({ table: "properties", v2Id: 99, reason: "location 99 does not exist" });
      // PR_user = -1 must NOT be reported as an orphan user.
      expect(report.orphans.some((o) => o.v2Id === -1)).toBe(false);
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
npx vitest run --project @gl3/migrate apps/migrate/test/migrators/properties.test.ts
```

Expected: PASS.

If the `unique(location_id)` violation aborts the whole migrator run rather than
skipping one row, wrap the insert's error the same way `properties.ts` already
handles orphans — but first check: `onConflictDoUpdate({ target: propertiesPlugin.id })`
targets the primary key, so the second location-1 row raises `23505` on
`p_properties_location_key`. Add nothing to the migrator for this; instead, in the
fixture seed, temporarily keep only one row per location and add the second in
Task 4 where the constraint changes. Choose whichever the run shows is needed and
say which in the commit body.

- [ ] **Step 7: Correct SPEC.md**

`SPEC.md:75` — replace the `properties` row's Notes cell with:

```
**`PR_module` varchar(128) names the module implementing the property** — string coupling to plugin ids; keep as `plugin_id` string in GL3. Owner column is **`PR_user`** (`NOT NULL DEFAULT 0`), where `0` = unowned and `-1` = closed. No unique constraint: the logical key is `(PR_location, PR_module)`, several properties per town
```

`SPEC.md:165` — replace the `properties` line with:

```
properties         id, location_id FK, plugin_id varchar(128), owner_player_id FK nullable,
```

- [ ] **Step 8: Run the whole migrate project**

```bash
npx vitest run --project @gl3/migrate
```

Expected: PASS. If other migrator tests read the properties fixture rows, fix them
here — the fixture is shared.

- [ ] **Step 9: Commit**

```bash
git add apps/migrate/src/migrators/properties.ts apps/migrate/test/fixtures/v2-schema.sql \
        apps/migrate/test/fixtures/v2-seed.sql apps/migrate/test/migrators/properties.test.ts SPEC.md
git commit -m "fix(migrate): properties migrator reads PR_user, not PR_owner

The V2 column is PR_user; PR_owner does not exist, so a real migration run
died with ERROR 1054. The fixture hid it because the fixture DDL was
reconstructed from the same wrong SPEC line. Replaces the reconstruction with
the real install/schema.sql statement and handles the 0 (unowned) and -1
(closed) sentinels."
```

---

# PHASE 1 — declared property types

### Task 2: `providesProperties` manifest field in the SDK

**Files:**
- Modify: `packages/plugin-sdk/src/manifest.ts`
- Modify: `packages/plugin-sdk/src/index.ts`
- Test: `packages/plugin-sdk/test/property-types.test.ts` (new; the SDK project
  globs `test/**/*.test.ts`, so no `vitest.workspace.ts` entry is needed)

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface PropertyTypeDecl {
    id: string;          // must equal the declaring plugin's id
    name: string;        // human label, e.g. "Bullet Factory"
    price: bigint;       // acquisition price in cents
    leverLabel: string;  // what `cost` means, e.g. "Price per bullet"
  }
  ```
  plus `providesProperties?: PropertyTypeDecl[]` on `PluginManifestInput` and
  `providesProperties: PropertyTypeDecl[]` on `PluginManifest`.
  Tasks 3, 4, 8 and 9 all import `PropertyTypeDecl` from `@gl3/plugin-sdk`.

- [ ] **Step 1: Write the failing test**

Create `packages/plugin-sdk/test/property-types.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { definePlugin } from "../src/index.js";

const base = { id: "casino", version: "1.0.0", basePaths: ["/api/casino"] };

describe("providesProperties", () => {
  it("defaults to an empty array", () => {
    expect(definePlugin({ ...base }).providesProperties).toEqual([]);
  });

  it("normalises a declaration through", () => {
    const manifest = definePlugin({
      ...base,
      providesProperties: [
        { id: "casino", name: "Casino", price: 100_000_000n, leverLabel: "Max bet" },
      ],
    });
    expect(manifest.providesProperties).toEqual([
      { id: "casino", name: "Casino", price: 100_000_000n, leverLabel: "Max bet" },
    ]);
  });

  it("rejects a declaration whose id is not the plugin's own id", () => {
    expect(() =>
      definePlugin({
        ...base,
        providesProperties: [
          { id: "bullets", name: "Casino", price: 100_000_000n, leverLabel: "Max bet" },
        ],
      }),
    ).toThrow(/providesProperties/);
  });

  it("rejects more than one declaration", () => {
    expect(() =>
      definePlugin({
        ...base,
        providesProperties: [
          { id: "casino", name: "Casino", price: 100_000_000n, leverLabel: "Max bet" },
          { id: "casino", name: "Other", price: 1n, leverLabel: "x" },
        ],
      }),
    ).toThrow(/at most one/);
  });

  it("rejects a non-positive price", () => {
    expect(() =>
      definePlugin({
        ...base,
        providesProperties: [{ id: "casino", name: "Casino", price: 0n, leverLabel: "Max bet" }],
      }),
    ).toThrow();
  });

  it("rejects an empty leverLabel", () => {
    expect(() =>
      definePlugin({
        ...base,
        providesProperties: [{ id: "casino", name: "Casino", price: 1n, leverLabel: "" }],
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run --project @gl3/plugin-sdk packages/plugin-sdk/test/property-types.test.ts
```

Expected: FAIL — `providesProperties` is not a known manifest key, so
`.strict()` rejects it (`Unrecognized key(s) in object`).

- [ ] **Step 3: Add the type and schema to `manifest.ts`**

After the `PluginMigration` interface and its `MigrationSchema`, add:

```ts
/**
 * A property type a plugin declares itself the implementer of — V2's
 * `PR_module` made explicit. The `properties` plugin stores `id` in
 * `plugin_id`; the loader collects every declaration into a registry so an
 * admin picks from a list rather than typing a string, and so an unknown
 * string cannot be bought.
 *
 * `id` must equal the declaring plugin's own id, and a plugin may declare at
 * most one: V2's key is `(PR_location, PR_module)`, one row per module per
 * town, and a second type would need a discriminator that key does not have.
 */
export interface PropertyTypeDecl {
  id: string;
  name: string;
  /** Acquisition price in cents. V2 hardcoded $1,000,000 → 100_000_000n. */
  price: bigint;
  /** What `cost` means for this type, shown next to the owner's input. */
  leverLabel: string;
}

const PropertyTypeDeclSchema = z
  .object({
    id: z.string().regex(PLUGIN_ID_PATTERN),
    name: z.string().min(1),
    price: z.bigint().positive(),
    leverLabel: z.string().min(1),
  })
  .strict();
```

- [ ] **Step 4: Add the field to both manifest interfaces and the parser**

In `PluginManifestInput` add `providesProperties?: PropertyTypeDecl[];` next to
`provides?`. In `PluginManifest` add `providesProperties: PropertyTypeDecl[];`.
In the zod object add `providesProperties: z.array(PropertyTypeDeclSchema).optional(),`.
In the normalised return add `providesProperties: parsed.providesProperties ?? [],`.

Then extend the existing `.superRefine` (the one that already walks
`manifest.migrations`) with the two cross-field checks:

```ts
    if (manifest.providesProperties !== undefined) {
      if (manifest.providesProperties.length > 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["providesProperties"],
          message: "a plugin may declare at most one property type",
        });
      }
      manifest.providesProperties.forEach((decl, index) => {
        if (decl.id !== manifest.id) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["providesProperties", index, "id"],
            message: `must equal the plugin's own id ("${manifest.id}")`,
          });
        }
      });
    }
```

- [ ] **Step 5: Re-export from the SDK index**

In `packages/plugin-sdk/src/index.ts`, add `PropertyTypeDecl` to the existing
type re-export block that already carries `PluginManifest` and
`PluginManifestInput`.

- [ ] **Step 6: Run the test to verify it passes**

```bash
npx vitest run --project @gl3/plugin-sdk
```

Expected: PASS, all SDK tests including the existing `manifest.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add packages/plugin-sdk/src/manifest.ts packages/plugin-sdk/src/index.ts \
        packages/plugin-sdk/test/property-types.test.ts
git commit -m "feat(sdk): providesProperties manifest field

A plugin declares itself the implementer of one property type: id (must equal
its own), human name, acquisition price and the label for the owner-set lever.
Backs the properties plugin's plugin_id, which has been a dormant string."
```

---

### Task 3: Loader registry and `ctx.propertyTypes`

**Files:**
- Create: `apps/server/src/plugins/property-types.ts`
- Modify: `apps/server/src/plugins/validate.ts`
- Modify: `packages/plugin-sdk/src/ctx.ts`
- Modify: `apps/server/src/plugins/ctx.ts`
- Modify: `apps/server/src/plugins/routes.ts:71-78`
- Modify: `apps/server/src/plugins/jobs.ts:66-72`
- Modify: `docs/superpowers/specs/2026-08-16-properties-franchise-design.md` §2.2
- Test: `apps/server/test/property-type-registry.test.ts` (new)
- Modify: `vitest.workspace.ts` — add the new file to the `@gl3/server:unit` project

**Interfaces:**
- Consumes: `PropertyTypeDecl` from `@gl3/plugin-sdk` (Task 2).
- Produces:
  ```ts
  // apps/server/src/plugins/property-types.ts
  export function collectPropertyTypes(
    manifests: readonly PluginManifest[],
  ): Map<string, PropertyTypeDecl>;
  ```
  and on `PluginCtx`:
  ```ts
  readonly propertyTypes: {
    get(id: string): PropertyTypeDecl | null;
    list(): readonly PropertyTypeDecl[];
  };
  ```
  Task 4 and Task 7 both call `ctx.propertyTypes.get` / `.list`.

**Spec deviation, applied here:** spec §2.2 says the registry is exposed "to the
`properties` plugin — and to nothing else". Enforcing that needs a per-plugin ctx
variant for one field, and the data is already public (every manifest is served by
`GET /api/plugins`). Step 7 amends the spec to say the registry is on every
plugin's ctx, so plan and spec agree rather than the plan silently deviating.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/property-type-registry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { definePlugin } from "@gl3/plugin-sdk";
import { collectPropertyTypes } from "../src/plugins/property-types.js";

const casino = definePlugin({
  id: "casino", version: "1.0.0", basePaths: ["/api/casino"],
  providesProperties: [{ id: "casino", name: "Casino", price: 100_000_000n, leverLabel: "Max bet" }],
});
const bullets = definePlugin({
  id: "bullets", version: "1.0.0", basePaths: ["/api/bullets"],
  providesProperties: [{ id: "bullets", name: "Bullet Factory", price: 100_000_000n, leverLabel: "Price per bullet" }],
});
const plain = definePlugin({ id: "mail", version: "1.0.0", basePaths: ["/api/mail"] });

describe("collectPropertyTypes", () => {
  it("keys every declaration by its id", () => {
    const registry = collectPropertyTypes([casino, bullets, plain]);
    expect([...registry.keys()].sort()).toEqual(["bullets", "casino"]);
    expect(registry.get("casino")?.name).toBe("Casino");
  });

  it("is empty when nothing declares a type", () => {
    expect(collectPropertyTypes([plain]).size).toBe(0);
  });

  it("throws on two plugins declaring the same type id", () => {
    // definePlugin forbids a decl id different from the plugin id, so the only
    // way two manifests collide is two plugins with the same id — which the
    // loader's own id check would also catch. Constructed here directly so the
    // registry carries its own guard rather than relying on that ordering.
    const clash = { ...casino, id: "casino" };
    expect(() => collectPropertyTypes([casino, clash])).toThrow(/casino/);
  });
});
```

- [ ] **Step 2: Register the test file**

In `vitest.workspace.ts`, add `"test/property-type-registry.test.ts"` to the
`include` array of the `@gl3/server:unit` project (the one that already lists
`test/properties-settings.test.ts` and `test/properties-resolve.test.ts` around
line 205).

- [ ] **Step 3: Run it to verify it fails**

```bash
npx vitest run --project "@gl3/server:unit" apps/server/test/property-type-registry.test.ts
```

Expected: FAIL — `Cannot find module '../src/plugins/property-types.js'`.

- [ ] **Step 4: Write `collectPropertyTypes`**

Create `apps/server/src/plugins/property-types.ts`:

```ts
import type { PluginManifest, PropertyTypeDecl } from "@gl3/plugin-sdk";

/**
 * Every declared property type, keyed by id. Pure — recomputed at each call
 * site rather than cached, the same shape as `collectFilters` in `routes.ts`.
 *
 * A duplicate id is a hard boot failure. `definePlugin` already forces a
 * declaration's id to equal its plugin's id, so a collision here means two
 * manifests share an id; the guard stays anyway so this function is correct
 * standalone rather than only in the order the loader happens to run checks.
 */
export function collectPropertyTypes(
  manifests: readonly PluginManifest[],
): Map<string, PropertyTypeDecl> {
  const registry = new Map<string, PropertyTypeDecl>();
  for (const manifest of manifests) {
    for (const decl of manifest.providesProperties) {
      if (registry.has(decl.id)) {
        throw new Error(
          `plugin validation failed — property type "${decl.id}" is declared by more than one plugin`,
        );
      }
      registry.set(decl.id, decl);
    }
  }
  return registry;
}
```

- [ ] **Step 5: Run it to verify it passes**

```bash
npx vitest run --project "@gl3/server:unit" apps/server/test/property-type-registry.test.ts
```

Expected: PASS.

- [ ] **Step 6: Put the registry on the plugin ctx**

In `packages/plugin-sdk/src/ctx.ts`, import the type and add the member to
`PluginCtx` after `settings`:

```ts
import type { PropertyTypeDecl } from "./manifest.js";
```

```ts
  /**
   * Every property type declared by any installed plugin, from the loader's
   * registry. Read-only manifest data — the same information `GET /api/plugins`
   * already serves — so every plugin sees it, not only `properties`.
   */
  readonly propertyTypes: {
    get(id: string): PropertyTypeDecl | null;
    list(): readonly PropertyTypeDecl[];
  };
```

In `apps/server/src/plugins/ctx.ts`, add to `PluginCtxOptions`:

```ts
  propertyTypes: ReadonlyMap<string, PropertyTypeDecl>;
```

and to the `ctx` object literal, next to `settings`:

```ts
    propertyTypes: {
      get: (id) => options.propertyTypes.get(id) ?? null,
      list: () => [...options.propertyTypes.values()],
    },
```

- [ ] **Step 7: Wire both ctx call sites, and amend the spec**

In `apps/server/src/plugins/routes.ts`, in the `createPluginCtx` call at line 71:

```ts
          const ctx = createPluginCtx(deps, {
            pluginId: manifest.id,
            player,
            job: null,
            filters: collectFilters(manifests),
            propertyTypes: collectPropertyTypes(manifests),
          });
```

In `apps/server/src/plugins/jobs.ts`, in `runPluginJob`'s `createPluginCtx` call:

```ts
  const ctx = createPluginCtx(deps, {
    pluginId: manifest.id,
    player: null,
    job: { id: jobId, seed, rng: createRng(seed) },
    filters: manifest.filters,
    // `runPluginJob` receives one manifest, not the set — the same narrowing
    // `filters` above already has. No job reads the registry today; if one
    // ever needs a type another plugin declares, this signature is what has
    // to widen.
    propertyTypes: collectPropertyTypes([manifest]),
  });
```

Add `import { collectPropertyTypes } from "./property-types.js";` to both files.

Then edit `docs/superpowers/specs/2026-08-16-properties-franchise-design.md` §2.2,
replacing the paragraph beginning "The registry is exposed to the `properties`
plugin — and to nothing else" with:

```
The registry is exposed on every plugin's ctx as `ctx.propertyTypes`
(`get(id)` / `list()`). It is read-only loader state derived from manifests —
the same data `GET /api/plugins` already serves publicly — so there is nothing
to withhold, and a per-plugin ctx variant for one field would not earn its
complexity. It is the same shape as the existing `ctx.settings` accessor.
```

- [ ] **Step 8: Make a duplicate a boot failure**

In `apps/server/src/plugins/validate.ts`, add the import and call
`collectPropertyTypes(manifests)` inside `validatePlugins` (its throw already
carries the `plugin validation failed — ` prefix that `fail()` uses, so the
message shape matches).

- [ ] **Step 9: Typecheck and run the server unit project**

```bash
npm run typecheck
npx vitest run --project "@gl3/server:unit"
```

Expected: PASS. If any existing test constructs `PluginCtxOptions` by hand, it now
needs `propertyTypes: new Map()` — fix those call sites here.

- [ ] **Step 10: Commit**

```bash
git add apps/server/src/plugins/property-types.ts apps/server/src/plugins/validate.ts \
        apps/server/src/plugins/ctx.ts apps/server/src/plugins/routes.ts \
        apps/server/src/plugins/jobs.ts packages/plugin-sdk/src/ctx.ts \
        apps/server/test/property-type-registry.test.ts vitest.workspace.ts \
        docs/superpowers/specs/2026-08-16-properties-franchise-design.md
git commit -m "feat(server): property type registry on the plugin ctx

Collects every providesProperties declaration into a Map keyed by id, fails
boot on a duplicate, and exposes it as ctx.propertyTypes. Spec §2.2 amended:
the registry is on every plugin's ctx, not just properties'."
```

---

### Task 4: Re-key to `(location_id, plugin_id)` and make admin pick from the registry

**Files:**
- Modify: `packages/plugins/properties/src/migrations.ts`
- Modify: `packages/plugins/properties/src/index.ts` (admin routes)
- Modify: `packages/plugins/properties/src/pages.ts`
- Test: `apps/server/test/admin-properties.test.ts`

**Interfaces:**
- Consumes: `ctx.propertyTypes` (Task 3).
- Produces: route `GET /api/admin/properties/types` returning
  `{ rows: [{ pluginId, name, price, leverLabel }] }`, consumed by the admin
  page's select and by nothing else.

- [ ] **Step 1: Write the failing test**

Add to `apps/server/test/admin-properties.test.ts` (inside the existing
`describe`, using that file's existing boot/login helpers — read the top of the
file and reuse its `bootTestServer` + admin-session setup verbatim rather than
inventing a new one):

```ts
  it("lists declared property types for the create form's select", async () => {
    const res = await app.inject({
      method: "GET", url: "/api/admin/properties/types", headers: adminHeaders,
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json<{ rows: { pluginId: string; name: string }[] }>().rows;
    expect(rows.map((r) => r.pluginId)).toContain("bullets");
  });

  it("refuses to create a property with an undeclared type", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/admin/properties", headers: adminHeaders,
      payload: { locationId, pluginId: "not-a-plugin", cost: "0", rate: "500" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toBe("unknown_property_type");
  });

  it("allows two property types in the same location", async () => {
    const first = await app.inject({
      method: "POST", url: "/api/admin/properties", headers: adminHeaders,
      payload: { locationId, pluginId: "bullets", cost: "0", rate: "500" },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST", url: "/api/admin/properties", headers: adminHeaders,
      payload: { locationId, pluginId: "casino", cost: "0", rate: "500" },
    });
    // 'casino' is not declared by any installed plugin, so this is the
    // undeclared-type refusal, not a uniqueness one.
    expect(second.statusCode).toBe(404);

    const duplicate = await app.inject({
      method: "POST", url: "/api/admin/properties", headers: adminHeaders,
      payload: { locationId, pluginId: "bullets", cost: "0", rate: "500" },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json<{ error: string }>().error).toBe("location_type_taken");
  });
```

This test needs `bullets` to declare a type. Add the declaration to
`packages/plugins/bullets/src/index.ts`'s manifest now — the rest of the bullets
work is Task 9:

```ts
export default definePlugin({
  id: "bullets",
  version: "1.0.0",
  basePaths: ["/api/bullets", "/api/admin/bullets"],
  routes: [buyRoute, adminListRoute, adminStockRoute],
  adminPages: [adminPage],
  providesProperties: [{
    id: "bullets",
    name: "Bullet Factory",
    price: 100_000_000n,          // $1,000,000 in cents — V2's hardcoded figure
    leverLabel: "Price per bullet",
  }],
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run --project @gl3/server apps/server/test/admin-properties.test.ts
```

Expected: FAIL — 404 on `/api/admin/properties/types` (route does not exist) and
409 `location_taken` where the test wants a per-type key.

- [ ] **Step 3: Re-key the table**

Append to `PROPERTIES_MIGRATIONS` in `packages/plugins/properties/src/migrations.ts`
(one statement per entry — the runner issues exactly one `sql.raw` per
declaration and postgres.js rejects multi-statement strings):

```ts
  {
    // V2 has no unique constraint at all; its logical key is
    // (PR_location, PR_module). GL3's original unique(location_id) was a GL3
    // invention and it is what stops a town having both a casino and a bullet
    // factory. The old constraint was strictly stronger, so no existing row
    // can violate the new one.
    name: "0003_drop_location_unique",
    sql: `DROP INDEX IF EXISTS p_properties_location_key`,
  },
  {
    name: "0004_location_plugin_unique",
    sql: `CREATE UNIQUE INDEX p_properties_location_plugin_key
            ON p_properties_properties (location_id, plugin_id)`,
  },
```

- [ ] **Step 4: Add the types route and validate the create body against the registry**

In `packages/plugins/properties/src/index.ts`, add after `adminLocationsRoute`:

```ts
/**
 * Every property type any installed plugin declares, as a TableRowsResponse —
 * the create form's select `optionsSource`. `pluginId` is the select's
 * `valueKey`; the human `name` is what an admin sees, so nobody types a plugin
 * id by hand any more.
 */
const adminTypesRoute = route({
  method: "GET",
  path: "/api/admin/properties/types",
  auth: "admin",
  handler: async (ctx) => {
    const rows = ctx.propertyTypes.list().map((decl) => ({
      pluginId: decl.id,
      name: decl.name,
      price: decl.price.toString(),
      leverLabel: decl.leverLabel,
    }));
    return { status: 200, body: { rows } };
  },
});
```

In `adminCreateRoute`'s handler, before the transaction:

```ts
    if (ctx.propertyTypes.get(body.pluginId) === null) {
      throw new PluginError("unknown_property_type", 404);
    }
```

and change the `23505` translation, whose meaning has moved:

```ts
      // unique(location_id, plugin_id) violation → this town already has a
      // property of this type.
      if (code === "23505") throw new PluginError("location_type_taken", 409);
```

Apply the same registry check in `adminUpdateRoute` when `body.pluginId` is
present:

```ts
    if (body.pluginId !== undefined && ctx.propertyTypes.get(body.pluginId) === null) {
      throw new PluginError("unknown_property_type", 404);
    }
```

- [ ] **Step 5: Stop hiding claimed locations from the create form**

`adminLocationsRoute` currently filters out every location that has any property.
With a per-type key that is wrong — a town with a bullet factory can still take a
casino. Replace its handler body and doc comment with:

```ts
/**
 * Every location as a TableRowsResponse — the create form's select
 * `optionsSource`. It no longer filters out locations that already have a
 * property: since `0004_location_plugin_unique` the key is
 * (location_id, plugin_id), so a town with one type can still take another.
 * The 409 `location_type_taken` guard on the create route is what rejects a
 * genuine duplicate.
 */
const adminLocationsRoute = route({
  method: "GET",
  path: "/api/admin/properties/locations",
  auth: "admin",
  handler: async (ctx) => {
    return ctx.transaction(async (tx) => {
      const rows = (await tx.db.select({ id: locations.id, name: locations.name }).from(locations))
        .map((loc) => ({ locationId: loc.id, locationName: loc.name }));
      return { status: 200, body: { rows } };
    });
  },
});
```

- [ ] **Step 6: Register the route and swap the admin page's field**

Add `adminTypesRoute` to the manifest's `routes` array.

In `packages/plugins/properties/src/pages.ts`, replace the `pluginId` field in
**both** forms with a select over the registry:

```ts
        { name: "pluginId", label: "Type", type: "select",
          optionsSource: "GET /api/admin/properties/types", valueKey: "pluginId", labelKey: "name", allowEmpty: false },
```

For the update form use the same node but with `allowEmpty: true` and the label
`"Type (optional)"`, matching its existing blank-means-unchanged behaviour.

Also change the table's `plugin` column label from `"Plugin ID"` to `"Type"`.

- [ ] **Step 7: Run the test to verify it passes**

```bash
npx vitest run --project @gl3/server apps/server/test/admin-properties.test.ts
```

Expected: PASS. `test/admin-ids-hidden.test.ts` must also stay green — the new
select's `valueKey` is `pluginId`, not a UUID, so it is unaffected, but run it:

```bash
npx vitest run --project @gl3/server apps/server/test/admin-ids-hidden.test.ts
```

- [ ] **Step 8: Restore the second fixture row if Task 1 Step 6 removed it**

If Task 1's fixture kept only one row per location because of the old unique
constraint, add the location-1 `bullets` row back now and update the migrator
test's expected row count to 3. Run:

```bash
npx vitest run --project @gl3/migrate apps/migrate/test/migrators/properties.test.ts
```

Expected: PASS with three migrated rows.

- [ ] **Step 9: Commit**

```bash
git add packages/plugins/properties/src/migrations.ts packages/plugins/properties/src/index.ts \
        packages/plugins/properties/src/pages.ts packages/plugins/bullets/src/index.ts \
        apps/server/test/admin-properties.test.ts
git commit -m "feat(properties): key on (location_id, plugin_id), admin picks a declared type

A town can now hold one property per declared type, as V2 does. plugin_id is
validated against the loader registry on create and update, and the admin form
selects a human name instead of accepting a free-text plugin id."
```

---

# PHASE 2 — consumer-paid income

### Task 5: Drop the accrual clock; `cost` becomes the lever

**Files:**
- Modify: `packages/plugins/properties/src/migrations.ts`
- Modify: `packages/plugins/properties/src/schema.ts`
- Delete: `packages/plugins/properties/src/settings.ts`, `src/resolve.ts`
- Delete: `apps/server/test/properties-settings.test.ts`, `apps/server/test/properties-resolve.test.ts`
- Modify: `packages/plugins/properties/src/index.ts` — remove `sellRoute`, `claimRoute`, `soldEvent`, `incomeEvent`
- Modify: `apps/migrate/src/pg/plugin-tables.ts`, `apps/migrate/src/migrators/properties.ts`, `apps/migrate/test/migrators/properties.test.ts`
- Modify: `vitest.workspace.ts` — remove the two deleted entries
- Modify: `apps/server/test/properties-routes.test.ts` — drop sell/claim cases

**Interfaces:**
- Consumes: nothing new.
- Produces: `propertiesTable` without `rate` / `lastClaimedAt`; `cost` now means
  the owner's lever. Tasks 6, 7, 9 all read that shape.

- [ ] **Step 1: Write the failing test**

Add to `apps/server/test/properties-routes.test.ts`:

```ts
  it("has no claim or sell route", async () => {
    const claim = await app.inject({
      method: "POST", url: `/api/properties/${propertyId}/claim`, headers: playerHeaders,
    });
    expect(claim.statusCode).toBe(404);

    const sell = await app.inject({
      method: "POST", url: `/api/properties/${propertyId}/sell`, headers: playerHeaders,
    });
    expect(sell.statusCode).toBe(404);
  });
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run --project @gl3/server apps/server/test/properties-routes.test.ts
```

Expected: FAIL — both routes still exist and answer 200 or 409, not 404.

- [ ] **Step 3: Add the three migrations**

Append to `PROPERTIES_MIGRATIONS`:

```ts
  {
    // Income is no longer a clock: a property earns what its consumer plugin
    // pays it. Nothing reads these two columns after this migration.
    name: "0005_drop_rate",
    sql: `ALTER TABLE p_properties_properties DROP COLUMN rate`,
  },
  {
    name: "0006_drop_last_claimed_at",
    sql: `ALTER TABLE p_properties_properties DROP COLUMN last_claimed_at`,
  },
  {
    // `cost` changes meaning from purchase price to the owner-set lever the
    // consumer reads (V2's PR_cost). Existing values are purchase prices and
    // would be nonsense as levers, so they are zeroed — and 0 is exactly what
    // V2's transfer() writes on handover, meaning "owner has set no lever".
    name: "0007_cost_becomes_lever",
    sql: `UPDATE p_properties_properties SET cost = 0`,
  },
```

- [ ] **Step 4: Update the drizzle handle**

In `packages/plugins/properties/src/schema.ts`, delete the `lastClaimedAt` and
`rate` lines from `propertiesTable`, remove the now-unused `timestamp` import, and
replace the table's doc comment with:

```ts
/**
 * The table this plugin OWNS. `migrations.ts` is the definition and this
 * handle must be kept in step with it by hand.
 *
 * `cost` is the OWNER'S LEVER, not a purchase price (V2's PR_cost): the
 * consumer plugin reads it as its local price or limit. Zero means "the owner
 * has set none — consumer, use your own default". The acquisition price lives
 * in the consumer's `providesProperties` declaration.
 *
 * `profit` is lifetime P&L and MAY BE NEGATIVE: a consumer that makes the
 * owner the house (V2's blackjack) debits through `payOwner`.
 */
```

- [ ] **Step 5: Delete the accrual code and its tests**

```bash
git rm packages/plugins/properties/src/settings.ts packages/plugins/properties/src/resolve.ts \
       apps/server/test/properties-settings.test.ts apps/server/test/properties-resolve.test.ts
```

Remove from `vitest.workspace.ts` the two `include` entries
`"test/properties-settings.test.ts"` and `"test/properties-resolve.test.ts"`.

- [ ] **Step 6: Strip the accrual out of `index.ts`**

In `packages/plugins/properties/src/index.ts`:
- delete the `readPropertiesSettings` and `accruedSince` imports and re-exports
- delete `sellRoute`, `claimRoute`, `soldEvent`, `incomeEvent` entirely
- in the manifest, `routes` loses `sellRoute` and `claimRoute`; `events` becomes
  `[boughtEvent]` for now (Task 7 adds the rest)
- in `listRoute`, delete the `config` line, the `accrued` computation and the
  `accrued` and `rate` row fields; add `lever` and `profit`:

```ts
      const rows = await tx.db
        .select({
          id: propertiesTable.id,
          locationId: propertiesTable.locationId,
          pluginId: propertiesTable.pluginId,
          ownerPlayerId: propertiesTable.ownerPlayerId,
          cost: propertiesTable.cost,
          profit: propertiesTable.profit,
          locationName: locations.name,
          ownerName: players.username,
        })
        .from(propertiesTable)
        .leftJoin(locations, eq(locations.id, propertiesTable.locationId))
        .leftJoin(players, eq(players.id, propertiesTable.ownerPlayerId));

      return {
        status: 200,
        body: {
          rows: rows.map((row) => {
            const decl = ctx.propertyTypes.get(row.pluginId);
            const isOwner = row.ownerPlayerId === player.id;
            return {
              id: row.id,
              locationId: row.locationId,
              locationName: row.locationName ?? "",
              pluginId: row.pluginId,
              typeName: decl?.name ?? row.pluginId,
              // "" when the type is not installed: there is no declared price,
              // so the row is not buyable and the page renders no Buy button.
              price: decl === null ? "" : decl.price.toString(),
              leverLabel: decl?.leverLabel ?? "",
              ownerName: row.ownerPlayerId ? (row.ownerName ?? "") : "—",
              // The lever and the P&L are the owner's business only.
              lever: isOwner ? row.cost.toString() : "",
              profit: isOwner ? row.profit.toString() : "",
            };
          }),
        },
      };
```

- delete `rate` from the admin list route's select and its row mapping
- delete `rate` from `PropertyCreateSchema` and `PropertyUpdateSchema`, and from
  both admin handlers' `.set(...)` / `.values(...)` calls
- delete the `rate` column and both `rate` form fields from `pages.ts`; rename the
  `cost` column and both `cost` fields to label `"Lever"`

- [ ] **Step 7: Update the migrate mirror**

In `apps/migrate/src/pg/plugin-tables.ts`, delete `lastClaimedAt` and `rate` from
`propertiesPlugin` (and the `timestamp` import if it becomes unused).

In `apps/migrate/src/migrators/properties.ts`, delete `lastClaimedAt` and `rate`
from `values`, and replace the comment block above it with:

```ts
    // SPEC §1.2: PR_module is the implementing module's name -> plugin_id.
    // No lastClaimedAt or rate: income is paid by the consumer plugin, not
    // accrued from a clock, so there is no accrual epoch to stamp and nothing
    // for a migrated owner to inherit.
    //
    // PR_cost migrates verbatim into `cost`, which is the owner's lever on
    // both sides (V2's PR_cost is the bullet price / max bet).
```

In `apps/migrate/test/migrators/properties.test.ts`, remove `rate: 500n` from the
`toMatchObject` and delete both `lastClaimedAt` assertions.

- [ ] **Step 8: Delete the sell/claim cases from the route test**

In `apps/server/test/properties-routes.test.ts`, delete every `it(...)` that
drives `/sell` or `/claim` or asserts on `accrued`/`rate`, keeping the new
`has no claim or sell route` case from Step 1.

- [ ] **Step 9: Run the affected projects**

```bash
npx vitest run --project @gl3/server apps/server/test/properties-routes.test.ts \
  apps/server/test/admin-properties.test.ts apps/server/test/properties-events.test.ts
npx vitest run --project @gl3/migrate
npm run typecheck
```

Expected: PASS. `properties-events.test.ts` will fail on the deleted `sold` and
`income` events — delete those cases; Task 7 adds their replacements.

- [ ] **Step 10: Commit**

```bash
git add -A packages/plugins/properties apps/migrate apps/server/test vitest.workspace.ts
git commit -m "feat(properties)!: drop the accrual clock, cost becomes the owner's lever

rate and last_claimed_at are gone and so are the claim and sell routes: a
property earns what its consumer plugin pays it, as in V2. cost is zeroed and
reinterpreted as the owner-set lever the consumer reads."
```

---

### Task 6: `ownerAt` and `payOwner` — the consumer API

**Files:**
- Create: `packages/plugins/properties/src/api.ts`
- Modify: `packages/plugins/properties/src/index.ts` — re-export
- Test: `apps/server/test/properties-pay-owner.test.ts` (new)
- Modify: `vitest.workspace.ts` — add to the `@gl3/server` project's `include`

**Interfaces:**
- Consumes: `propertiesTable`, `playerStats` from `./schema.js` (Task 5 shape).
- Produces:
  ```ts
  export interface PropertyOwnership {
    propertyId: string;
    ownerId: string;
    lever: bigint | null;   // null = owner set none; consumer uses its own default
  }
  export function ownerAt(tx: PluginTx, pluginId: string, locationId: string): Promise<PropertyOwnership | null>;
  export function payOwner(tx: PluginTx, propertyId: string, amount: bigint, reason: string): Promise<bigint>;
  ```
  `payOwner` returns the amount actually moved (a debit is clamped). Task 9
  imports both from `@gl3/plugin-properties`.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/properties-pay-owner.test.ts`. Read
`apps/server/test/properties-lock-order.test.ts` first and reuse its `testDb`,
`runPluginMigrations` and seeding helpers verbatim — this file drives the plugin
without `bootTestServer`, so it must run the migrations itself:

```ts
import { describe, expect, it, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import propertiesPlugin, { ownerAt, payOwner } from "@gl3/plugin-properties";
import { propertiesTable } from "@gl3/plugin-properties/schema";
import { runPluginMigrations } from "../src/plugins/migrate.js";
import { createPluginCtx } from "../src/plugins/ctx.js";
// ...the rest of the imports this file's siblings use for testDb / seeding

describe("payOwner", () => {
  // seed: one location, one owner player with a known cash balance, one
  // property of type "bullets" owned by them.

  it("credits the owner and moves profit by the same amount", async () => {
    const moved = await ctx.transaction(async (tx) => {
      await tx.locks.location(locationId);
      await tx.locks.player([ownerId]);
      return payOwner(tx, propertyId, 5_000n, "test.credit");
    });
    expect(moved).toBe(5_000n);
    expect(await cashOf(ownerId)).toBe(startingCash + 5_000n);
    const [row] = await db.select().from(propertiesTable).where(eq(propertiesTable.id, propertyId));
    expect(row!.profit).toBe(5_000n);
  });

  it("debits the owner and drives profit negative", async () => {
    const moved = await ctx.transaction(async (tx) => {
      await tx.locks.location(locationId);
      await tx.locks.player([ownerId]);
      return payOwner(tx, propertyId, -2_000n, "test.debit");
    });
    expect(moved).toBe(-2_000n);
    const [row] = await db.select().from(propertiesTable).where(eq(propertiesTable.id, propertyId));
    expect(row!.profit).toBe(-2_000n);
  });

  it("clamps a debit larger than the owner's cash and moves profit by what was taken", async () => {
    // owner cash is exactly 1_000n here
    const moved = await ctx.transaction(async (tx) => {
      await tx.locks.location(locationId);
      await tx.locks.player([ownerId]);
      return payOwner(tx, propertyId, -9_999n, "test.overdraft");
    });
    expect(moved).toBe(-1_000n);
    expect(await cashOf(ownerId)).toBe(0n);
    const [row] = await db.select().from(propertiesTable).where(eq(propertiesTable.id, propertyId));
    expect(row!.profit).toBe(-1_000n); // never claims a loss the ledger did not take
  });

  it("is a no-op on an unowned property", async () => {
    const moved = await ctx.transaction(async (tx) => {
      await tx.locks.location(locationId);
      return payOwner(tx, unownedPropertyId, 5_000n, "test.credit");
    });
    expect(moved).toBe(0n);
  });
});

describe("ownerAt", () => {
  it("returns null for an unowned property", async () => {
    const found = await ctx.transaction((tx) => ownerAt(tx, "bullets", unownedLocationId));
    expect(found).toBeNull();
  });

  it("returns null lever when cost is zero", async () => {
    const found = await ctx.transaction((tx) => ownerAt(tx, "bullets", locationId));
    expect(found).toMatchObject({ propertyId, ownerId, lever: null });
  });

  it("returns the lever when the owner has set one", async () => {
    await db.update(propertiesTable).set({ cost: 42_000n }).where(eq(propertiesTable.id, propertyId));
    const found = await ctx.transaction((tx) => ownerAt(tx, "bullets", locationId));
    expect(found?.lever).toBe(42_000n);
  });
});
```

- [ ] **Step 2: Register the test file**

Add `"test/properties-pay-owner.test.ts"` to the `@gl3/server` project's `include`
array in `vitest.workspace.ts`, next to the existing `test/properties-*.test.ts`
entries around line 325.

- [ ] **Step 3: Run it to verify it fails**

```bash
npx vitest run --project @gl3/server apps/server/test/properties-pay-owner.test.ts
```

Expected: FAIL — `ownerAt` and `payOwner` are not exported from
`@gl3/plugin-properties`.

- [ ] **Step 4: Write the API**

Create `packages/plugins/properties/src/api.ts`:

```ts
import { and, eq, sql } from "drizzle-orm";
import type { PluginTx } from "@gl3/plugin-sdk";
import { propertiesTable, playerStats } from "./schema.js";

export interface PropertyOwnership {
  propertyId: string;
  ownerId: string;
  /**
   * The owner's lever: `cost` when non-zero, else `null`, meaning "the owner
   * has not set one — use your own default". V2 does exactly this
   * (`bullets.inc.php:86`: `if (!!$owner["cost"]) $this->setCost(...)`), and
   * it is why the manifest declares no default: bullets' fallback is the
   * location's own `bullet_cost`, which is per-location and admin-editable,
   * and a manifest constant could not express that.
   */
  lever: bigint | null;
}

/**
 * Who owns `pluginId`'s property in `locationId`, or null when nobody does or
 * no such row exists. V2's `Property::getOwnership()`.
 *
 * Read-only and unlocked: a consumer calls this to decide whether to pay
 * anyone at all. `payOwner` re-reads the row FOR UPDATE, so a concurrent
 * transfer between the two calls cannot pay the wrong player.
 */
export async function ownerAt(
  tx: PluginTx, pluginId: string, locationId: string,
): Promise<PropertyOwnership | null> {
  const [row] = await tx.db
    .select({
      id: propertiesTable.id,
      ownerPlayerId: propertiesTable.ownerPlayerId,
      cost: propertiesTable.cost,
    })
    .from(propertiesTable)
    .where(and(eq(propertiesTable.locationId, locationId), eq(propertiesTable.pluginId, pluginId)));
  if (row === undefined || row.ownerPlayerId === null) return null;
  return { propertyId: row.id, ownerId: row.ownerPlayerId, lever: row.cost > 0n ? row.cost : null };
}

/**
 * Credit (`amount > 0`) or debit (`amount < 0`) the property's owner and move
 * `profit` by the amount actually moved. Returns that amount — a debit is
 * clamped to the owner's cash, so `profit` never claims a loss the ledger did
 * not take. Returns 0n when the property is unowned or `amount` is 0n.
 *
 * V2's `Property::updateProfit()` plus the balance write its callers do by
 * hand; folded together here so a consumer cannot move one without the other.
 *
 * LOCK ORDER (rule 6). This takes `tx.locks.player([ownerId])`, which is a
 * no-op if the caller already holds that row. A consumer that also acts on a
 * DIFFERENT player (the buyer) MUST have taken both through ONE
 * `tx.locks.player([buyer, ownerId])` call before calling this — that helper
 * sorts and dedupes, and it is what makes owner-buys-from-own-shop safe
 * against a second player buying at the same moment. Locking the buyer first
 * and letting this take the owner second is an ABBA cycle.
 * Regression: `apps/server/test/properties-consumer-lock-order.test.ts`.
 */
export async function payOwner(
  tx: PluginTx, propertyId: string, amount: bigint, reason: string,
): Promise<bigint> {
  if (amount === 0n) return 0n;

  const [row] = await tx.db
    .select({ id: propertiesTable.id, ownerPlayerId: propertiesTable.ownerPlayerId })
    .from(propertiesTable)
    .where(eq(propertiesTable.id, propertyId))
    .for("update");
  if (row === undefined || row.ownerPlayerId === null) return 0n;

  const ownerId = row.ownerPlayerId;
  await tx.locks.player([ownerId]);

  let moved = amount;
  if (amount < 0n) {
    // Read under the lock taken above, so two concurrent debits cannot both
    // pass the affordability check.
    const [stats] = await tx.db
      .select({ cash: playerStats.cash })
      .from(playerStats)
      .where(eq(playerStats.playerId, ownerId));
    const cash = stats?.cash ?? 0n;
    const wanted = -amount;
    moved = -(cash < wanted ? cash : wanted);
  }
  if (moved === 0n) return 0n;

  await tx.economy.applyBalanceChange({ playerId: ownerId, amount: moved, kind: "cash", reason });
  await tx.db
    .update(propertiesTable)
    .set({ profit: sql`${propertiesTable.profit} + ${moved}` })
    .where(eq(propertiesTable.id, propertyId));

  return moved;
}
```

- [ ] **Step 5: Re-export from the plugin index**

At the top of `packages/plugins/properties/src/index.ts`, next to the existing
re-exports:

```ts
export { ownerAt, payOwner, type PropertyOwnership } from "./api.js";
export { propertiesTable } from "./schema.js";
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
npx vitest run --project @gl3/server apps/server/test/properties-pay-owner.test.ts
```

Expected: PASS, all nine cases.

- [ ] **Step 7: Commit**

```bash
git add packages/plugins/properties/src/api.ts packages/plugins/properties/src/index.ts \
        apps/server/test/properties-pay-owner.test.ts vitest.workspace.ts
git commit -m "feat(properties): ownerAt and payOwner for consumer plugins

V2's Property::getOwnership and updateProfit, folded so a consumer cannot move
a balance without moving the P&L. Debits clamp to the owner's cash so profit
never claims a loss the ledger did not take."
```

---

### Task 7: Buy, lever, transfer, drop, reset

**Files:**
- Modify: `packages/plugins/properties/src/index.ts`
- Test: `apps/server/test/properties-routes.test.ts`, `apps/server/test/properties-events.test.ts`

**Interfaces:**
- Consumes: `ctx.propertyTypes` (Task 3), the Task 5 table shape.
- Produces: five routes and four events. Task 10's web page calls all five.

- [ ] **Step 1: Write the failing tests**

Add to `apps/server/test/properties-routes.test.ts`, reusing that file's existing
boot and login helpers:

```ts
  it("buys an undeclared type with a 404", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/properties/buy", headers: playerHeaders,
      payload: { pluginId: "nope", locationId },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toBe("unknown_property_type");
  });

  it("refuses to buy in a location the player is not in", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/properties/buy", headers: playerHeaders,
      payload: { pluginId: "bullets", locationId: otherLocationId },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe("wrong_location");
  });

  it("creates the row on first purchase and charges the declared price", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/properties/buy", headers: playerHeaders,
      payload: { pluginId: "bullets", locationId },
    });
    expect(res.statusCode).toBe(200);
    const { propertyId } = res.json<{ propertyId: string }>();
    expect(propertyId).toBeTruthy();
    expect(await cashOf(playerId)).toBe(startingCash - 100_000_000n);
  });

  it("refuses a second buy of the same type in the same town", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/properties/buy", headers: playerHeaders,
      payload: { pluginId: "bullets", locationId },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe("already_owned");
  });

  it("refuses a buy the player cannot afford", async () => {
    // broke player, fresh location
    const res = await app.inject({
      method: "POST", url: "/api/properties/buy", headers: brokeHeaders,
      payload: { pluginId: "bullets", locationId: freshLocationId },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe("insufficient_funds");
  });

  it("sets the lever, refusing anything under the floor", async () => {
    const low = await app.inject({
      method: "POST", url: `/api/properties/${propertyId}/lever`, headers: playerHeaders,
      payload: { value: "9999" },
    });
    expect(low.statusCode).toBe(400);

    const ok = await app.inject({
      method: "POST", url: `/api/properties/${propertyId}/lever`, headers: playerHeaders,
      payload: { value: "12345" },
    });
    expect(ok.statusCode).toBe(204);
  });

  it("refuses a lever change by a non-owner with 404", async () => {
    const res = await app.inject({
      method: "POST", url: `/api/properties/${propertyId}/lever`, headers: otherPlayerHeaders,
      payload: { value: "12345" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toBe("not_owned");
  });

  it("transfers to another player and zeroes the lever", async () => {
    const res = await app.inject({
      method: "POST", url: `/api/properties/${propertyId}/transfer`, headers: playerHeaders,
      payload: { username: otherUsername },
    });
    expect(res.statusCode).toBe(204);
    const [row] = await db.select().from(propertiesTable).where(eq(propertiesTable.id, propertyId));
    expect(row!.ownerPlayerId).toBe(otherPlayerId);
    expect(row!.cost).toBe(0n); // V2 zeroes PR_cost on handover
  });

  it("transfers to an unknown player with 404", async () => {
    const res = await app.inject({
      method: "POST", url: `/api/properties/${propertyId}/transfer`, headers: otherPlayerHeaders,
      payload: { username: "nobody" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toBe("player_not_found");
  });

  it("drops a property with no refund", async () => {
    const before = await cashOf(otherPlayerId);
    const res = await app.inject({
      method: "POST", url: `/api/properties/${propertyId}/drop`, headers: otherPlayerHeaders,
    });
    expect(res.statusCode).toBe(204);
    expect(await cashOf(otherPlayerId)).toBe(before); // no refund: V2 DELETEs
    const [row] = await db.select().from(propertiesTable).where(eq(propertiesTable.id, propertyId));
    expect(row!.ownerPlayerId).toBeNull();
    expect(row!.cost).toBe(0n);
  });

  it("resets profit to zero without moving money", async () => {
    // re-bought and paid first by the enclosing setup
    const before = await cashOf(playerId);
    const res = await app.inject({
      method: "POST", url: `/api/properties/${propertyId}/reset`, headers: playerHeaders,
    });
    expect(res.statusCode).toBe(204);
    expect(await cashOf(playerId)).toBe(before);
    const [row] = await db.select().from(propertiesTable).where(eq(propertiesTable.id, propertyId));
    expect(row!.profit).toBe(0n);
  });
```

And in `apps/server/test/properties-events.test.ts`, replace the deleted
`sold`/`income` cases with `bought`, `dropped` and `transferred` cases, using
`awaitOwnEvent()` filtered by the acting player's id (rule 4) exactly as the
file's surviving `bought` case already does.

- [ ] **Step 2: Run them to verify they fail**

```bash
npx vitest run --project @gl3/server apps/server/test/properties-routes.test.ts \
  apps/server/test/properties-events.test.ts
```

Expected: FAIL — `/api/properties/buy` 404s (the current buy route is
`/api/properties/:id/buy`), and `/lever`, `/transfer`, `/drop`, `/reset` do not
exist.

- [ ] **Step 3: Replace the buy route**

In `packages/plugins/properties/src/index.ts`, replace `buyRoute` entirely:

```ts
const BuyBodySchema = z.object({
  pluginId: z.string().min(1).max(80),
  locationId: z.string().uuid(),
}).strict();

/**
 * V2's `method_own()`, which lived in each consumer module (bullets, blackjack)
 * as copy-pasted code. GL3 keeps it here once: the price comes from the
 * consumer's `providesProperties` declaration, so a new franchise needs no new
 * buy route.
 *
 * The row is created lazily on first purchase, as V2 does — the table ships
 * empty. V2's insert races (two concurrent first-buys make two rows, since its
 * only key is PR_id); here the location lock is taken first, so the two
 * serialise and the second sees the row the first inserted.
 */
const buyRoute = route({
  method: "POST",
  path: "/api/properties/buy",
  accessInJail: false,
  accessInHospital: true,
  body: BuyBodySchema,
  handler: async (ctx, { body }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    const decl = ctx.propertyTypes.get(body.pluginId);
    if (decl === null) throw new PluginError("unknown_property_type", 404);

    return ctx.transaction(async (tx) => {
      // RULE 6: location first, then player.
      await tx.locks.location(body.locationId);
      await tx.locks.player([player.id]);

      const [stats] = await tx.db
        .select({ locationId: playerStats.locationId, cash: playerStats.cash })
        .from(playerStats)
        .where(eq(playerStats.playerId, player.id));
      if (stats === undefined) throw new PluginError("no_location", 409);
      if (stats.locationId !== body.locationId) throw new PluginError("wrong_location", 409);
      if (stats.cash < decl.price) throw new PluginError("insufficient_funds", 409);

      const [existing] = await tx.db
        .select({ id: propertiesTable.id, ownerPlayerId: propertiesTable.ownerPlayerId })
        .from(propertiesTable)
        .where(and(
          eq(propertiesTable.locationId, body.locationId),
          eq(propertiesTable.pluginId, body.pluginId),
        ))
        .for("update");
      if (existing !== undefined && existing.ownerPlayerId !== null) {
        // Including when the caller already owns it — buying your own is the
        // same error, as in the shipped route.
        throw new PluginError("already_owned", 409);
      }

      await tx.economy.applyBalanceChange({
        playerId: player.id,
        amount: -decl.price,
        kind: "cash",
        reason: "properties.buy",
      });

      let propertyId: string;
      if (existing === undefined) {
        propertyId = uuidv7();
        await tx.db.insert(propertiesTable).values({
          id: propertyId,
          locationId: body.locationId,
          pluginId: body.pluginId,
          ownerPlayerId: player.id,
        });
      } else {
        propertyId = existing.id;
        // cost = 0: a new owner inherits no lever, matching V2's transfer().
        await tx.db
          .update(propertiesTable)
          .set({ ownerPlayerId: player.id, cost: 0n })
          .where(eq(propertiesTable.id, propertyId));
      }

      const [loc] = await tx.db
        .select({ name: locations.name })
        .from(locations)
        .where(eq(locations.id, body.locationId));

      await tx.events.publish({
        name: "bought",
        actorId: player.id,
        actorName: player.username,
        audience: { kind: "player", playerId: player.id },
        payload: {
          typeName: decl.name,
          locationName: loc?.name ?? "",
          price: decl.price.toString(),
        },
      });

      return { status: 200, body: { propertyId } };
    });
  },
});
```

Add `and` to the `drizzle-orm` import.

- [ ] **Step 4: Add a shared owner-gate helper and the four owner routes**

Still in `index.ts`, above the routes:

```ts
/**
 * Locks location → player, re-reads the row FOR UPDATE and verifies the caller
 * owns it. 404 for both "no such row" and "not yours" — 404-not-403 so a
 * property's existence is not probeable, the shipped convention.
 */
async function loadOwnedRow(
  tx: PluginTx, propertyId: string, playerId: string,
): Promise<{ id: string; locationId: string; pluginId: string; cost: bigint; profit: bigint }> {
  const [before] = await tx.db
    .select({ locationId: propertiesTable.locationId })
    .from(propertiesTable)
    .where(eq(propertiesTable.id, propertyId));
  if (before === undefined) throw new PluginError("property_not_found", 404);

  await tx.locks.location(before.locationId);
  await tx.locks.player([playerId]);

  const [row] = await tx.db
    .select({
      id: propertiesTable.id,
      locationId: propertiesTable.locationId,
      pluginId: propertiesTable.pluginId,
      ownerPlayerId: propertiesTable.ownerPlayerId,
      cost: propertiesTable.cost,
      profit: propertiesTable.profit,
    })
    .from(propertiesTable)
    .where(eq(propertiesTable.id, propertyId))
    .for("update");
  if (row === undefined) throw new PluginError("property_not_found", 404);
  if (row.ownerPlayerId !== playerId) throw new PluginError("not_owned", 404);
  return { id: row.id, locationId: row.locationId, pluginId: row.pluginId, cost: row.cost, profit: row.profit };
}
```

Import `PluginTx` as a type from `@gl3/plugin-sdk`. Then:

```ts
/** V2's `$100` floor on PR_cost, in GL3's cents. */
const LEVER_FLOOR = 10_000n;

const LeverBodySchema = z.object({
  value: z.string().regex(/^\d+$/, "nonnegative integer string"),
}).strict();

/** V2's `method_cost`: the owner sets the consumer's local price or limit. */
const leverRoute = route({
  method: "POST",
  path: "/api/properties/:id/lever",
  accessInJail: true,
  accessInHospital: true,
  params: PropertyParamsSchema,
  body: LeverBodySchema,
  handler: async (ctx, { params, body }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    const value = BigInt(body.value);
    if (value < LEVER_FLOOR) throw new PluginError("lever_too_low", 400);

    await ctx.transaction(async (tx) => {
      const row = await loadOwnedRow(tx, params.id, player.id);
      await tx.db.update(propertiesTable).set({ cost: value }).where(eq(propertiesTable.id, row.id));
    });
    return { status: 204 };
  },
});

const TransferBodySchema = z.object({ username: z.string().min(1).max(64) }).strict();

/**
 * V2's `method_transfer`. Zeroes the lever on handover, as V2 does.
 *
 * RULE 6: this is a player↔player pair. Both players go through ONE
 * `tx.locks.player([a, b])` call, which sorts and dedupes — that is what makes
 * A-transfers-to-B safe against B-transfers-to-A. `loadOwnedRow` has already
 * taken the caller's row; taking it again inside the pair call is a no-op.
 */
const transferRoute = route({
  method: "POST",
  path: "/api/properties/:id/transfer",
  accessInJail: false,
  accessInHospital: true,
  params: PropertyParamsSchema,
  body: TransferBodySchema,
  handler: async (ctx, { params, body }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    await ctx.transaction(async (tx) => {
      const row = await loadOwnedRow(tx, params.id, player.id);

      const [target] = await tx.db
        .select({ id: players.id, username: players.username })
        .from(players)
        .where(eq(players.username, body.username));
      if (target === undefined) throw new PluginError("player_not_found", 404);
      if (target.id === player.id) throw new PluginError("cannot_transfer_to_self", 409);

      await tx.locks.player([player.id, target.id]);

      await tx.db
        .update(propertiesTable)
        .set({ ownerPlayerId: target.id, cost: 0n })
        .where(eq(propertiesTable.id, row.id));

      const [loc] = await tx.db
        .select({ name: locations.name }).from(locations).where(eq(locations.id, row.locationId));
      const decl = ctx.propertyTypes.get(row.pluginId);

      await tx.events.publish({
        name: "transferred",
        actorId: player.id,
        actorName: player.username,
        audience: { kind: "player", playerId: target.id },
        payload: { typeName: decl?.name ?? row.pluginId, locationName: loc?.name ?? "" },
      });
    });
    return { status: 204 };
  },
});

/** V2's `method_drop`/`method_dropDo`: a DELETE with no refund. GL3 keeps the
 *  row and unowns it, so its lifetime P&L survives its owners. */
const dropRoute = route({
  method: "POST",
  path: "/api/properties/:id/drop",
  accessInJail: false,
  accessInHospital: true,
  params: PropertyParamsSchema,
  handler: async (ctx, { params }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    await ctx.transaction(async (tx) => {
      const row = await loadOwnedRow(tx, params.id, player.id);
      await tx.db
        .update(propertiesTable)
        .set({ ownerPlayerId: null, cost: 0n })
        .where(eq(propertiesTable.id, row.id));

      const [loc] = await tx.db
        .select({ name: locations.name }).from(locations).where(eq(locations.id, row.locationId));
      const decl = ctx.propertyTypes.get(row.pluginId);

      await tx.events.publish({
        name: "dropped",
        actorId: player.id,
        actorName: player.username,
        audience: { kind: "player", playerId: player.id },
        payload: { typeName: decl?.name ?? row.pluginId, locationName: loc?.name ?? "" },
      });
    });
    return { status: 204 };
  },
});

/** V2's `method_reset`: a stat reset. Moves no money and publishes nothing. */
const resetRoute = route({
  method: "POST",
  path: "/api/properties/:id/reset",
  accessInJail: true,
  accessInHospital: true,
  params: PropertyParamsSchema,
  handler: async (ctx, { params }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    await ctx.transaction(async (tx) => {
      const row = await loadOwnedRow(tx, params.id, player.id);
      await tx.db.update(propertiesTable).set({ profit: 0n }).where(eq(propertiesTable.id, row.id));
    });
    return { status: 204 };
  },
});
```

- [ ] **Step 5: Replace the event declarations and the manifest**

```ts
const boughtEvent = {
  name: "bought",
  payload: z.object({ typeName: z.string(), locationName: z.string(), price: z.string() }),
  describe: "{actorName} bought the {typeName} in {locationName} for {price}",
  invalidates: ["properties", "me"],
};

const droppedEvent = {
  name: "dropped",
  payload: z.object({ typeName: z.string(), locationName: z.string() }),
  describe: "{actorName} dropped the {typeName} in {locationName}",
  invalidates: ["properties", "me"],
};

const transferredEvent = {
  name: "transferred",
  payload: z.object({ typeName: z.string(), locationName: z.string() }),
  describe: "{actorName} transferred the {typeName} in {locationName} to you",
  invalidates: ["properties", "me"],
};

const seizedEvent = {
  name: "seized",
  payload: z.object({ typeName: z.string(), locationName: z.string() }),
  describe: "Your {typeName} in {locationName} was seized after your death",
  invalidates: ["properties", "me"],
};
```

Manifest:

```ts
  routes: [
    listRoute, buyRoute, leverRoute, transferRoute, dropRoute, resetRoute,
    adminListRoute, adminLocationsRoute, adminTypesRoute, adminCreateRoute, adminUpdateRoute,
  ],
  events: [boughtEvent, droppedEvent, transferredEvent, seizedEvent],
```

`seizedEvent` is declared here and published by Task 8.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npx vitest run --project @gl3/server apps/server/test/properties-routes.test.ts \
  apps/server/test/properties-events.test.ts apps/server/test/properties-lock-order.test.ts
```

Expected: PASS. `properties-lock-order.test.ts` drives the old `/buy` path — update
it to the new body-shaped route and keep its locations-first assertion.

- [ ] **Step 7: Commit**

```bash
git add packages/plugins/properties/src/index.ts apps/server/test/properties-routes.test.ts \
        apps/server/test/properties-events.test.ts apps/server/test/properties-lock-order.test.ts
git commit -m "feat(properties): buy by type, plus lever, transfer, drop and reset

Buy moves to POST /api/properties/buy with {pluginId, locationId} and charges
the price the consumer plugin declares, creating the row lazily as V2 does.
The other four are V2's propertyManagement methods: set the lever, hand over,
walk away with no refund, reset the P&L counter."
```

---

### Task 8: Seizure on death

**Files:**
- Create: `packages/plugins/properties/src/seizure.ts`
- Modify: `packages/plugins/properties/src/index.ts` — `filters: [seizeOnKill]`
- Modify: `packages/plugins/properties/package.json` — `@gl3/plugin-combat` dependency
- Modify: `packages/plugins/properties/tsconfig.json` — reference combat
- Test: `apps/server/test/properties-seizure.test.ts` (new)
- Modify: `vitest.workspace.ts`

**Interfaces:**
- Consumes: `killResolved` and `KillResolved` from `@gl3/plugin-combat`.
- Produces: a `FilterSubscription` on the manifest. Nothing imports it.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/properties-seizure.test.ts`, modelled on the existing
bounties kill-sweep test (find it with
`grep -rln "killResolved" apps/server/test` and reuse its setup):

```ts
  it("disowns every property the victim owned, game-wide", async () => {
    // victim owns two properties, in two different locations
    await ctx.filters.apply(killResolved, { killerId, victimId });

    const rows = await db.select().from(propertiesTable);
    for (const row of rows) {
      expect(row.ownerPlayerId).toBeNull();
      expect(row.cost).toBe(0n);
    }
  });

  it("does not transfer anything to the killer", async () => {
    const rows = await db.select().from(propertiesTable);
    expect(rows.some((r) => r.ownerPlayerId === killerId)).toBe(false);
  });

  it("leaves profit alone — it is the row's lifetime P&L across owners", async () => {
    const [row] = await db.select().from(propertiesTable).where(eq(propertiesTable.id, propertyId));
    expect(row!.profit).toBe(seededProfit);
  });

  it("publishes one seized event per property, to the victim", async () => {
    const event = await awaitOwnEvent(victimId, (e) => e.type === "plugin.event" && e.name === "seized");
    expect(event).toBeDefined();
  });

  it("is a no-op when the victim owned nothing", async () => {
    await expect(
      ctx.filters.apply(killResolved, { killerId, victimId: ownerlessPlayerId }),
    ).resolves.toBeDefined();
  });
```

- [ ] **Step 2: Register the test file**

Add `"test/properties-seizure.test.ts"` to the `@gl3/server` project's `include`
in `vitest.workspace.ts`.

- [ ] **Step 3: Run it to verify it fails**

```bash
npx vitest run --project @gl3/server apps/server/test/properties-seizure.test.ts
```

Expected: FAIL — nothing subscribes to `killResolved`, so the properties keep
their owner.

- [ ] **Step 4: Add the dependency edge**

In `packages/plugins/properties/package.json`, add `"@gl3/plugin-combat": "*"` to
`dependencies`. In `packages/plugins/properties/tsconfig.json`, add a
`{ "path": "../combat" }` reference alongside the existing ones. Then:

```bash
npm install
```

`vitest.workspace.ts` already carries a `srcAliases` entry for both packages, and
`Dockerfile.server` already carries the five COPY lines for each — adding a
dependency between two packages that both already ship adds no new registration
site. Verify:

```bash
grep -c "packages/plugins/properties" Dockerfile.server   # expect 5
grep -c "packages/plugins/combat" Dockerfile.server       # expect 5
```

- [ ] **Step 5: Write the subscription**

Create `packages/plugins/properties/src/seizure.ts`:

```ts
import { eq } from "drizzle-orm";
import { on } from "@gl3/plugin-sdk";
import { killResolved } from "@gl3/plugin-combat";
import { propertiesTable, locations } from "./schema.js";

/**
 * V2's `propertyManagement.hooks.php` `userKilled` hook, with one deliberate
 * change. V2 transfers every property the victim owned TO THE SHOOTER. GL3
 * does not: the shooter already takes the kill's payout, and a franchise on
 * top compounds a winner's lead. Instead the properties are seized — unowned,
 * back on the market at the declared price for anyone to buy.
 *
 * `profit` is left alone: it is that ROW's lifetime P&L across owners, not the
 * victim's, and zeroing it would erase a fact nobody asked to erase.
 *
 * Filters run OUTSIDE the caller's transaction (SDK rule), so this opens its
 * own. Idempotent by shape — `WHERE owner_player_id = victim` matches nothing
 * on a second run — and crash-safe without a queue: if it never runs, the
 * victim keeps the property and the next kill seizes it. Combat logs and
 * swallows a subscriber failure, so a failed seizure never undoes a kill.
 */
export const seizeOnKill = on(killResolved, async (ctx, value) => {
  await ctx.transaction(async (tx) => {
    // No location lock: this takes no player lock and no balance moves, so it
    // holds exactly one kind of row and cannot be half of a deadlock cycle.
    // Do not grow a balance change in here without revisiting that.
    const seized = await tx.db
      .update(propertiesTable)
      .set({ ownerPlayerId: null, cost: 0n })
      .where(eq(propertiesTable.ownerPlayerId, value.victimId))
      .returning({ id: propertiesTable.id, pluginId: propertiesTable.pluginId, locationId: propertiesTable.locationId });
    if (seized.length === 0) return;

    for (const row of seized) {
      const [loc] = await tx.db
        .select({ name: locations.name }).from(locations).where(eq(locations.id, row.locationId));
      const decl = ctx.propertyTypes.get(row.pluginId);
      await tx.events.publish({
        name: "seized",
        actorId: value.victimId,
        actorName: "",
        audience: { kind: "player", playerId: value.victimId },
        payload: { typeName: decl?.name ?? row.pluginId, locationName: loc?.name ?? "" },
      });
    }

    await tx.notify(
      value.victimId,
      `${seized.length} of your properties were seized after your death.`,
    );
  });
  return value;
});
```

If `actorName: ""` renders badly in `describe`, look up the victim's username the
way `bounties`' `claimOnKill` does (a `players` select inside the same
transaction) and pass it — the event's `describe` string starts with "Your", so
the actor name is not interpolated, but check the rendered copy before deciding.

- [ ] **Step 6: Register the subscription**

In `packages/plugins/properties/src/index.ts`, import `seizeOnKill` and add
`filters: [seizeOnKill],` to the manifest.

- [ ] **Step 7: Run the test to verify it passes**

```bash
npx vitest run --project @gl3/server apps/server/test/properties-seizure.test.ts \
  apps/server/test/combat-lock-order.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/plugins/properties apps/server/test/properties-seizure.test.ts vitest.workspace.ts \
        package-lock.json
git commit -m "feat(properties): seize a dead player's properties

Subscribes to combat.killResolved, V2's userKilled hook. V2 hands the victim's
properties to the shooter; GL3 unowns them instead — the shooter already takes
the payout, and a franchise on top compounds a winner's lead."
```

---

### Task 9: `bullets` becomes the first consumer

**Files:**
- Modify: `packages/plugins/bullets/src/index.ts`
- Modify: `packages/plugins/bullets/package.json`, `packages/plugins/bullets/tsconfig.json`
- Test: `apps/server/test/bullets-property.test.ts` (new)
- Test: `apps/server/test/properties-consumer-lock-order.test.ts` (new)
- Modify: `vitest.workspace.ts`

**Interfaces:**
- Consumes: `ownerAt`, `payOwner` from `@gl3/plugin-properties` (Task 6).
- Produces: nothing later tasks import.

- [ ] **Step 1: Write the failing tests**

Create `apps/server/test/bullets-property.test.ts`:

```ts
  it("charges the location price when the factory is unowned", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/bullets/buy", headers: buyerHeaders, payload: { quantity: 10 },
    });
    expect(res.statusCode).toBe(200);
    expect(await cashOf(buyerId)).toBe(startingCash - locationPrice * 10n);
  });

  it("charges the owner's lever when one is set", async () => {
    // factory owned, lever = 999n
    const res = await app.inject({
      method: "POST", url: "/api/bullets/buy", headers: buyerHeaders, payload: { quantity: 10 },
    });
    expect(res.statusCode).toBe(200);
    expect(await cashOf(buyerId)).toBe(startingCash - 999n * 10n);
  });

  it("falls back to the location price when the owner set no lever", async () => {
    // factory owned, cost = 0
    const res = await app.inject({
      method: "POST", url: "/api/bullets/buy", headers: buyerHeaders, payload: { quantity: 10 },
    });
    expect(res.statusCode).toBe(200);
    expect(await cashOf(buyerId)).toBe(startingCash - locationPrice * 10n);
  });

  it("pays the owner half the sale and moves the property's profit", async () => {
    const ownerBefore = await cashOf(ownerId);
    await app.inject({
      method: "POST", url: "/api/bullets/buy", headers: buyerHeaders, payload: { quantity: 10 },
    });
    const total = 999n * 10n;
    expect(await cashOf(ownerId)).toBe(ownerBefore + total / 2n);
    const [row] = await db.select().from(propertiesTable).where(eq(propertiesTable.id, propertyId));
    expect(row!.profit).toBe(total / 2n);
  });

  it("lets the owner buy from their own factory", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/bullets/buy", headers: ownerHeaders, payload: { quantity: 10 },
    });
    expect(res.statusCode).toBe(200);
    // Paid 999*10 and received half of it back.
    expect(await cashOf(ownerId)).toBe(ownerCashBefore - 999n * 10n + (999n * 10n) / 2n);
  });
```

Create `apps/server/test/properties-consumer-lock-order.test.ts`, modelled on
`apps/server/test/combat-lock-order.test.ts` (read it first — it is the
player↔player precedent and its `Promise.all` shape is what proves the pair):

```ts
  it("survives A-buys-from-B's-factory racing B-buys-from-A's-factory", async () => {
    // Two locations, each with a bullets factory; A owns one, B owns the other,
    // and each player stands in the OTHER's town. Both buy at once: A's buy
    // touches (A, B) and B's buy touches (B, A) — an ABBA pair unless both go
    // through one sorted tx.locks.player call.
    const [first, second] = await Promise.all([
      app.inject({ method: "POST", url: "/api/bullets/buy", headers: aHeaders, payload: { quantity: 1 } }),
      app.inject({ method: "POST", url: "/api/bullets/buy", headers: bHeaders, payload: { quantity: 1 } }),
    ]);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
  });

  it("proves the test can fail: locking the buyer alone deadlocks", async () => {
    // Skipped by default. Un-skip after changing bullets' buy route to
    // `tx.locks.player([player.id])` only, and confirm this test goes red with
    // a 40P01 deadlock or a hung request. A green concurrency test whose
    // participants agree on ordering by construction proves nothing
    // (CLAUDE.md rule 6 corollary).
  });
```

- [ ] **Step 2: Register both test files**

Add `"test/bullets-property.test.ts"` and
`"test/properties-consumer-lock-order.test.ts"` to the `@gl3/server` project's
`include` in `vitest.workspace.ts`.

- [ ] **Step 3: Run them to verify they fail**

```bash
npx vitest run --project @gl3/server apps/server/test/bullets-property.test.ts \
  apps/server/test/properties-consumer-lock-order.test.ts
```

Expected: FAIL — bullets ignores property ownership entirely, so the lever cases
charge the location price and the owner receives nothing.

- [ ] **Step 4: Add the dependency edge**

In `packages/plugins/bullets/package.json`, add `"@gl3/plugin-properties": "*"` to
`dependencies`. In `packages/plugins/bullets/tsconfig.json`, add
`{ "path": "../properties" }` to `references`. Then `npm install`. Verify the
Dockerfile already carries bullets' five COPY lines:

```bash
grep -c "packages/plugins/bullets" Dockerfile.server   # expect 5
```

- [ ] **Step 5: Wire the franchise into the buy route**

In `packages/plugins/bullets/src/index.ts`, add the import:

```ts
import { ownerAt, payOwner } from "@gl3/plugin-properties";
```

and replace the block from the location lock through the balance change:

```ts
      await tx.locks.location(locationId);

      const [location] = await tx.db.select().from(locations).where(eq(locations.id, locationId));
      if (!location) throw new PluginError("no_location", 409);
      if (location.bulletStock < quantity) {
        throw new PluginError("insufficient_stock", 409, { available: location.bulletStock });
      }

      // V2: the factory's owner sets the bullet price and takes half the sale
      // (bullets.inc.php:86 and :225). A null lever means the owner set none,
      // so the location's admin-editable price stands — V2's
      // `if (!!$owner["cost"])`.
      const franchise = await ownerAt(tx, "bullets", locationId);
      const unitCost = franchise?.lever ?? location.bulletCost;
      const cost = unitCost * BigInt(quantity);

      // RULE 6, player↔player half: buyer and owner go through ONE sorted
      // tx.locks.player call BEFORE either balance moves. payOwner takes the
      // owner's lock itself, but taking it second — after the buyer's —
      // would be an ABBA cycle against a simultaneous buy in the other
      // direction. Regression:
      // apps/server/test/properties-consumer-lock-order.test.ts.
      await tx.locks.player(
        franchise === null || franchise.ownerId === player.id
          ? [player.id]
          : [player.id, franchise.ownerId],
      );

      let cash: bigint;
      try {
        cash = await tx.economy.applyBalanceChange({
          playerId: player.id,
          amount: -cost,
          kind: "cash",
          reason: "bullets.purchase",
          refId: location.id,
        });
      } catch (error) {
        if (error instanceof InsufficientFundsError) {
          throw new PluginError("insufficient_funds", 409);
        }
        throw error;
      }

      if (franchise !== null) {
        await payOwner(tx, franchise.propertyId, cost / 2n, "properties.bullets");
      }
```

Everything below (stock decrement, `playerStats` bullets update, the
`bullets.purchased` event, the response body) stays exactly as it is. The event's
`cash` field now reflects the lever price, which is correct.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npx vitest run --project @gl3/server apps/server/test/bullets-property.test.ts \
  apps/server/test/properties-consumer-lock-order.test.ts apps/server/test/bullets.test.ts \
  apps/server/test/travel-lock-order.test.ts
```

Expected: PASS. `bullets.test.ts` is the port-fidelity proof and must stay green —
an unowned factory behaves exactly as before.

- [ ] **Step 7: Prove the lock-order test can fail**

Temporarily change the `tx.locks.player(...)` call to `tx.locks.player([player.id])`
and re-run `properties-consumer-lock-order.test.ts`. Record the failure (a
`40P01 deadlock detected` or a hung request) in the commit body, then revert the
change. A green concurrency test that was never shown red proves nothing.

- [ ] **Step 8: Commit**

```bash
git add packages/plugins/bullets apps/server/test/bullets-property.test.ts \
        apps/server/test/properties-consumer-lock-order.test.ts vitest.workspace.ts package-lock.json
git commit -m "feat(bullets): bullet factories are franchises

The owner sets the price per bullet and takes half of every sale, as V2 does.
An unowned factory behaves exactly as before. Buyer and owner are locked
through one sorted tx.locks.player call — proven by deliberately breaking it."
```

---

### Task 10: Web page and shared DTO

**Files:**
- Modify: `packages/shared/src/dto/properties.ts`
- Modify: `apps/web/src/api/queries.ts`
- Modify: `apps/web/src/pages/Properties.tsx`
- Test: `apps/web/test/properties-page.test.ts`

**Interfaces:**
- Consumes: the Task 7 route surface and the Task 5 list-route body.
- Produces: `PropertyRow` with `{ id, locationId, locationName, pluginId, typeName, price, leverLabel, ownerName, lever, profit }`.

- [ ] **Step 1: Write the failing test**

In `apps/web/test/properties-page.test.ts`, replace the `rowAction` cases:

```ts
const base = {
  id: "p1", locationId: "l1", locationName: "Brooklyn", pluginId: "bullets",
  typeName: "Bullet Factory", price: "100000000", leverLabel: "Price per bullet",
  ownerName: "—", lever: "", profit: "",
};

it("offers Buy on an unowned, installed type", () => {
  expect(rowAction(base, "vito")).toEqual({ kind: "buy", price: "100000000" });
});

it("offers nothing on an unowned type whose plugin is not installed", () => {
  expect(rowAction({ ...base, price: "" }, "vito")).toEqual({ kind: "none" });
});

it("offers the owner tools on your own row", () => {
  expect(rowAction({ ...base, ownerName: "vito", lever: "500", profit: "-20" }, "vito"))
    .toEqual({ kind: "owned", lever: "500", profit: "-20", leverLabel: "Price per bullet" });
});

it("offers nothing on someone else's row", () => {
  expect(rowAction({ ...base, ownerName: "sonny" }, "vito")).toEqual({ kind: "none" });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run --project @gl3/web apps/web/test/properties-page.test.ts
```

Expected: FAIL — `rowAction` returns `{ kind: "owned", accrued }` and the fixture
object no longer typechecks against `PropertyRow`.

- [ ] **Step 3: Update the shared DTO**

Replace `packages/shared/src/dto/properties.ts`:

```ts
import { z } from "zod";

/**
 * Mirrors the plugin's GET /api/properties rows — every value a string.
 *
 * `price` is "" when the row's type is not declared by any installed plugin:
 * there is no price, so the row is not buyable. `lever` and `profit` are ""
 * for anyone who is not the owner — the lever and the P&L are the owner's
 * business only.
 */
export const PropertyRowSchema = z.object({
  id: z.string(),
  locationId: z.string(),
  locationName: z.string(),
  pluginId: z.string(),
  typeName: z.string(),
  price: z.string(),
  leverLabel: z.string(),
  ownerName: z.string(),
  lever: z.string(),
  profit: z.string(),
});
export type PropertyRow = z.infer<typeof PropertyRowSchema>;

export const PropertyListResponseSchema = z.object({ rows: z.array(PropertyRowSchema) });
export type PropertyListResponse = z.infer<typeof PropertyListResponseSchema>;
```

- [ ] **Step 4: Replace the mutation hooks**

In `apps/web/src/api/queries.ts`, delete `useBuyProperty`, `useClaimProperty` and
`useSellProperty` and add five hooks in their place. Follow the file's existing
mutation shape exactly (same `useMutation` wrapper, same invalidation keys as the
deleted hooks used):

```ts
export function useBuyProperty() {
  // POST /api/properties/buy with { pluginId, locationId }
}
export function useSetLever() {
  // POST /api/properties/:id/lever with { value }
}
export function useTransferProperty() {
  // POST /api/properties/:id/transfer with { username }
}
export function useDropProperty() {
  // POST /api/properties/:id/drop
}
export function useResetProperty() {
  // POST /api/properties/:id/reset
}
```

Write each out fully in the file's own idiom — the comments above are the
contract, not the implementation.

- [ ] **Step 5: Update the page**

In `apps/web/src/pages/Properties.tsx`, replace `rowAction`:

```ts
export function rowAction(
  row: PropertyRow,
  viewerUsername: string | undefined,
):
  | { kind: "buy"; price: string }
  | { kind: "owned"; lever: string; profit: string; leverLabel: string }
  | { kind: "none" } {
  if (viewerUsername !== undefined && row.ownerName === viewerUsername) {
    return { kind: "owned", lever: row.lever, profit: row.profit, leverLabel: row.leverLabel };
  }
  // "" price means the row's type is not installed — nothing to buy.
  if (row.ownerName === "—" && row.price !== "") return { kind: "buy", price: row.price };
  return { kind: "none" };
}
```

and rewrite the row rendering: show `typeName` where `pluginId` was, `<Money>` the
`price` on a buy row, and on an owned row render a lever input labelled
`leverLabel` with a Set button, the P&L, and Transfer / Drop / Reset buttons.
Drop the `rate` and `accrued` spans and the Claim / Sell buttons. Buy now posts
`{ pluginId: row.pluginId, locationId: row.locationId }`, not `row.id`.

- [ ] **Step 6: Run the web project**

```bash
npx vitest run --project @gl3/web
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/dto/properties.ts apps/web/src apps/web/test/properties-page.test.ts
git commit -m "feat(web): properties page shows franchises, not coupons

Type name and declared price replace rate and accrued; an owner gets a lever
input, their P&L, and Transfer / Drop / Reset. Buy posts a type and a location
rather than a row id."
```

---

### Task 11: Publish, document, and gate

**Files:**
- Modify: `packages/shared/package.json`, `packages/plugin-sdk/package.json`
- Modify: `CLAUDE.md`, `docs/STATUS.md`

**Interfaces:**
- Consumes: everything.
- Produces: `@gl3/shared@0.1.5` and `@gl3/plugin-sdk@0.1.1` on `npm.gl3.dev`.

- [ ] **Step 1: Bump both versions**

`packages/shared/package.json`: `0.1.4` → `0.1.5`.
`packages/plugin-sdk/package.json`: `0.1.0` → `0.1.1`.

Per spec §5, `@gl3/shared`'s change to `PropertyRowSchema` is breaking in shape
but ships as a patch: under `0.x` a minor bump invalidates every
`"peerDependencies": { "@gl3/plugin-sdk": "^0.1.0" }` range in the wild, and no
external consumer of these two symbols exists.

- [ ] **Step 2: Run the full suite, bare, and read the exit code**

```bash
export DATABASE_URL=postgres://gl3:gl3@localhost:5432/gl3
export REDIS_URL=redis://localhost:6379
export MYSQL_ADMIN_URL=$(grep MYSQL_ADMIN_URL .env.example | cut -d= -f2-)
npm run verify > /tmp/verify.log 2>&1; echo "exit=$?"
```

Expected: `exit=0`. Any non-zero exit is a failure **even when every test
passed** — an unhandled rejection makes vitest exit non-zero while printing a
green summary. Do not pipe the run through `grep` or `tail`; that discards npm's
exit status.

This is the run that catches what no scoped run can. In particular:
`apps/server/test/schema.test.ts` reads `pg_catalog` and imports nothing from any
migration. Every migration in this plan is a **plugin** migration and its census
counts only core-created objects in `public`, so it should be unaffected — but
that is a prediction, and this run is what tests it. If its counts moved, restate
them and extend its comment block; never loosen the assertion.

- [ ] **Step 3: Build and publish, `@gl3/shared` first**

```bash
npm run build --workspace @gl3/shared
npm publish --workspace @gl3/shared --registry https://npm.gl3.dev
npm run build --workspace @gl3/plugin-sdk
npm publish --workspace @gl3/plugin-sdk --registry https://npm.gl3.dev
```

`@gl3/shared` goes first: `pages.ts` imports *values* from it, not only types.
`files` in both manifests is load-bearing — `dist/` is gitignored, and without it
npm publishes a package with no build output. Confirm both landed:

```bash
npm view @gl3/shared versions --registry https://npm.gl3.dev
npm view @gl3/plugin-sdk versions --registry https://npm.gl3.dev
```

- [ ] **Step 4: Update `CLAUDE.md`**

In the *Current state* section, after the rounds paragraph, add a paragraph
recording: `plugin_id` is live; the key is `(location_id, plugin_id)`;
income is consumer-paid and `rate`/`last_claimed_at` are gone; `cost` is the
owner's lever; `bullets` is the first consumer and the second plugin→plugin
dependency edge after `bounties`→`combat`; seizure disowns rather than
transferring; and the M4 `PR_owner` defect is fixed.

In the *Conventions* section, update the registry line to read
`@gl3/shared` `0.1.1` through `0.1.5` and `@gl3/plugin-sdk` `0.1.0`, `0.1.1`.

Add to the *six rules* section's rule 6 caller list:
`test/properties-consumer-lock-order.test.ts` as the second player↔player
regression after combat's.

Update the suite counts (`npm run verify`'s final summary from Step 2).

- [ ] **Step 5: Update `docs/STATUS.md`**

Add a `properties (franchises)` section in the same shape as the existing cluster
sections: what shipped, the three phases, the spec path, the plan path, and the
two deliberate deviations from V2 (seizure disowns instead of transferring; drop
has no refund).

- [ ] **Step 6: Re-run verify after the doc edits**

```bash
npm run verify > /tmp/verify.log 2>&1; echo "exit=$?"
```

Expected: `exit=0`.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/package.json packages/plugin-sdk/package.json CLAUDE.md docs/STATUS.md
git commit -m "docs: @gl3/shared@0.1.5 and @gl3/plugin-sdk@0.1.1 are published

Records the properties franchise cluster: plugin_id is live, the key is
(location_id, plugin_id), income is consumer-paid, and bullets is the first
consumer."
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: §0/§1 Phase 0 → Task 1;
§2.1 → Task 2; §2.2/§2.3 → Task 3; §2.4 → Task 4; §3.1 → Task 5; §3.2 → Task 6;
§3.3 → Task 7; §3.4 → Task 8; §3.5 events → Tasks 7 and 8; §3.6 → Task 9; §4 →
Tasks 4 and 10; §5 → Task 11; §6 testing table → the test file created or
modified in each task; §7 risks → the release-note bullets in Task 11 Step 5.

**Two spec items deliberately relocated, both recorded above:** the registry's
visibility (spec §2.2 amended in Task 3 Step 7 rather than the plan diverging),
and `bullets`' `providesProperties` declaration, which lands in Task 4 rather than
Task 9 because Task 4's admin test needs a declared type to select.

**Type consistency.** `PropertyTypeDecl` fields (`id`, `name`, `price`,
`leverLabel`) are identical in Tasks 2, 3, 4, 7, 9. `PropertyOwnership`
(`propertyId`, `ownerId`, `lever`) is identical in Tasks 6 and 9. `payOwner`
returns `Promise<bigint>` in Task 6 and Task 9 ignores the return, which is
allowed. `ctx.propertyTypes.get` returns `PropertyTypeDecl | null` — never
`undefined` — and every call site tests against `null`.
