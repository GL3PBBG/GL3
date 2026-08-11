# Item Economy (Location Shop) and Inventory/Shop/Combat/Hospital UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give players a way to buy items — a per-location shop inside the existing `inventory` plugin — and make the item and combat loop playable from a browser through four new pages (`/inventory`, `/shop`, `/combat`, `/hospital`).

**Architecture:** The shop is not a new plugin package. It lives inside `packages/plugins/inventory`, in its own modules (`shop.ts`, `shop-schema.ts`), owning one plugin-owned table `p_inventory_shop_stock` with no foreign keys. `GET /api/combat/targets` is added to `packages/plugins/combat` because it evaluates combat's own legality rules and settings. The web layer follows the existing hand-written-page pattern (`apps/web/src/pages/*.tsx` + hooks in `api/queries.ts` + nav in `components/Shell.tsx`); no plugin page schema is involved.

**Tech Stack:** TypeScript (strict, ESM), `@gl3/plugin-sdk`, Drizzle ORM, Postgres 16, Redis, Fastify, zod, React + react-query + react-router, vitest against real Postgres/Redis.

**Spec:** `docs/superpowers/specs/2026-08-12-item-economy-and-inventory-ui-design.md`

---

## Global Constraints

Every task's requirements implicitly include this section.

- **TypeScript strict. No `any` in `packages/*`** — none, not even a cast. In `apps/*` prefer `unknown` plus a zod parse, and type guards over casts.
- **ESM only**; relative imports carry a `.js` extension despite `.ts` sources.
- **Zod-validates every external boundary** — HTTP bodies, route params, WS frames both directions, bus messages.
- **Money is `bigint`** in Postgres and TypeScript, and crosses the wire as a **decimal string** (`MoneySchema`). Never a JSON number.
- **Bigint column defaults** must be written `` .default(sql`0`) ``, never `.default(0n)` — drizzle-kit's serialiser crashes on `BigInt`.
- **Every balance movement goes through `applyBalanceChange`** (CLAUDE.md rule 3). `sum(ledger) == balance` is enforced by `test/economy-invariant.test.ts`.
- **A foreign key is a lock** (CLAUDE.md rule 6). Locations are locked before players. The only `FOR UPDATE` sites in the codebase are `player_stats`, `locations` and `gangs`.
- **Publish events only after the transaction commits** (rule 5). Inside a plugin, `tx.events.publish` is buffered by the SDK and flushed post-commit — that satisfies the rule.
- **Never check-then-act on Redis** (rule 2).
- **Tests asserting on `game:events` must filter by their own `actorId`** (rule 4) — use `awaitOwnEvent()` from `test/helpers/events.ts`.
- **Integration tests run against real Postgres and Redis.** No mocks for DB, queue or bus paths, ever.
- **Never run `FLUSHALL`/`FLUSHDB`.** Redis is shared across every test file and concurrent agent.
- **Never run two full test suites at once.** Do not raise `maxWorkers` above 6.
- **Conventional Commits.**
- **Verification is the exit code, not the summary:**
  ```bash
  npm run verify > /tmp/verify.log 2>&1; echo "exit=$?"
  ```
  Also run `npx tsc --build --force apps/server/tsconfig.json` (the command the image build runs).
- **No new plugin package.** `@gl3/plugin-inventory` and `@gl3/plugin-combat` are already registered in `apps/server/package.json`, both tsconfigs, `vitest.workspace.ts` `srcAliases`, `plugins/core-plugins.ts`, and `Dockerfile.server`. No registration site changes. `grep -c "packages/plugins/inventory" Dockerfile.server` must still report 5.

## Deviations from the spec, and why

Three, all discovered during reconnaissance. They are deliberate and are the authority where they conflict with the spec text.

1. **The seed is a second migration, `0002_shop_stock_seed`.** Spec §4.2 says the migration "seeds stock in the same statement that creates the table". That is not implementable: `runPluginMigrations` (`apps/server/src/plugins/migrate.ts:45`) issues exactly one `tx.execute(sql.raw(migration.sql))` per declared migration, and `postgres.js`'s `unsafe()` rejects a multi-statement string unless `.simple()` is used. The only existing precedent (`examples/hello-plugin`) is a single statement. So: `0001_shop_stock` is the `CREATE TABLE`, `0002_shop_stock_seed` is the `INSERT ... SELECT`. Everything the spec says about the seed (joins by name, no-op where seeds have not run, records itself and will not retry) is unchanged.
2. **`GET /api/combat/targets` returns `reason: null` when attackable**, rather than omitting the field. Spec §6 says "absent". A nullable field is friendlier to both zod and `exactOptionalPropertyTypes`, and the DTO stays a closed union plus `null`.
3. **The shared DTO types `effects` as `z.unknown()`.** `readEffects` returns `unknown` by design (it passes an unrecognised `item_type` through untouched), and the already-shipped `GET /api/inventory` contract does the same. Narrowing it in the DTO would mean changing a shipped route. The web side pulls numeric fields out through a small tested helper instead.

---

## File Structure

**Server — `packages/plugins/inventory`**
- Create `src/shop-schema.ts` — the Drizzle mirror of `p_inventory_shop_stock`. One responsibility: table shape. (No `locations` mirror is needed: the handler locks that row through `tx.locks.location`, which takes an id, and never selects from it.)
- Create `src/migrations.ts` — the two migration literals. Keeps ~30 lines of SQL out of `index.ts`.
- Create `src/shop.ts` — `shopListRoute` and `shopBuyRoute`, plus the `purchased` event declaration.
- Modify `src/schema.ts` — `playerStats` gains `locationId`.
- Modify `src/index.ts` — manifest gains `basePaths` entry, `tables`, `migrations`, `events`, and the two routes.

**Server — `packages/plugins/combat`**
- Modify `src/schema.ts` — `ranks` gains `name`.
- Modify `src/index.ts` — adds `targetsRoute` and registers it.

**Shared — `packages/shared/src`**
- Create `dto/inventory.ts`, `dto/shop.ts`, `dto/combat.ts`, `dto/hospital.ts`.
- Modify `index.ts` — four `export * from` lines.

**Web — `apps/web/src`**
- Create `pages/Inventory.tsx`, `pages/Shop.tsx`, `pages/Combat.tsx`, `pages/Hospital.tsx`.
- Create `lib/effects.ts` — the numeric-field reader for `unknown` effects, with its own test.
- Modify `api/keys.ts`, `api/queries.ts`, `ws/invalidation.ts`, `lib/errors.ts`, `App.tsx`, `components/Shell.tsx`.

**Tests — `apps/server/test`**
- Create `shop.test.ts`, `shop-concurrency.test.ts`.
- Modify `plugin-migrate.test.ts`, `combat.test.ts`, `economy-invariant.test.ts`.
- Modify `vitest.workspace.ts` — the two new files must be listed in the `@gl3/server` project's `include`.

**Tests — `apps/web/test`**
- Create `effects.test.ts`. Modify `invalidation.test.ts`, `errors.test.ts`.

**Docs**
- Modify `docs/STATUS.md`, `CLAUDE.md`.

---

### Task 1: The `p_inventory_shop_stock` table, its two migrations, and the schema mirrors

**Files:**
- Create: `packages/plugins/inventory/src/shop-schema.ts`
- Create: `packages/plugins/inventory/src/migrations.ts`
- Modify: `packages/plugins/inventory/src/schema.ts` (add `locationId` to `playerStats`)
- Modify: `packages/plugins/inventory/src/index.ts` (manifest: `tables`, `migrations`)
- Test: `apps/server/test/plugin-migrate.test.ts`

**Interfaces:**
- Consumes: `runPluginMigrations(db, manifests)` from `apps/server/src/plugins/migrate.ts`; `seedItems(db)` and `seedLocations(db)` from `apps/server/src/db/seed.ts`.
- Produces: `shopStock` (drizzle table, columns `locationId: string`, `itemId: string`, `price: bigint`, `stock: number`); `SHOP_MIGRATIONS: { name: string; sql: string }[]`; `playerStats.locationId` (`string | null`).

- [ ] **Step 1: Write the failing test**

Append to `apps/server/test/plugin-migrate.test.ts`. It needs two new imports at the top of the file:

```ts
import inventoryPlugin from "@gl3/plugin-inventory";
import { seedItems, seedLocations } from "../src/db/seed.js";
```

and a new `describe` block at the end:

```ts
describe("inventory shop stock migrations", () => {
  it("creates the table and seeds one row per (location, seeded item), once", async () => {
    // The seed migration joins core content BY NAME because ids are uuidv7,
    // so the real seeders have to have run first — exactly the production
    // order in apps/server/src/index.ts (seed, then loadPlugins).
    await seedItems(db);
    await seedLocations(db);

    const applied = await runPluginMigrations(db, [inventoryPlugin]);
    expect(applied).toEqual(["inventory:0001_shop_stock", "inventory:0002_shop_stock_seed"]);

    const rows = await db.execute<{ name: string; price: string; stock: number }>(
      sql`select i.name, s.price::text as price, s.stock
          from p_inventory_shop_stock s
          join items i on i.id = s.item_id
          order by i.name`,
    );
    // 3 seeded locations x 2 seeded items.
    expect(rows.length).toBe(6);
    expect(rows.filter((r) => r.name === "Rusty Pistol")).toHaveLength(3);
    expect(rows[0]?.price).toBe("500");
    expect(rows[0]?.stock).toBe(25);

    // Second boot: the tracking rows mean neither migration re-runs, so the
    // seed does not double the stock rows.
    expect(await runPluginMigrations(db, [inventoryPlugin])).toEqual([]);
    const again = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from p_inventory_shop_stock`,
    );
    expect(again[0]?.n).toBe("6");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project @gl3/server:db-only apps/server/test/plugin-migrate.test.ts`
Expected: FAIL — `applied` is `[]` because the manifest declares no migrations, and the `select` then fails with `42P01 relation "p_inventory_shop_stock" does not exist`.

- [ ] **Step 3: Write `packages/plugins/inventory/src/shop-schema.ts`**

```ts
import { bigint, integer, pgTable, primaryKey, uuid } from "drizzle-orm/pg-core";

/**
 * This plugin's own table — the first one `inventory` owns, declared in the
 * manifest `tables` map and created by `migrations.ts`.
 *
 * No foreign keys, deliberately (CLAUDE.md rule 6, spec §4.1): an FK to
 * `locations` or `items` would make every stock write take FOR KEY SHARE on
 * those rows. The buy handler already holds the `locations` row FOR UPDATE and
 * is about to take `player_stats`, so a `locations` FK is redundant lock
 * traffic on a row it already owns, and an `items` FK adds a lock edge to a
 * table nothing else locks. FK-free, this table adds no lock edges at all and
 * cannot participate in any cycle. The accepted cost is orphan rows when an
 * item or location is deleted; the listing query inner-joins `items`, so an
 * orphan is invisible to players.
 */
export const shopStock = pgTable(
  "p_inventory_shop_stock",
  {
    locationId: uuid("location_id").notNull(),
    itemId: uuid("item_id").notNull(),
    // bigint because it is money. A default here would have to be written
    // `` .default(sql`0`) `` — `.default(0n)` crashes drizzle-kit's serialiser.
    price: bigint("price", { mode: "bigint" }).notNull(),
    stock: integer("stock").notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.locationId, t.itemId] }) }),
);
```

- [ ] **Step 4: Write `packages/plugins/inventory/src/migrations.ts`**

```ts
/**
 * Two migrations, not one, and this is a deliberate deviation from the design
 * doc's §4.2: `runPluginMigrations` issues exactly one
 * `tx.execute(sql.raw(migration.sql))` per declared migration, and postgres.js
 * rejects a multi-statement string through `unsafe()` unless `.simple()` is
 * used. So the DDL and the seed are separate declarations.
 *
 * The seed joins core content BY NAME because `seedItems`/`seedLocations`
 * generate their ids with uuidv7 — nothing may hardcode one. In production
 * `apps/server/src/index.ts` runs both seeders before `loadPlugins`, so a
 * fresh install has both starter items for sale in all three cities.
 *
 * Where the seeds have NOT run the SELECT matches nothing and the migration is
 * a no-op that still records itself in `plugin_migrations` — meaning it will
 * not retry later. That is correct for tests, which insert their own stock
 * rows, and it is stated here so nobody expects a backfill.
 */
export const SHOP_MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "0001_shop_stock",
    sql: `CREATE TABLE p_inventory_shop_stock (
      location_id uuid    NOT NULL,
      item_id     uuid    NOT NULL,
      price       bigint  NOT NULL,
      stock       integer NOT NULL,
      PRIMARY KEY (location_id, item_id)
    )`,
  },
  {
    name: "0002_shop_stock_seed",
    // Prices are placeholders. Balance numbers are out of scope, exactly as
    // they were for combat; the intent is only that a weapon costs
    // meaningfully more than a heal.
    sql: `INSERT INTO p_inventory_shop_stock (location_id, item_id, price, stock)
    SELECT l.id, i.id, v.price, v.stock
    FROM (VALUES ('Rusty Pistol', 2500::bigint, 10), ('First Aid Kit', 500::bigint, 25))
           AS v(name, price, stock)
    JOIN items i ON i.name = v.name
    CROSS JOIN locations l
    ON CONFLICT (location_id, item_id) DO NOTHING`,
  },
];
```

- [ ] **Step 5: Add `locationId` to the `playerStats` mirror**

In `packages/plugins/inventory/src/schema.ts`, inside the `playerStats` table, after `rankId`:

```ts
  locationId: uuid("location_id"),
```

- [ ] **Step 6: Wire the manifest**

In `packages/plugins/inventory/src/index.ts`, add the import:

```ts
import { SHOP_MIGRATIONS } from "./migrations.js";
```

and change the default export to:

```ts
export default definePlugin({
  id: "inventory",
  version: "1.0.0",
  basePaths: ["/api/inventory"],
  tables: { shopStock: "p_inventory_shop_stock" },
  migrations: SHOP_MIGRATIONS,
  routes: [listRoute, equipRoute, useRoute],
  // No `menu`, `pages`, `events` or `jobs`: plugin-manifest-endpoint.test.ts:87
  // asserts a no-arg boot answers GET /api/plugins with exactly
  // { menu: [], pages: [], events: [] }, and buildApp throws at boot if a core
  // plugin declares jobs.
});
```

`basePaths` gains `/api/shop` in Task 2, not here — nothing serves that prefix yet.

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run --project @gl3/server:db-only apps/server/test/plugin-migrate.test.ts`
Expected: PASS, all four tests.

- [ ] **Step 8: Commit**

```bash
git add packages/plugins/inventory/src/shop-schema.ts \
        packages/plugins/inventory/src/migrations.ts \
        packages/plugins/inventory/src/schema.ts \
        packages/plugins/inventory/src/index.ts \
        apps/server/test/plugin-migrate.test.ts
git commit -m "feat(inventory): add the shop stock table and its seed migration"
```

---

### Task 2: `GET /api/shop` — the listing

**Files:**
- Create: `packages/plugins/inventory/src/shop.ts`
- Modify: `packages/plugins/inventory/src/index.ts` (export `readEffects`, add `basePaths` entry and the route)
- Create: `apps/server/test/shop.test.ts`
- Modify: `vitest.workspace.ts` (add `test/shop.test.ts` to the `@gl3/server` project's `include`)

**Interfaces:**
- Consumes: `shopStock` from Task 1; `playerStats.locationId` from Task 1; `readEffects(itemType, effects)` — currently a module-private function in `index.ts`, which this task moves to `effects.ts` and exports.
- Produces: `shopListRoute`; response body `{ locationId: string, items: Array<{ itemId: string, name: string, itemType: string, effects: unknown, price: string, stock: number }> }`.

- [ ] **Step 1: Move `readEffects` so both modules can use it**

Cut the `readEffects` function and its doc comment out of `packages/plugins/inventory/src/index.ts` and paste it — unchanged, with `export` added — at the bottom of `packages/plugins/inventory/src/effects.ts`. Then in `index.ts` replace the now-dead `ArmorEffectsSchema`/`ConsumableEffectsSchema`/`WeaponEffectsSchema`/`ITEM_TYPE_*` import list with one that also pulls in `readEffects`:

```ts
import {
  ArmorEffectsSchema,
  ConsumableEffectsSchema,
  ITEM_TYPE_ARMOR,
  ITEM_TYPE_CONSUMABLE,
  ITEM_TYPE_WEAPON,
  readEffects,
  WeaponEffectsSchema,
} from "./effects.js";
```

This is a pure move — no behaviour changes, and `test/inventory.test.ts` must stay green through it.

- [ ] **Step 2: Write the failing test**

Create `apps/server/test/shop.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { testDb } from "./helpers/db.js";
import { resetDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();

let app: FastifyInstance;
let closeServer: () => Promise<void>;

afterAll(async () => {
  await closeServer?.();
  await conn.end();
});

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer } = await bootTestServer());
});

/** Registers a player and returns their id plus a session cookie. */
async function register(): Promise<{ id: string; cookie: string }> {
  const username = `shopper_${randomUUID().slice(0, 8)}`;
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { username, password: "correct horse battery staple" },
  });
  expect(res.statusCode).toBe(201);
  const cookie = res.headers["set-cookie"];
  const body = res.json<{ player: { id: string } }>();
  return { id: body.player.id, cookie: Array.isArray(cookie) ? cookie[0]! : String(cookie) };
}

/** A location, an item, and one stock row for them. */
async function seedShop(price: bigint, stock: number): Promise<{ locationId: string; itemId: string }> {
  const locationId = uuidv7();
  const itemId = uuidv7();
  await db.execute(sql`
    insert into locations (id, name) values (${locationId}, ${"Shopville " + locationId.slice(0, 8)})`);
  await db.execute(sql`
    insert into items (id, name, item_type, effects)
    values (${itemId}, ${"Test Pistol " + itemId.slice(0, 8)}, 'weapon',
            ${JSON.stringify({ accuracy: 55, damageMin: 8, damageMax: 18 })}::jsonb)`);
  await db.execute(sql`
    insert into p_inventory_shop_stock (location_id, item_id, price, stock)
    values (${locationId}, ${itemId}, ${price.toString()}::bigint, ${stock})`);
  return { locationId, itemId };
}

async function moveTo(playerId: string, locationId: string): Promise<void> {
  await db.execute(sql`update player_stats set location_id = ${locationId} where player_id = ${playerId}`);
}

describe("GET /api/shop", () => {
  it("lists the stock at the caller's location, with money as a string", async () => {
    const player = await register();
    const { locationId, itemId } = await seedShop(2500n, 10);
    await moveTo(player.id, locationId);

    const res = await app.inject({ method: "GET", url: "/api/shop", headers: { cookie: player.cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ locationId: string; items: { itemId: string; price: unknown; stock: number; effects: unknown }[] }>();
    expect(body.locationId).toBe(locationId);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.itemId).toBe(itemId);
    // Decimal string, never a JSON number.
    expect(body.items[0]?.price).toBe("2500");
    expect(body.items[0]?.stock).toBe(10);
    // Through readEffects, so the weapon defaults a migrated V2 item does not
    // carry are filled in for the client.
    expect(body.items[0]?.effects).toMatchObject({ accuracy: 55, bulletsPerShot: 1 });
  });

  it("hides a stock row whose item has been deleted", async () => {
    const player = await register();
    const { locationId, itemId } = await seedShop(2500n, 10);
    await moveTo(player.id, locationId);
    await db.execute(sql`delete from items where id = ${itemId}`);

    const res = await app.inject({ method: "GET", url: "/api/shop", headers: { cookie: player.cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ items: unknown[] }>().items).toEqual([]);
  });

  it("answers 409 no_location for a player who is nowhere", async () => {
    const player = await register();
    const res = await app.inject({ method: "GET", url: "/api/shop", headers: { cookie: player.cookie } });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe("no_location");
  });

  it("answers 401 without a session", async () => {
    const res = await app.inject({ method: "GET", url: "/api/shop" });
    expect(res.statusCode).toBe(401);
  });
});
```

Note on `seedShop`: it writes `locations` and `items` with the minimum non-null columns. If either table has a NOT NULL column with no default that this insert omits, the test fails with `23502 null value in column ... violates not-null constraint` — read `apps/server/src/db/schema/content.ts` and add the missing column to the insert rather than making the column nullable.

Note on the register helper's response shape: check `apps/server/test/auth.test.ts` for the exact body `POST /api/auth/register` returns and match it; if it does not include the player id, read it back with `select id from players where username = ...`.

- [ ] **Step 3: Register the new file with vitest**

In `vitest.workspace.ts`, inside the `@gl3/server` project's `include` array, add — keeping the list alphabetical:

```ts
        "test/shop.test.ts",
```

It belongs in the "both Postgres and Redis" project because it calls `bootTestServer()`.

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run --project @gl3/server apps/server/test/shop.test.ts`
Expected: FAIL — every case 404s, because no route serves `/api/shop`.

- [ ] **Step 5: Write `packages/plugins/inventory/src/shop.ts`**

```ts
import { PluginError, route } from "@gl3/plugin-sdk";
import { and, eq, gt } from "drizzle-orm";
import { readEffects } from "./effects.js";
import { items, playerStats } from "./schema.js";
import { shopStock } from "./shop-schema.js";

/**
 * Stock at the caller's current location.
 *
 * No jail or hospital gate — both default open in the SDK and are left that
 * way deliberately: browsing is not an action.
 */
export const shopListRoute = route({
  method: "GET",
  path: "/api/shop",
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      const [stats] = await tx.db
        .select({ locationId: playerStats.locationId })
        .from(playerStats)
        .where(eq(playerStats.playerId, player.id));
      const locationId = stats?.locationId ?? null;
      // Same answer POST /api/bullets/buy gives a player who is nowhere.
      if (locationId === null) throw new PluginError("no_location", 409);

      // INNER join to `items`: the stock table has no FKs (see shop-schema.ts),
      // so a deleted item leaves an orphan row. The join is what keeps it
      // invisible to players.
      const rows = await tx.db
        .select({
          itemId: items.id,
          name: items.name,
          itemType: items.itemType,
          effects: items.effects,
          price: shopStock.price,
          stock: shopStock.stock,
        })
        .from(shopStock)
        .innerJoin(items, eq(items.id, shopStock.itemId))
        .where(and(eq(shopStock.locationId, locationId), gt(shopStock.stock, 0)));

      return {
        status: 200,
        body: {
          locationId,
          items: rows.map((row) => ({
            itemId: row.itemId,
            name: row.name,
            itemType: row.itemType,
            // Through the same readEffects the inventory listing uses, so a
            // shop row shows the numbers combat will actually use.
            effects: readEffects(row.itemType, row.effects),
            // Money crosses the wire as a decimal string, never a JSON number.
            price: row.price.toString(),
            stock: row.stock,
          })),
        },
      };
    });
  },
});
```

- [ ] **Step 6: Register the route**

In `packages/plugins/inventory/src/index.ts`:

```ts
import { shopListRoute } from "./shop.js";
```

and in the manifest:

```ts
  basePaths: ["/api/inventory", "/api/shop"],
  routes: [listRoute, equipRoute, useRoute, shopListRoute],
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run --project @gl3/server apps/server/test/shop.test.ts apps/server/test/inventory.test.ts`
Expected: PASS. `inventory.test.ts` is included because Step 1 moved `readEffects`.

- [ ] **Step 8: Commit**

```bash
git add packages/plugins/inventory/src/shop.ts \
        packages/plugins/inventory/src/effects.ts \
        packages/plugins/inventory/src/index.ts \
        apps/server/test/shop.test.ts vitest.workspace.ts
git commit -m "feat(inventory): add GET /api/shop stock listing"
```

---

### Task 3: `POST /api/shop/buy`

**Files:**
- Modify: `packages/plugins/inventory/src/shop.ts`
- Modify: `packages/plugins/inventory/src/index.ts`
- Test: `apps/server/test/shop.test.ts`

**Interfaces:**
- Consumes: `shopStock`, `playerStats.locationId`, `playerItems` (all from Task 1/existing); `tx.locks.location(id)`, `tx.economy.applyBalanceChange({...}) => Promise<bigint>`, `InsufficientFundsError`, `tx.events.publish` from `@gl3/plugin-sdk`.
- Produces: `shopBuyRoute`; the `purchased` plugin-event declaration; response body `{ cash: string, itemId: string, qty: number, stock: number }`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/server/test/shop.test.ts`. Add `awaitOwnEvent` to the imports:

```ts
import { awaitOwnEvent } from "./helpers/events.js";
```

```ts
describe("POST /api/shop/buy", () => {
  const buy = (cookie: string, itemId: string, quantity: number) =>
    app.inject({
      method: "POST",
      url: "/api/shop/buy",
      headers: { cookie },
      payload: { itemId, quantity },
    });

  it("debits cash, decrements stock, credits the item, and writes one ledger row", async () => {
    const player = await register();
    const { locationId, itemId } = await seedShop(2500n, 10);
    await moveTo(player.id, locationId);
    await db.execute(sql`update player_stats set cash = 10000 where player_id = ${player.id}`);

    const res = await buy(player.cookie, itemId, 2);
    expect(res.statusCode).toBe(200);
    const body = res.json<{ cash: string; qty: number; stock: number }>();
    // 10000 - 2 * 2500. A decimal string, never a JSON number.
    expect(body.cash).toBe("5000");
    expect(body.qty).toBe(2);
    expect(body.stock).toBe(8);

    const owned = await db.execute<{ qty: number }>(
      sql`select qty from player_items where player_id = ${player.id} and item_id = ${itemId}`,
    );
    expect(owned[0]?.qty).toBe(2);

    const ledger = await db.execute<{ amount: string; reason: string }>(
      sql`select amount::text as amount, reason from ledger where player_id = ${player.id}
          and reason = 'shop.purchase'`,
    );
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.amount).toBe("-5000");
  });

  it("stacks onto an existing row rather than inserting a second one", async () => {
    const player = await register();
    const { locationId, itemId } = await seedShop(100n, 10);
    await moveTo(player.id, locationId);
    await db.execute(sql`update player_stats set cash = 10000 where player_id = ${player.id}`);

    expect((await buy(player.cookie, itemId, 1)).statusCode).toBe(200);
    const second = await buy(player.cookie, itemId, 3);
    expect(second.statusCode).toBe(200);
    expect(second.json<{ qty: number }>().qty).toBe(4);

    const rows = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from player_items where player_id = ${player.id}`,
    );
    expect(rows[0]?.n).toBe("1");
  });

  it("publishes a purchased event to the buyer", async () => {
    const player = await register();
    const { locationId, itemId } = await seedShop(100n, 10);
    await moveTo(player.id, locationId);
    await db.execute(sql`update player_stats set cash = 10000 where player_id = ${player.id}`);

    // Filtered by our own actorId: `game:events` is global across test files
    // and matching on type alone captures another file's traffic.
    const event = awaitOwnEvent(player.id, (e) => e.type === "plugin.event");
    expect((await buy(player.cookie, itemId, 1)).statusCode).toBe(200);
    await expect(event).resolves.toMatchObject({ actorId: player.id });
  });

  it("answers 409 not_sold_here for an item this location does not stock", async () => {
    const player = await register();
    const { locationId } = await seedShop(100n, 10);
    const elsewhere = await seedShop(100n, 10);
    await moveTo(player.id, locationId);

    const res = await buy(player.cookie, elsewhere.itemId, 1);
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe("not_sold_here");
  });

  it("answers 409 insufficient_stock with what is available", async () => {
    const player = await register();
    const { locationId, itemId } = await seedShop(100n, 2);
    await moveTo(player.id, locationId);
    await db.execute(sql`update player_stats set cash = 10000 where player_id = ${player.id}`);

    const res = await buy(player.cookie, itemId, 3);
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string; available: number }>()).toMatchObject({
      error: "insufficient_stock",
      available: 2,
    });
  });

  it("answers 409 insufficient_funds rather than 500", async () => {
    const player = await register();
    const { locationId, itemId } = await seedShop(2500n, 10);
    await moveTo(player.id, locationId);
    await db.execute(sql`update player_stats set cash = 100 where player_id = ${player.id}`);

    const res = await buy(player.cookie, itemId, 1);
    // Without the InsufficientFundsError catch this is a 500: the loader maps
    // only PluginError.
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe("insufficient_funds");

    // …and nothing moved.
    const stock = await db.execute<{ stock: number }>(
      sql`select stock from p_inventory_shop_stock where item_id = ${itemId}`,
    );
    expect(stock[0]?.stock).toBe(10);
  });

  it("answers 409 no_location for a player who is nowhere", async () => {
    const player = await register();
    const { itemId } = await seedShop(100n, 10);
    const res = await buy(player.cookie, itemId, 1);
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe("no_location");
  });

  it("rejects a non-positive quantity with 400", async () => {
    const player = await register();
    const { locationId, itemId } = await seedShop(100n, 10);
    await moveTo(player.id, locationId);
    expect((await buy(player.cookie, itemId, 0)).statusCode).toBe(400);
  });

  it("answers 423 while jailed and while hospitalised", async () => {
    const player = await register();
    const { locationId, itemId } = await seedShop(100n, 10);
    await moveTo(player.id, locationId);
    await db.execute(sql`update player_stats set cash = 10000 where player_id = ${player.id}`);

    await db.execute(sql`update player_stats set jailed_until = now() + interval '1 hour'
                         where player_id = ${player.id}`);
    expect((await buy(player.cookie, itemId, 1)).statusCode).toBe(423);

    await db.execute(sql`update player_stats set jailed_until = null,
                         hospital_until = now() + interval '1 hour'
                         where player_id = ${player.id}`);
    expect((await buy(player.cookie, itemId, 1)).statusCode).toBe(423);
  });
});
```

If `awaitOwnEvent`'s signature differs from `(actorId, predicate)`, read `apps/server/test/helpers/events.ts` and match it — do not change the helper. Likewise, confirm the wire `type` a plugin event carries: read `packages/plugin-sdk/src/events.ts` and use whatever `tx.events.publish` actually emits.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project @gl3/server apps/server/test/shop.test.ts`
Expected: FAIL — every `POST /api/shop/buy` case 404s.

- [ ] **Step 3: Add the route to `packages/plugins/inventory/src/shop.ts`**

Extend the imports:

```ts
import { InsufficientFundsError, PluginError, route } from "@gl3/plugin-sdk";
import { and, eq, gt, gte, sql } from "drizzle-orm";
import { z } from "zod";
import { playerItems } from "./schema.js";
```

Then:

```ts
/**
 * Published to the buyer alone. A purchase is private — the same audience
 * `bullets.purchased` uses.
 *
 * A plugin event, not `publishCore`: none of the 19 core `GameEvent` variants
 * covers a shop purchase, and adding one to `@gl3/shared` for one plugin's
 * feature is a core schema change this does not need.
 */
export const purchasedEvent = {
  name: "purchased",
  payload: z.object({
    itemId: z.string().uuid(),
    name: z.string(),
    qty: z.number().int(),
    cost: z.string(),
  }),
  describe: "Bought {qty}x {name}",
  // Web query-key prefixes the client drops when this arrives: the inventory
  // listing (a new item) and `me` (cash moved).
  invalidates: ["inventory", "me"],
};

const BuySchema = z.object({
  itemId: z.string().uuid(),
  quantity: z.number().int().positive(),
});

export const shopBuyRoute = route({
  method: "POST",
  path: "/api/shop/buy",
  // Buying is an action. Both gates are answered by the loader with a 423
  // before this handler runs.
  accessInJail: false,
  accessInHospital: false,
  body: BuySchema,
  handler: async (ctx, { body }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      // Step 1, unlocked, and that is safe: a `travel` off this location must
      // hold the row step 2 takes in order to commit, so it cannot slip in
      // between. Reading it under the player lock instead would invert the
      // location -> player order (CLAUDE.md rule 6).
      const [stats] = await tx.db
        .select({ locationId: playerStats.locationId })
        .from(playerStats)
        .where(eq(playerStats.playerId, player.id));
      const locationId = stats?.locationId ?? null;
      if (locationId === null) throw new PluginError("no_location", 409);

      // LOCATION FIRST, and this line must stay first. `applyBalanceChange`
      // below is what acquires `player_stats` — it locks internally — so no
      // explicit player lock appears here to hint at the ordering.
      await tx.locks.location(locationId);

      const [row] = await tx.db
        .select({ price: shopStock.price, stock: shopStock.stock, name: items.name })
        .from(shopStock)
        .innerJoin(items, eq(items.id, shopStock.itemId))
        .where(and(eq(shopStock.locationId, locationId), eq(shopStock.itemId, body.itemId)));
      if (!row) throw new PluginError("not_sold_here", 409);
      if (row.stock < body.quantity) {
        throw new PluginError("insufficient_stock", 409, { available: row.stock });
      }

      const cost = row.price * BigInt(body.quantity);

      let cash: bigint;
      try {
        cash = await tx.economy.applyBalanceChange({
          playerId: player.id,
          amount: -cost,
          kind: "cash",
          reason: "shop.purchase",
          refId: body.itemId,
        });
      } catch (error) {
        // The loader maps only PluginError; without this an overdraft is a 500.
        if (error instanceof InsufficientFundsError) {
          throw new PluginError("insufficient_funds", 409);
        }
        throw error;
      }

      // `stock >= quantity` in the WHERE is the guard, not the read above.
      // Under the location lock the read is already authoritative; the
      // predicate is what makes the statement correct rather than merely
      // currently-serialised. Zero rows back means insufficient_stock.
      const decremented = await tx.db
        .update(shopStock)
        .set({ stock: sql`${shopStock.stock} - ${body.quantity}` })
        .where(and(
          eq(shopStock.locationId, locationId),
          eq(shopStock.itemId, body.itemId),
          gte(shopStock.stock, body.quantity),
        ))
        .returning({ stock: shopStock.stock });
      const remainingStock = decremented[0]?.stock;
      if (remainingStock === undefined) {
        throw new PluginError("insufficient_stock", 409, { available: row.stock });
      }

      // FKs checked (rule 6): `player_items` references `players` and `items`,
      // so this takes FOR KEY SHARE on one row of each. Nothing in the codebase
      // locks either table FOR UPDATE — the only FOR UPDATE sites are
      // `player_stats`, `locations` and `gangs` — so this adds no lock edge and
      // no new lock pair.
      const [owned] = await tx.db
        .insert(playerItems)
        .values({ playerId: player.id, itemId: body.itemId, qty: body.quantity })
        .onConflictDoUpdate({
          target: [playerItems.playerId, playerItems.itemId],
          set: { qty: sql`${playerItems.qty} + ${body.quantity}` },
        })
        .returning({ qty: playerItems.qty });

      await tx.events.publish({
        name: "purchased",
        actorId: player.id,
        actorName: player.username,
        audience: { kind: "player", playerId: player.id },
        payload: {
          itemId: body.itemId,
          name: row.name,
          qty: body.quantity,
          cost: cost.toString(),
        },
      });

      return {
        status: 200,
        body: {
          cash: cash.toString(),
          itemId: body.itemId,
          qty: owned?.qty ?? body.quantity,
          stock: remainingStock,
        },
      };
    });
  },
});
```

`gt` stays imported for the listing's `gt(shopStock.stock, 0)`; `gte` is new.

- [ ] **Step 4: Register the route and the event**

In `packages/plugins/inventory/src/index.ts`:

```ts
import { purchasedEvent, shopBuyRoute, shopListRoute } from "./shop.js";
```

and in the manifest:

```ts
  routes: [listRoute, equipRoute, useRoute, shopListRoute, shopBuyRoute],
  events: [purchasedEvent],
```

Delete the stale trailing comment about declaring no events (keep the sentence about `jobs`). `plugin-manifest-endpoint.test.ts:87` asserts against a **no-arg** `bootTestServer()`, which leaves `deps.plugins` undefined, so declaring an event here does not break it — verify that by running that file in Step 5.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run --project @gl3/server apps/server/test/shop.test.ts apps/server/test/plugin-manifest-endpoint.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/plugins/inventory/src/shop.ts packages/plugins/inventory/src/index.ts \
        apps/server/test/shop.test.ts
git commit -m "feat(inventory): add POST /api/shop/buy"
```

---

### Task 4: The shop concurrency test

**Files:**
- Create: `apps/server/test/shop-concurrency.test.ts`
- Modify: `vitest.workspace.ts`

**Interfaces:**
- Consumes: `shopBuyRoute` from Task 3. Nothing produces anything new — this task adds only proof.

The template is `apps/server/test/hospital-concurrency.test.ts`. Read it first; this test is the same shape with one substitution: the blocker holds the **`locations`** row `FOR UPDATE`, because `tx.locks.location(locationId)` is the first lock the buy handler takes.

- [ ] **Step 1: Write the test**

Create `apps/server/test/shop-concurrency.test.ts`, modelled line-for-line on `hospital-concurrency.test.ts`:

```ts
// Two buyers released together against the LAST unit in stock. Exactly one
// 200 and one 409 insufficient_stock; one player_items row incremented; stock
// lands at 0 and never negative.
//
// The blocker holds the `locations` row FOR UPDATE — the first lock the buy
// handler takes (tx.locks.location) — so both requests are parked at the same
// point before release. `waitForLockWaiters(2)` polls pg_stat_activity for
// wait_event_type = 'Lock' rather than sleeping, so the release is
// deterministic rather than timing-dependent.
```

Structure, following the template exactly:

1. `const { db, sql: conn } = testDb();` at module scope; boot the server once.
2. Register two players, give each enough cash, put both at the same location, seed **one** unit of stock.
3. Open a second raw connection with `postgres()`; `BEGIN`; `SELECT ... FROM locations WHERE id = $1 FOR UPDATE`.
4. Build both requests as lazy `fire()` thunks (`app.inject(...)` promises created but not awaited).
5. `await waitForLockWaiters(2)`.
6. `ROLLBACK` on the blocker; `await` both responses.
7. Assert:
   ```ts
   expect([res1.statusCode, res2.statusCode].sort()).toEqual([200, 409]);
   const loser = res1.statusCode === 409 ? res1 : res2;
   expect(loser.json<{ error: string }>().error).toBe("insufficient_stock");

   const stock = await db.execute<{ stock: number }>(
     sql`select stock from p_inventory_shop_stock where item_id = ${itemId}`,
   );
   expect(stock[0]?.stock).toBe(0);

   const owned = await db.execute<{ n: string; total: string }>(
     sql`select count(*)::text as n, coalesce(sum(qty),0)::text as total
         from player_items where item_id = ${itemId}`,
   );
   expect(owned[0]?.n).toBe("1");
   expect(owned[0]?.total).toBe("1");

   const ledger = await db.execute<{ n: string }>(
     sql`select count(*)::text as n from ledger where reason = 'shop.purchase'`,
   );
   expect(ledger[0]?.n).toBe("1");
   ```
8. `{ timeout: 30000 }` on the `it`, and close the blocker connection in `afterAll`.

Add `"test/shop-concurrency.test.ts",` to the `@gl3/server` project's `include` in `vitest.workspace.ts`.

- [ ] **Step 2: Demonstrate the test can fail**

This step is the point of the task; a green test that was never red proves nothing. Temporarily delete the guard predicate from Task 3's step-6 UPDATE — that is the line:

```ts
          gte(shopStock.stock, body.quantity),
```

- [ ] **Step 3: Run it and confirm it fails for the right reason**

Run: `npx vitest run --project @gl3/server apps/server/test/shop-concurrency.test.ts`
Expected: FAIL — both requests return 200, stock lands at `-1`, and `[200, 200]` does not equal `[200, 409]`. If instead it fails with a timeout or a lock error, the blocker is holding the wrong row; fix the test before restoring the guard.

- [ ] **Step 4: Restore the guard and confirm the test passes**

Put `gte(shopStock.stock, body.quantity),` back.
Run: `npx vitest run --project @gl3/server apps/server/test/shop-concurrency.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/test/shop-concurrency.test.ts vitest.workspace.ts
git commit -m "test(inventory): prove the shop cannot oversell the last unit"
```

---

### Task 5: The shop joins the ledger invariant sweep

**Files:**
- Modify: `apps/server/test/economy-invariant.test.ts`

**Interfaces:**
- Consumes: `shopBuyRoute` via `inventoryPlugin`'s manifest and `callPluginRoute`.
- Produces: nothing. This is the gate that matters: `sum(ledger) == balance` must hold across a money movement that also mutates two other tables.

- [ ] **Step 1: Seed shop stock in the file's setup**

In the `beforeAll` that already creates players, locations and the combat weapon, after the locations exist, add:

```ts
    // One item, stocked in every location, cheap and effectively unlimited so
    // the sweep's shopBuy op mostly succeeds rather than mostly 409ing.
    shopItemId = uuidv7();
    await db.execute(sql`
      insert into items (id, name, item_type, effects)
      values (${shopItemId}, 'Invariant Widget', 'consumable', ${JSON.stringify({ heal: 1 })}::jsonb)`);
    await db.execute(sql`
      insert into p_inventory_shop_stock (location_id, item_id, price, stock)
      select id, ${shopItemId}, 25::bigint, 100000 from locations`);
```

with `let shopItemId: string;` declared alongside the file's other module-scope ids. The `p_inventory_shop_stock` table exists here because `bootTestServer`/`loadPlugins` runs plugin migrations — if this file does not boot a server, call `runPluginMigrations(db, [inventoryPlugin])` in `beforeAll` instead, importing both.

- [ ] **Step 2: Add the op**

Extend the three op lists:

```ts
    const OP_NAMES = ["crime", "bank", "travel", "bullets", "points", "kill", "shopBuy"] as const;
    const attempted = { crime: 0, bank: 0, travel: 0, bullets: 0, points: 0, kill: 0, shopBuy: 0 };
    const succeeded = { crime: 0, bank: 0, travel: 0, bullets: 0, points: 0, kill: 0, shopBuy: 0 };
```

and add the branch, alongside the `bullets` branch:

```ts
        } else if (opName === "shopBuy") {
          // A purchase moves cash AND mutates p_inventory_shop_stock and
          // player_items in the same transaction — the shape most likely to
          // leave the ledger and the balance disagreeing if the money movement
          // is ever moved out of applyBalanceChange.
          const quantity = 1 + Math.floor(rand() * 3);
          await callPluginRoute(inventoryPlugin, "POST", "/api/shop/buy", {
            db, redis, leaderboardPrefix, playerId, body: { itemId: shopItemId, quantity },
          });
```

with `import inventoryPlugin from "@gl3/plugin-inventory";` at the top.

A player with no `location_id` gets `no_location` — a `PluginError`, which `callPluginRoute` propagates. The existing `try`/`catch` around the op body already swallows expected refusals; confirm it does before assuming, and mirror whatever the `bullets` op relies on.

Add the same two coverage guards the `kill` op has, so a future edit that drops the op is loud:

```ts
    expect(succeeded.shopBuy).toBeGreaterThan(0);
```

- [ ] **Step 3: Run the test**

Run: `npx vitest run --project @gl3/server apps/server/test/economy-invariant.test.ts`
Expected: PASS, with `succeeded.shopBuy > 0`.

- [ ] **Step 4: Prove the op is actually exercising the ledger**

Temporarily change Task 3's `applyBalanceChange` call to a direct `update player_stats set cash = cash - ...`, re-run, and confirm the invariant assertion fails. Restore it.
Expected while broken: FAIL on `sum(ledger) == balance`.

- [ ] **Step 5: Commit**

```bash
git add apps/server/test/economy-invariant.test.ts
git commit -m "test(economy): cover shop purchases in the ledger invariant sweep"
```

---

### Task 6: `GET /api/combat/targets`

**Files:**
- Modify: `packages/plugins/combat/src/schema.ts` (add `name` to `ranks`)
- Modify: `packages/plugins/combat/src/index.ts`
- Test: `apps/server/test/combat.test.ts`

**Interfaces:**
- Consumes: `readCombatSettings`, `players`, `playerStats`, `ranks` — all existing in `packages/plugins/combat`.
- Produces: `targetsRoute`; response body `{ targets: Array<{ playerId: string, username: string, rank: string | null, health: number, maxHealth: number, attackable: boolean, reason: TargetReason | null }> }` where `TargetReason = "hospitalised" | "jailed" | "gang_mate" | "newbie_protected" | "newbie_self"`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/server/test/combat.test.ts`, reusing that file's existing `register`, `makeAttackable` and `equipWeapon` helpers:

```ts
describe("GET /api/combat/targets", () => {
  const targets = (cookie: string) =>
    app.inject({ method: "GET", url: "/api/combat/targets", headers: { cookie } });

  type Target = {
    playerId: string;
    username: string;
    rank: string | null;
    health: number;
    maxHealth: number;
    attackable: boolean;
    reason: string | null;
  };

  it("lists a co-located player as attackable, with reason null", async () => {
    const attacker = await register();
    const victim = await register();
    await makeAttackable(attacker.id, victim.id);

    const res = await targets(attacker.cookie);
    expect(res.statusCode).toBe(200);
    const list = res.json<{ targets: Target[] }>().targets;
    const row = list.find((t) => t.playerId === victim.id);
    expect(row).toMatchObject({ attackable: true, reason: null, username: victim.username });
    expect(row?.maxHealth).toBeGreaterThan(0);
  });

  it("excludes the caller's own row", async () => {
    const attacker = await register();
    const victim = await register();
    await makeAttackable(attacker.id, victim.id);

    const list = (await targets(attacker.cookie)).json<{ targets: Target[] }>().targets;
    expect(list.map((t) => t.playerId)).not.toContain(attacker.id);
  });

  it("excludes a player in another city", async () => {
    const attacker = await register();
    const victim = await register();
    await makeAttackable(attacker.id, victim.id);
    await db.execute(sql`update player_stats set location_id = ${uuidv7()} where player_id = ${victim.id}`);

    const list = (await targets(attacker.cookie)).json<{ targets: Target[] }>().targets;
    expect(list.map((t) => t.playerId)).not.toContain(victim.id);
  });

  it("reports each illegal reason", async () => {
    const attacker = await register();
    const hospitalised = await register();
    const jailed = await register();
    const mate = await register();
    const newbie = await register();
    for (const other of [hospitalised, jailed, mate, newbie]) {
      await makeAttackable(attacker.id, other.id);
    }

    await db.execute(sql`update player_stats set hospital_until = now() + interval '1 hour'
                         where player_id = ${hospitalised.id}`);
    await db.execute(sql`update player_stats set jailed_until = now() + interval '1 hour'
                         where player_id = ${jailed.id}`);
    const gangId = uuidv7();
    await db.execute(sql`insert into gangs (id, name, tag) values (${gangId}, ${"G" + gangId.slice(0, 8)}, 'GG')`);
    await db.execute(sql`update player_stats set gang_id = ${gangId}
                         where player_id in (${attacker.id}, ${mate.id})`);
    await db.execute(sql`update player_stats set exp = 0 where player_id = ${newbie.id}`);

    const list = (await targets(attacker.cookie)).json<{ targets: Target[] }>().targets;
    const reasonOf = (id: string) => list.find((t) => t.playerId === id)?.reason;
    expect(reasonOf(hospitalised.id)).toBe("hospitalised");
    expect(reasonOf(jailed.id)).toBe("jailed");
    expect(reasonOf(mate.id)).toBe("gang_mate");
    expect(reasonOf(newbie.id)).toBe("newbie_protected");
    expect(list.every((t) => (t.reason === null) === t.attackable)).toBe(true);
  });

  it("reports newbie_self on every row when the CALLER is under the threshold", async () => {
    const attacker = await register();
    const victim = await register();
    await makeAttackable(attacker.id, victim.id);
    await db.execute(sql`update player_stats set exp = 0 where player_id = ${attacker.id}`);

    const list = (await targets(attacker.cookie)).json<{ targets: Target[] }>().targets;
    expect(list.every((t) => t.reason === "newbie_self")).toBe(true);
  });

  it("consumes no cooldown", async () => {
    const attacker = await register();
    const victim = await register();
    await makeAttackable(attacker.id, victim.id);
    await equipWeapon(attacker.id);

    expect((await targets(attacker.cookie)).statusCode).toBe(200);
    expect((await targets(attacker.cookie)).statusCode).toBe(200);
    // The route must not have claimed combat.attack's Redis key: a subsequent
    // attack still succeeds rather than 429ing.
    const shot = await app.inject({
      method: "POST",
      url: `/api/combat/attack/${victim.id}`,
      headers: { cookie: attacker.cookie },
    });
    expect(shot.statusCode).toBe(200);
  });

  it("answers 401 without a session", async () => {
    expect((await app.inject({ method: "GET", url: "/api/combat/targets" })).statusCode).toBe(401);
  });
});
```

`makeAttackable(attackerId, targetId)` already exists in this file; check what it sets (location, exp above the newbie threshold, health) and adjust the setup above only if it does less than the tests assume. The `gangs` insert's column list must match `apps/server/src/db/schema` — read it rather than guessing.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project @gl3/server apps/server/test/combat.test.ts`
Expected: FAIL — the new cases 404, the pre-existing cases still pass.

- [ ] **Step 3: Add `name` to the `ranks` mirror**

In `packages/plugins/combat/src/schema.ts`:

```ts
export const ranks = pgTable("ranks", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  maxHealth: integer("max_health").notNull(),
});
```

Add `text` to that file's `drizzle-orm/pg-core` import if it is not already there.

- [ ] **Step 4: Add the route to `packages/plugins/combat/src/index.ts`**

```ts
/**
 * Who the caller could shoot, here, right now.
 *
 * Read-only: no locks, no cooldown consumed. That last part is the point of
 * the route. `attack` claims its Redis cooldown BEFORE the transaction and
 * deliberately never releases it on a 4xx, so firing at an illegal target
 * costs the attacker a full cooldown. A pre-evaluated list is what stops the
 * UI from spending a player's cooldown to discover a rule.
 *
 * ADVISORY ONLY. `attack` re-checks every rule under the lock; nothing here is
 * trusted. `target_elsewhere` has no `reason` because such a player is simply
 * absent from the list.
 *
 * Bounded at 50 and NOT paginated — the same deliberate limitation
 * GET /api/combat/log has, recorded here rather than discovered later.
 */
const targetsRoute = route({
  method: "GET",
  path: "/api/combat/targets",
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    const config = readCombatSettings((key) => ctx.settings.get(key));

    return ctx.transaction(async (tx) => {
      const [me] = await tx.db
        .select()
        .from(playerStats)
        .where(eq(playerStats.playerId, player.id));
      if (!me) throw new PluginError("unauthorized", 401);
      if (me.locationId === null) return { status: 200, body: { targets: [] } };

      const rows = await tx.db
        .select({
          playerId: playerStats.playerId,
          username: players.username,
          rank: ranks.name,
          health: playerStats.health,
          maxHealth: ranks.maxHealth,
          gangId: playerStats.gangId,
          exp: playerStats.exp,
          jailedUntil: playerStats.jailedUntil,
          hospitalUntil: playerStats.hospitalUntil,
        })
        .from(playerStats)
        .innerJoin(players, eq(players.id, playerStats.playerId))
        .leftJoin(ranks, eq(ranks.id, playerStats.rankId))
        .where(and(
          eq(playerStats.locationId, me.locationId),
          ne(playerStats.playerId, player.id),
        ))
        .orderBy(desc(playerStats.exp))
        .limit(50);

      const now = Date.now();
      // The caller being under the threshold makes EVERY row illegal —
      // protection is mutual, so a newbie can neither be attacked nor attack.
      const selfProtected = me.exp < config.newbieExpThreshold;

      return {
        status: 200,
        body: {
          targets: rows.map((row) => {
            // Evaluated in the same order attack's checks run, so the reason a
            // player sees here is the one they would actually get back.
            const reason =
              row.hospitalUntil && row.hospitalUntil.getTime() > now ? "hospitalised"
              : row.jailedUntil && row.jailedUntil.getTime() > now ? "jailed"
              : me.gangId !== null && me.gangId === row.gangId ? "gang_mate"
              : selfProtected ? "newbie_self"
              : row.exp < config.newbieExpThreshold ? "newbie_protected"
              : null;
            return {
              playerId: row.playerId,
              username: row.username,
              rank: row.rank,
              health: row.health,
              // 100 matches core's ranks.max_health default and
              // hospital/status.ts's DEFAULT_MAX_HEALTH, used when the player
              // has no rank row yet. A plugin cannot import that constant from
              // apps/server, so the two are kept in step by hand.
              maxHealth: row.maxHealth ?? 100,
              attackable: reason === null,
              // null, not absent, when attackable: a nullable field is
              // friendlier to zod and to exactOptionalPropertyTypes than an
              // optional one, and the DTO stays a closed union plus null.
              reason,
            };
          }),
        },
      };
    });
  },
});
```

Add `ne` to the `drizzle-orm` import list (`and`, `desc`, `eq`, `isNotNull`, `ne`, `or`, `sql`), and register the route:

```ts
  routes: [attackRoute, logRoute, targetsRoute],
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run --project @gl3/server apps/server/test/combat.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/plugins/combat/src/index.ts packages/plugins/combat/src/schema.ts \
        apps/server/test/combat.test.ts
git commit -m "feat(combat): add GET /api/combat/targets"
```

---

### Task 7: Shared DTOs for the four surfaces

**Files:**
- Create: `packages/shared/src/dto/inventory.ts`, `dto/shop.ts`, `dto/combat.ts`, `dto/hospital.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: `MoneySchema` from `packages/shared/src/primitives.js`; the response shapes produced by Tasks 2, 3 and 6, and by the existing `inventory`, `combat` and core hospital routes.
- Produces: `InventoryResponseSchema`/`InventoryResponse`, `EquipRequestSchema`/`EquipRequest`, `EquipResponseSchema`/`EquipResponse`, `UseItemResponseSchema`/`UseItemResponse`, `ShopListResponseSchema`/`ShopListResponse`, `BuyItemRequestSchema`/`BuyItemRequest`, `BuyItemResponseSchema`/`BuyItemResponse`, `CombatTargetListResponseSchema`/`CombatTargetListResponse`, `AttackResponseSchema`/`AttackResponse`, `CombatLogResponseSchema`/`CombatLogResponse`, `HospitalStatusSchema`/`HospitalStatus`, `DischargeResponseSchema`/`DischargeResponse`.

These are the exact names Tasks 8–12 import. Every file follows `dto/bullets.ts`: zod schema, then `z.infer` type alias, both exported.

- [ ] **Step 1: Create `packages/shared/src/dto/inventory.ts`**

```ts
import { z } from "zod";

/**
 * `effects` is `unknown` on purpose. The server passes it through
 * `readEffects`, which returns the parsed shape for the three known item types
 * and the raw jsonb untouched for any other — `item_type` is unconstrained text
 * and V2 shipped types beyond these three. Narrowing it here would mean
 * changing a shipped route's contract; the web side pulls numbers out through
 * `lib/effects.ts` instead.
 */
export const InventoryItemSchema = z.object({
  itemId: z.string().uuid(),
  name: z.string(),
  itemType: z.string(),
  effects: z.unknown(),
  qty: z.number().int(),
});
export type InventoryItem = z.infer<typeof InventoryItemSchema>;

export const InventoryResponseSchema = z.object({
  items: z.array(InventoryItemSchema),
  equipped: z.object({
    weaponItemId: z.string().uuid().nullable(),
    armorItemId: z.string().uuid().nullable(),
  }),
});
export type InventoryResponse = z.infer<typeof InventoryResponseSchema>;

/**
 * `.nullable().optional()` on both, mirroring the route: an absent key leaves
 * the slot alone, an explicit `null` unequips it. They must not collapse.
 */
export const EquipRequestSchema = z.object({
  weaponItemId: z.string().uuid().nullable().optional(),
  armorItemId: z.string().uuid().nullable().optional(),
});
export type EquipRequest = z.infer<typeof EquipRequestSchema>;

export const EquipResponseSchema = z.object({
  weaponItemId: z.string().uuid().nullable(),
  armorItemId: z.string().uuid().nullable(),
});
export type EquipResponse = z.infer<typeof EquipResponseSchema>;

export const UseItemResponseSchema = z.object({
  health: z.number().int(),
  healed: z.number().int(),
  qty: z.number().int(),
});
export type UseItemResponse = z.infer<typeof UseItemResponseSchema>;
```

- [ ] **Step 2: Create `packages/shared/src/dto/shop.ts`**

```ts
import { z } from "zod";
import { MoneySchema } from "../primitives.js";

export const ShopItemSchema = z.object({
  itemId: z.string().uuid(),
  name: z.string(),
  itemType: z.string(),
  effects: z.unknown(),
  price: MoneySchema,
  stock: z.number().int().nonnegative(),
});
export type ShopItem = z.infer<typeof ShopItemSchema>;

export const ShopListResponseSchema = z.object({
  locationId: z.string().uuid(),
  items: z.array(ShopItemSchema),
});
export type ShopListResponse = z.infer<typeof ShopListResponseSchema>;

export const BuyItemRequestSchema = z.object({
  itemId: z.string().uuid(),
  quantity: z.number().int().positive(),
});
export type BuyItemRequest = z.infer<typeof BuyItemRequestSchema>;

export const BuyItemResponseSchema = z.object({
  cash: MoneySchema,
  itemId: z.string().uuid(),
  qty: z.number().int(),
  stock: z.number().int().nonnegative(),
});
export type BuyItemResponse = z.infer<typeof BuyItemResponseSchema>;
```

- [ ] **Step 3: Create `packages/shared/src/dto/combat.ts`**

```ts
import { z } from "zod";
import { MoneySchema } from "../primitives.js";

/**
 * Why a target cannot be shot — combat's own legality answers. `null` when
 * they can be. `target_elsewhere` is absent from this union because such a
 * player is simply not in the list.
 */
export const TargetReasonSchema = z.enum([
  "hospitalised", "jailed", "gang_mate", "newbie_protected", "newbie_self",
]);
export type TargetReason = z.infer<typeof TargetReasonSchema>;

export const CombatTargetSchema = z.object({
  playerId: z.string().uuid(),
  username: z.string(),
  rank: z.string().nullable(),
  health: z.number().int(),
  maxHealth: z.number().int(),
  attackable: z.boolean(),
  reason: TargetReasonSchema.nullable(),
});
export type CombatTarget = z.infer<typeof CombatTargetSchema>;

export const CombatTargetListResponseSchema = z.object({
  targets: z.array(CombatTargetSchema),
});
export type CombatTargetListResponse = z.infer<typeof CombatTargetListResponseSchema>;

export const AttackResponseSchema = z.object({
  hit: z.boolean(),
  crit: z.boolean(),
  damage: z.number().int(),
  armorAbsorbed: z.number().int(),
  targetHealth: z.number().int(),
  targetKilled: z.boolean(),
  payout: MoneySchema,
  bulletsSpent: z.number().int(),
});
export type AttackResponse = z.infer<typeof AttackResponseSchema>;

export const CombatLogEntrySchema = z.object({
  id: z.string().uuid(),
  attackerId: z.string().uuid(),
  targetId: z.string().uuid(),
  hit: z.boolean(),
  damage: z.number().int(),
  fatal: z.boolean(),
  payout: MoneySchema,
  createdAt: z.string(),
});
export type CombatLogEntry = z.infer<typeof CombatLogEntrySchema>;

export const CombatLogResponseSchema = z.object({
  entries: z.array(CombatLogEntrySchema),
});
export type CombatLogResponse = z.infer<typeof CombatLogResponseSchema>;
```

`CombatTargetSchema` is Task 6's own response and is authoritative. The other
two are not: `AttackResponseSchema` and `CombatLogEntrySchema` describe routes
that already shipped, so read `attackRoute` and `logRoute` in
`packages/plugins/combat/src/index.ts` and make these match what they actually
return — field names, nullability, and whether `createdAt` serialises as a
string. Where they disagree, **the shipped route wins**; do not change it to
fit this schema.

- [ ] **Step 4: Create `packages/shared/src/dto/hospital.ts`**

```ts
import { z } from "zod";
import { MoneySchema } from "../primitives.js";

/** Mirrors `GET /api/hospital` (apps/server/src/game/hospital/routes.ts:49). */
export const HospitalStatusSchema = z.object({
  health: z.number().int(),
  maxHealth: z.number().int(),
  hospitalised: z.boolean(),
  until: z.string().nullable(),
  remainingSeconds: z.number().int().nonnegative(),
  dischargeCost: MoneySchema,
});
export type HospitalStatus = z.infer<typeof HospitalStatusSchema>;

export const DischargeResponseSchema = z.object({
  health: z.number().int(),
  cash: MoneySchema,
  paid: MoneySchema,
});
export type DischargeResponse = z.infer<typeof DischargeResponseSchema>;
```

`until` is `string | null` because it is serialised from a `Date | null`. Confirm by reading what `checkHospital` puts in `status.until` — if it is already a string, or if it is `undefined` rather than `null`, widen the schema to match the server rather than changing the server.

- [ ] **Step 5: Export them**

In `packages/shared/src/index.ts`, add four lines alongside the existing `export * from "./dto/*.js"` block, keeping it alphabetical:

```ts
export * from "./dto/combat.js";
export * from "./dto/hospital.js";
export * from "./dto/inventory.js";
export * from "./dto/shop.js";
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: clean. There is no test in this task: these are type declarations with no behaviour, and Tasks 8–12 exercise them by parsing real responses.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/dto/inventory.ts packages/shared/src/dto/shop.ts \
        packages/shared/src/dto/combat.ts packages/shared/src/dto/hospital.ts \
        packages/shared/src/index.ts
git commit -m "feat(shared): add inventory, shop, combat and hospital DTOs"
```

---

### Task 8: Web query keys, hooks, invalidation, and the effects reader

**Files:**
- Create: `apps/web/src/lib/effects.ts`
- Create: `apps/web/test/effects.test.ts`
- Modify: `apps/web/src/api/keys.ts`, `apps/web/src/api/queries.ts`, `apps/web/src/ws/invalidation.ts`, `apps/web/src/lib/errors.ts`
- Test: `apps/web/test/invalidation.test.ts`, `apps/web/test/errors.test.ts`

**Interfaces:**
- Consumes: every DTO from Task 7; `api` and `ApiError` from `apps/web/src/api/client.js`; `keys` from `api/keys.js`.
- Produces: `keys.inventory()`, `keys.shop()`, `keys.combatTargets()`, `keys.combatLog()`, `keys.hospital()`; hooks `useInventory`, `useEquip`, `useUseItem`, `useShop`, `useBuyItem`, `useCombatTargets`, `useAttack`, `useCombatLog`, `useHospital`, `useDischarge`; `numericEffect(effects, field): number | null`.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/test/effects.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { numericEffect } from "../src/lib/effects.js";

describe("numericEffect", () => {
  it("reads a numeric field out of an unknown effects blob", () => {
    expect(numericEffect({ damageMin: 8, damageMax: 18 }, "damageMin")).toBe(8);
  });

  it("returns null for a missing field", () => {
    expect(numericEffect({ damageMin: 8 }, "armor")).toBeNull();
  });

  it("returns null for a non-numeric value rather than coercing it", () => {
    expect(numericEffect({ armor: "12" }, "armor")).toBeNull();
  });

  it("returns null for null, undefined and non-objects", () => {
    expect(numericEffect(null, "armor")).toBeNull();
    expect(numericEffect(undefined, "armor")).toBeNull();
    expect(numericEffect(42, "armor")).toBeNull();
    expect(numericEffect("nope", "armor")).toBeNull();
  });

  it("returns null for NaN", () => {
    expect(numericEffect({ armor: Number.NaN }, "armor")).toBeNull();
  });
});
```

Append to `apps/web/test/invalidation.test.ts` — match that file's existing call style for `invalidationKeys`:

```ts
it("refreshes the combat surfaces when a shot lands", () => {
  const event = {
    type: "player.attacked" as const,
    actorId: "a", actorName: "A", targetId: "b", targetName: "B", damage: 12,
  };
  const got = invalidationKeys(event as GameEvent, "a");
  expect(got).toContainEqual(["me"]);
  expect(got).toContainEqual(["combat", "targets"]);
});

it("refreshes hospital when someone is killed", () => {
  const event = {
    type: "player.killed" as const,
    actorId: "a", actorName: "A", victimId: "b", victimName: "B",
  };
  const got = invalidationKeys(event as GameEvent, "a");
  expect(got).toContainEqual(["hospital"]);
  expect(got).toContainEqual(["combat", "log"]);
});
```

Fill in each event object's remaining required fields from `packages/shared`'s `GameEvent` union so the cast is honest — read it rather than guessing, and drop the `as GameEvent` if the object already satisfies the type.

Append to `apps/web/test/errors.test.ts` — that file already asserts `insufficient_stock` with `available: 3` produces bullets-specific copy. Change that existing expectation and add the new ones:

```ts
it("describes insufficient_stock without naming bullets", () => {
  const message = describeError(new ApiError(409, "insufficient_stock", { available: 3 }));
  expect(message).toContain("3");
  expect(message).not.toContain("bullets");
});

it("describes not_sold_here and no_location", () => {
  expect(describeError(new ApiError(409, "not_sold_here"))).toBeTruthy();
  expect(describeError(new ApiError(409, "no_location"))).toBeTruthy();
});
```

Match the existing file's `ApiError` construction exactly — read the first few lines of `apps/web/test/errors.test.ts` and copy its shape; `ApiError`'s constructor signature is in `apps/web/src/api/client.ts`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project @gl3/web`
Expected: FAIL — `effects.test.ts` cannot resolve `../src/lib/effects.js`; the invalidation cases get only `[["me"]]`; the `insufficient_stock` case still contains "bullets".

- [ ] **Step 3: Write `apps/web/src/lib/effects.ts`**

```ts
/**
 * Pull one numeric field out of an item's `effects`.
 *
 * The DTO types `effects` as `unknown` because the server passes an
 * unrecognised `item_type`'s jsonb through untouched (see dto/inventory.ts).
 * Rather than casting at every call site, pages read individual fields through
 * here: a missing, non-numeric or NaN value is `null`, which a page renders as
 * a dash instead of "undefined" or "NaN".
 */
export function numericEffect(effects: unknown, field: string): number | null {
  if (typeof effects !== "object" || effects === null) return null;
  const value = (effects as Record<string, unknown>)[field];
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  return value;
}
```

The single cast is confined to this one tested function — `apps/*` prefers `unknown` plus a narrowing check, which is what the `typeof` guard above is.

- [ ] **Step 4: Add the query keys**

In `apps/web/src/api/keys.ts`, after `plugins`:

```ts
  // Pass 4 (items and combat). `shop` is not keyed by location: the route
  // answers for wherever the caller currently is, and travelling invalidates
  // it through player.travelled anyway.
  inventory: () => ["inventory"] as const,
  shop: () => ["shop"] as const,
  combatTargets: () => ["combat", "targets"] as const,
  combatLog: () => ["combat", "log"] as const,
  hospital: () => ["hospital"] as const,
```

- [ ] **Step 5: Add the hooks**

Append to `apps/web/src/api/queries.ts`, adding the Task 7 schemas and types to the big `@gl3/shared` import:

```ts
export function useInventory() {
  return useQuery<InventoryResponse>({
    queryKey: keys.inventory(),
    queryFn: async () => InventoryResponseSchema.parse(await api("/api/inventory")),
  });
}

export function useEquip() {
  const queryClient = useQueryClient();
  return useMutation<EquipResponse, Error, EquipRequest>({
    mutationFn: async (request) =>
      EquipResponseSchema.parse(
        await api("/api/inventory/equip", { method: "PUT", body: JSON.stringify(request) }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.inventory() });
    },
  });
}

export function useUseItem() {
  const queryClient = useQueryClient();
  return useMutation<UseItemResponse, Error, string>({
    mutationFn: async (itemId) =>
      UseItemResponseSchema.parse(await api(`/api/inventory/use/${itemId}`, { method: "POST" })),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.inventory() });
      // Health changed, and both of these show it.
      void queryClient.invalidateQueries({ queryKey: keys.me() });
      void queryClient.invalidateQueries({ queryKey: keys.hospital() });
    },
  });
}

export function useShop() {
  return useQuery<ShopListResponse>({
    queryKey: keys.shop(),
    queryFn: async () => ShopListResponseSchema.parse(await api("/api/shop")),
    // A player who is nowhere gets a 409; that is a stable answer, not a
    // transient failure, so do not retry it.
    retry: false,
  });
}

export function useBuyItem() {
  const queryClient = useQueryClient();
  return useMutation<BuyItemResponse, Error, BuyItemRequest>({
    mutationFn: async (request) =>
      BuyItemResponseSchema.parse(
        await api("/api/shop/buy", { method: "POST", body: JSON.stringify(request) }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.me() });
      void queryClient.invalidateQueries({ queryKey: keys.shop() });
      void queryClient.invalidateQueries({ queryKey: keys.inventory() });
    },
  });
}

export function useCombatTargets() {
  return useQuery<CombatTargetListResponse>({
    queryKey: keys.combatTargets(),
    queryFn: async () => CombatTargetListResponseSchema.parse(await api("/api/combat/targets")),
  });
}

export function useCombatLog() {
  return useQuery<CombatLogResponse>({
    queryKey: keys.combatLog(),
    queryFn: async () => CombatLogResponseSchema.parse(await api("/api/combat/log")),
  });
}

export function useAttack() {
  const queryClient = useQueryClient();
  return useMutation<AttackResponse, Error, string>({
    mutationFn: async (targetId) =>
      AttackResponseSchema.parse(await api(`/api/combat/attack/${targetId}`, { method: "POST" })),
    onSuccess: () => {
      // Bullets and (on a kill) cash moved; the target's health and the log
      // both changed.
      void queryClient.invalidateQueries({ queryKey: keys.me() });
      void queryClient.invalidateQueries({ queryKey: keys.combatTargets() });
      void queryClient.invalidateQueries({ queryKey: keys.combatLog() });
    },
  });
}

export function useHospital() {
  return useQuery<HospitalStatus>({
    queryKey: keys.hospital(),
    queryFn: async () => HospitalStatusSchema.parse(await api("/api/hospital")),
    // Same reason as the jail query: nothing frees a player on a timer, so the
    // page polls to notice the sentence elapsing.
    refetchInterval: JAIL_POLL_MS,
  });
}

export function useDischarge() {
  const queryClient = useQueryClient();
  return useMutation<DischargeResponse, Error, void>({
    mutationFn: async () =>
      DischargeResponseSchema.parse(await api("/api/hospital/discharge", { method: "POST" })),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.hospital() });
      void queryClient.invalidateQueries({ queryKey: keys.me() });
    },
  });
}
```

- [ ] **Step 6: Update the invalidation map**

In `apps/web/src/ws/invalidation.ts`, replace the `player.attacked` / `player.killed` arm:

```ts
    case "player.attacked":
      // Bullets moved and the target's health did, so the list a player is
      // looking at is stale; the log gains a row for both parties.
      return [keys.me(), keys.combatTargets(), keys.combatLog()];
    case "player.killed":
      // The victim is now hospitalised — for them that is the whole page, and
      // for the killer it is why the target vanished from the list.
      return [keys.me(), keys.combatTargets(), keys.combatLog(), keys.hospital()];
```

Delete the now-stale sentence in that file's doc comment listing attacks among the event types "whose surfaces have no server routes at all".

Then add `keys.shop()` to the `player.travelled` arm, alongside whatever it
already returns. Stock is per-location and the shop query is not keyed by
location, so without this a traveller keeps seeing the city they left. Add a
test case for it next to the two above, asserting the travelled arm contains
`["shop"]`.

- [ ] **Step 7: Generalise the `insufficient_stock` copy**

In `apps/web/src/lib/errors.ts`, the `insufficient_stock` branch currently renders `` `Only ${error.available} bullets left here.` ``. Both the bullets shop and the item shop now raise it, and neither the code nor `ApiError` says which. Replace with:

```ts
      return `Only ${error.available} left in stock here.`;
```

and add to `MESSAGES` (matching that object's existing style):

```ts
  not_sold_here: "This location doesn't stock that.",
  no_location: "You aren't anywhere yet — travel somewhere first.",
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run --project @gl3/web`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/lib/effects.ts apps/web/test/effects.test.ts \
        apps/web/src/api/keys.ts apps/web/src/api/queries.ts \
        apps/web/src/ws/invalidation.ts apps/web/src/lib/errors.ts \
        apps/web/test/invalidation.test.ts apps/web/test/errors.test.ts
git commit -m "feat(web): add inventory, shop, combat and hospital query hooks"
```

---

## A note on Tasks 9–12 (the four pages)

Per spec §7.3 these pages carry **no automated tests**: `apps/web` has no DOM
test environment, its vitest project is pure functions only, and the twenty
pages already shipped are verified by a human at a browser. The tested part of
this work is the server (Tasks 1–6) and the pure client modules (Task 8).

So the TDD cycle for these four tasks is: **typecheck, then look at it.** Each
task ends with `npm run typecheck` and a manual walkthrough whose exact clicks
are written out. Do not skip the walkthrough — it is the only verification
these tasks have.

Before writing the first one, read two existing pages end to end:
`apps/web/src/pages/Bullets.tsx` (a buy form with money, stock and an
affordability check — Task 10 is its shape) and `apps/web/src/pages/Jail.tsx`
(a timed-state page with a pay-to-clear button — Task 12 is its shape). Match
their loading/error/empty handling, their class names and their component
structure rather than inventing new ones. Where the code below differs from
what those files do, **they win** — this plan cannot see them.

Each page also needs its route and nav entry, which live in two files every one
of the four touches:

- `apps/web/src/App.tsx` — a `<Route path="…" element={<X />} />` inside the
  same authenticated block the other gameplay pages sit in, plus the import.
- `apps/web/src/components/Shell.tsx` — an entry in the `LINKS` array, matching
  the existing shape exactly (read it; it is a list of `{to, label}`-ish
  objects and the exact key names matter).

---

### Task 9: The `/inventory` page

**Files:**
- Create: `apps/web/src/pages/Inventory.tsx`
- Modify: `apps/web/src/App.tsx`, `apps/web/src/components/Shell.tsx`

**Interfaces:**
- Consumes: `useInventory`, `useEquip`, `useUseItem`, `useMe` (Task 8 and existing); `numericEffect` (Task 8); `describeError` from `../lib/errors.js`.
- Produces: nothing other tasks import. The route path `/inventory` is what Task 10's shop page links to and what `Shell.tsx` lists.

- [ ] **Step 1: Write the page**

Create `apps/web/src/pages/Inventory.tsx`:

```tsx
import type { InventoryItem } from "@gl3/shared";
import { useInventory, useEquip, useMe, useUseItem } from "../api/queries.js";
import { describeError } from "../lib/errors.js";
import { numericEffect } from "../lib/effects.js";

/**
 * The three item types this page renders specially. Anything else is listed
 * under "Other" with no actions: `item_type` is unconstrained text and the
 * server passes an unrecognised type's effects through untouched, so the page
 * must not assume it knows every type either.
 */
const WEAPON = "weapon";
const ARMOR = "armor";
const CONSUMABLE = "consumable";

function ItemStats({ item }: { item: InventoryItem }) {
  if (item.itemType === WEAPON) {
    const min = numericEffect(item.effects, "damageMin");
    const max = numericEffect(item.effects, "damageMax");
    if (min === null || max === null) return <span className="muted">unusable</span>;
    return <span className="muted">{min}–{max} damage</span>;
  }
  if (item.itemType === ARMOR) {
    const armor = numericEffect(item.effects, "armor");
    if (armor === null) return <span className="muted">unusable</span>;
    return <span className="muted">{armor} armor</span>;
  }
  if (item.itemType === CONSUMABLE) {
    const heal = numericEffect(item.effects, "heal");
    if (heal === null) return <span className="muted">unusable</span>;
    return <span className="muted">heals {heal}</span>;
  }
  return null;
}

export default function Inventory() {
  const inventory = useInventory();
  const me = useMe();
  const equip = useEquip();
  const useItem = useUseItem();

  if (inventory.isLoading) return <p>Loading…</p>;
  if (inventory.error) return <p className="error">{describeError(inventory.error)}</p>;
  if (!inventory.data) return null;

  const { items, equipped } = inventory.data;
  const health = me.data?.health ?? 0;
  const maxHealth = me.data?.maxHealth ?? 100;
  const full = health >= maxHealth;

  const weapons = items.filter((i) => i.itemType === WEAPON);
  const armors = items.filter((i) => i.itemType === ARMOR);
  const consumables = items.filter((i) => i.itemType === CONSUMABLE);
  const others = items.filter(
    (i) => i.itemType !== WEAPON && i.itemType !== ARMOR && i.itemType !== CONSUMABLE,
  );

  // The mutation whose error is worth showing is whichever ran last; both
  // report through describeError so `rank_too_low`, `wrong_slot`, `not_owned`
  // and `already_full` read as sentences rather than codes.
  const actionError = equip.error ?? useItem.error;

  return (
    <section>
      <h1>Inventory</h1>
      <p>Health {health} / {maxHealth}</p>
      {actionError ? <p className="error">{describeError(actionError)}</p> : null}

      <h2>Equipped</h2>
      <ul>
        <li>
          Weapon: {equipped.weaponItemId
            ? items.find((i) => i.itemId === equipped.weaponItemId)?.name ?? "unknown"
            : "none"}
          {equipped.weaponItemId ? (
            <button
              type="button"
              disabled={equip.isPending}
              // Explicit null unequips. Omitting the key would leave the slot
              // alone — that distinction is the whole reason the request
              // schema is `.nullable().optional()`.
              onClick={() => equip.mutate({ weaponItemId: null })}
            >
              Unequip
            </button>
          ) : null}
        </li>
        <li>
          Armor: {equipped.armorItemId
            ? items.find((i) => i.itemId === equipped.armorItemId)?.name ?? "unknown"
            : "none"}
          {equipped.armorItemId ? (
            <button
              type="button"
              disabled={equip.isPending}
              onClick={() => equip.mutate({ armorItemId: null })}
            >
              Unequip
            </button>
          ) : null}
        </li>
      </ul>

      {items.length === 0 ? (
        <p>You own nothing. Buy something at the shop.</p>
      ) : null}

      {weapons.length > 0 ? (
        <>
          <h2>Weapons</h2>
          <ul>
            {weapons.map((item) => (
              <li key={item.itemId}>
                {item.name} ×{item.qty} <ItemStats item={item} />
                <button
                  type="button"
                  disabled={equip.isPending || item.itemId === equipped.weaponItemId}
                  onClick={() => equip.mutate({ weaponItemId: item.itemId })}
                >
                  {item.itemId === equipped.weaponItemId ? "Equipped" : "Equip"}
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {armors.length > 0 ? (
        <>
          <h2>Armor</h2>
          <ul>
            {armors.map((item) => (
              <li key={item.itemId}>
                {item.name} ×{item.qty} <ItemStats item={item} />
                <button
                  type="button"
                  disabled={equip.isPending || item.itemId === equipped.armorItemId}
                  onClick={() => equip.mutate({ armorItemId: item.itemId })}
                >
                  {item.itemId === equipped.armorItemId ? "Equipped" : "Equip"}
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {consumables.length > 0 ? (
        <>
          <h2>Consumables</h2>
          {full ? <p className="muted">You're at full health — nothing to heal.</p> : null}
          <ul>
            {consumables.map((item) => (
              <li key={item.itemId}>
                {item.name} ×{item.qty} <ItemStats item={item} />
                <button
                  type="button"
                  disabled={useItem.isPending || full}
                  onClick={() => useItem.mutate(item.itemId)}
                >
                  Use
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {others.length > 0 ? (
        <>
          <h2>Other</h2>
          <ul>
            {others.map((item) => (
              <li key={item.itemId}>{item.name} ×{item.qty}</li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
```

`me.data?.health` / `me.data?.maxHealth`: confirm those field names against
`MeResponseSchema` in `packages/shared` before running. If `/api/me` does not
carry health, drop the header line and the `full` guard and let the server's
`already_full` 409 explain it instead — do **not** add a field to `/api/me`
for this.

Match the file's default-export style to the other pages: if they use
`export function Inventory()` with a named import in `App.tsx`, do that
instead.

- [ ] **Step 2: Wire the route and nav**

In `apps/web/src/App.tsx`, next to the other gameplay routes:

```tsx
<Route path="/inventory" element={<Inventory />} />
```

In `apps/web/src/components/Shell.tsx`, add an `Inventory` entry to `LINKS`
pointing at `/inventory`, placed near the other character-facing links.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Walk it in a browser**

Start the server and web dev server the way `docs/` describes. Then, as a
registered player who owns the two seeded items (buy them in Task 10, or insert
`player_items` rows by hand for this pass):

1. `/inventory` lists them under Weapons and Consumables with their stats.
2. Equip the pistol → the Equipped list names it, its button reads "Equipped"
   and is disabled.
3. Unequip → back to "none".
4. Use a First Aid Kit at full health → the page shows the `already_full`
   sentence, not a raw code.
5. Take damage (get shot, or `UPDATE player_stats SET health = 40`), use the
   kit → health rises, quantity drops by one, no reload needed.
6. Own nothing → the "you own nothing" line appears instead of empty headings.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/Inventory.tsx apps/web/src/App.tsx \
        apps/web/src/components/Shell.tsx
git commit -m "feat(web): add the inventory page"
```

---

### Task 10: The `/shop` page

**Files:**
- Create: `apps/web/src/pages/Shop.tsx`
- Modify: `apps/web/src/App.tsx`, `apps/web/src/components/Shell.tsx`

**Interfaces:**
- Consumes: `useShop`, `useBuyItem`, `useMe`; `numericEffect`; `describeError`; the money helpers `apps/web/src/lib/money.ts` already exports (`formatMoney`, `multiplyMoney`, `canAfford` — read that file and use its real names).
- Produces: nothing other tasks import.

- [ ] **Step 1: Write the page**

Create `apps/web/src/pages/Shop.tsx`:

```tsx
import { useState } from "react";
import type { ShopItem } from "@gl3/shared";
import { useBuyItem, useMe, useShop } from "../api/queries.js";
import { describeError } from "../lib/errors.js";
import { numericEffect } from "../lib/effects.js";
import { canAfford, formatMoney, multiplyMoney } from "../lib/money.js";

function Stats({ item }: { item: ShopItem }) {
  if (item.itemType === "weapon") {
    const min = numericEffect(item.effects, "damageMin");
    const max = numericEffect(item.effects, "damageMax");
    return min === null || max === null ? null : <span className="muted">{min}–{max} damage</span>;
  }
  if (item.itemType === "armor") {
    const armor = numericEffect(item.effects, "armor");
    return armor === null ? null : <span className="muted">{armor} armor</span>;
  }
  if (item.itemType === "consumable") {
    const heal = numericEffect(item.effects, "heal");
    return heal === null ? null : <span className="muted">heals {heal}</span>;
  }
  return null;
}

function Row({ item, cash }: { item: ShopItem; cash: string }) {
  const [quantity, setQuantity] = useState(1);
  const buy = useBuyItem();

  const total = multiplyMoney(item.price, quantity);
  const affordable = canAfford(cash, total);
  const inStock = quantity > 0 && quantity <= item.stock;

  return (
    <li>
      <strong>{item.name}</strong> <Stats item={item} />
      <span> {formatMoney(item.price)} each · {item.stock} in stock</span>
      <input
        type="number"
        min={1}
        max={item.stock}
        value={quantity}
        onChange={(event) => setQuantity(Number(event.target.value))}
      />
      <span> total {formatMoney(total)}</span>
      <button
        type="button"
        disabled={buy.isPending || !affordable || !inStock}
        onClick={() => buy.mutate({ itemId: item.itemId, quantity })}
      >
        Buy
      </button>
      {!affordable ? <span className="muted"> can't afford</span> : null}
      {/*
        The button's disabled state is a courtesy, not the rule: stock can go
        to zero between the render and the click, and the server answers
        insufficient_stock either way. Show whatever it says.
      */}
      {buy.error ? <span className="error"> {describeError(buy.error)}</span> : null}
    </li>
  );
}

export default function Shop() {
  const shop = useShop();
  const me = useMe();

  if (shop.isLoading) return <p>Loading…</p>;
  // Covers no_location: the hook does not retry it, and describeError turns it
  // into "You aren't anywhere yet — travel somewhere first."
  if (shop.error) return <p className="error">{describeError(shop.error)}</p>;
  if (!shop.data) return null;

  const cash = me.data?.cash ?? "0";
  const forSale = shop.data.items.filter((item) => item.stock > 0);

  return (
    <section>
      <h1>Shop</h1>
      <p>Cash {formatMoney(cash)}</p>
      {forSale.length === 0 ? (
        <p>Nothing for sale here. Try another city.</p>
      ) : (
        <ul>
          {forSale.map((item) => <Row key={item.itemId} item={item} cash={cash} />)}
        </ul>
      )}
    </section>
  );
}
```

Each row owns its own `useBuyItem` so one row's pending/error state does not
blank out its neighbours — that is why `Row` is a component rather than a
`.map` body.

`formatMoney`, `multiplyMoney` and `canAfford`: read
`apps/web/src/lib/money.ts` and use its actual exports and argument order.
`Bullets.tsx` already calls all three; copy from there rather than from this
plan if they disagree.

- [ ] **Step 2: Wire the route and nav**

`<Route path="/shop" element={<Shop />} />` in `App.tsx`; a `Shop` entry in
`Shell.tsx`'s `LINKS`, next to Bullets — both are "spend cash where you are".

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Walk it in a browser**

1. As a player in a seeded city, `/shop` lists Rusty Pistol and First Aid Kit
   with prices and stock.
2. Buy one kit → cash drops, stock drops by one, `/inventory` shows it.
3. Type a quantity above your cash → the button disables and "can't afford"
   appears.
4. Buy the last unit of something (set `stock = 1` by hand) → it disappears
   from the list on the next render.
5. Travel to another city → the list is that city's stock. It refreshes without
   a reload, because `player.travelled` invalidates `["shop"]` — if it does not,
   check that arm in `ws/invalidation.ts`.
6. `UPDATE player_stats SET location_id = NULL` for yourself → the page shows
   the travel-somewhere-first sentence rather than spinning.
7. Get hospitalised, then try to buy → the 423 is reported, not swallowed.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/Shop.tsx apps/web/src/App.tsx \
        apps/web/src/components/Shell.tsx
git commit -m "feat(web): add the shop page"
```

---

### Task 11: The `/combat` page

**Files:**
- Create: `apps/web/src/pages/Combat.tsx`
- Modify: `apps/web/src/App.tsx`, `apps/web/src/components/Shell.tsx`

**Interfaces:**
- Consumes: `useCombatTargets`, `useCombatLog`, `useAttack`, `useMe`; `describeError`; `formatMoney`. `TargetReason` from `@gl3/shared` (Task 7).
- Produces: nothing other tasks import.

- [ ] **Step 1: Write the page**

Create `apps/web/src/pages/Combat.tsx`:

```tsx
import type { TargetReason } from "@gl3/shared";
import { useAttack, useCombatLog, useCombatTargets, useMe } from "../api/queries.js";
import { describeError } from "../lib/errors.js";
import { formatMoney } from "../lib/money.js";

/**
 * The list is advisory. `attack` re-checks every rule under the lock, and it
 * claims its Redis cooldown BEFORE the transaction and deliberately does not
 * release it on a 4xx — so firing at an illegal target costs a full cooldown.
 * Greying those rows out is the point of the endpoint, not decoration.
 */
const REASONS: Record<TargetReason, string> = {
  hospitalised: "In hospital",
  jailed: "In jail",
  gang_mate: "Your gang",
  newbie_protected: "Under newbie protection",
  newbie_self: "You're still under newbie protection",
};

export default function Combat() {
  const targets = useCombatTargets();
  const log = useCombatLog();
  const me = useMe();
  const attack = useAttack();

  if (targets.isLoading) return <p>Loading…</p>;
  if (targets.error) return <p className="error">{describeError(targets.error)}</p>;

  const rows = targets.data?.targets ?? [];
  const entries = log.data?.entries ?? [];
  const myId = me.data?.id ?? null;

  return (
    <section>
      <h1>Combat</h1>
      {attack.error ? <p className="error">{describeError(attack.error)}</p> : null}
      {attack.data ? (
        <p>
          {attack.data.hit
            ? `${attack.data.crit ? "Critical! " : ""}${attack.data.damage} damage` +
              (attack.data.armorAbsorbed > 0
                ? ` (${attack.data.armorAbsorbed} absorbed)`
                : "") +
              (attack.data.targetKilled
                ? ` — killed, took ${formatMoney(attack.data.payout)}`
                : ` — they're on ${attack.data.targetHealth}`)
            : "Missed."}
        </p>
      ) : null}

      <h2>Here now</h2>
      {rows.length === 0 ? (
        <p>Nobody else is in this city.</p>
      ) : (
        <ul>
          {rows.map((target) => (
            <li key={target.playerId} className={target.attackable ? undefined : "muted"}>
              {target.username}
              {target.rank ? ` · ${target.rank}` : null}
              {" · "}{target.health}/{target.maxHealth}
              {target.attackable ? (
                <button
                  type="button"
                  disabled={attack.isPending}
                  onClick={() => attack.mutate(target.playerId)}
                >
                  Shoot
                </button>
              ) : (
                <span> — {target.reason ? REASONS[target.reason] : "Can't be shot"}</span>
              )}
            </li>
          ))}
        </ul>
      )}

      <h2>Recent fights</h2>
      {entries.length === 0 ? (
        <p>Nothing yet.</p>
      ) : (
        <ul>
          {entries.map((entry) => (
            <li key={entry.id}>
              {entry.attackerId === myId ? "You shot" : "You were shot by"}{" "}
              {entry.hit ? `for ${entry.damage}` : "and it missed"}
              {entry.fatal ? " — fatal" : null}
              {entry.payout !== "0" ? ` · ${formatMoney(entry.payout)}` : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
```

Two things to check against the real code rather than trusting this plan:
`me.data?.id` (the field naming the viewer — it may be `playerId`), and the
combat log rendering, since `GET /api/combat/log` returns both sides' fights
and only the ids distinguish them. If the log carries usernames, use them.

`describeError` must already have sentences for combat's codes
(`target_hospitalised`, `target_jailed`, `same_gang`, `newbie_protected`,
`no_weapon`, `no_bullets`, `target_elsewhere`, `cooldown`). If it does not,
add them in this task in the same style as Task 8 Step 7 — a raw code on a
button click is exactly the failure this page exists to avoid.

- [ ] **Step 2: Wire the route and nav**

`<Route path="/combat" element={<Combat />} />`; a `Combat` entry in `LINKS`.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Walk it in a browser**

Two browsers, or one browser and one `curl` session, as two players in the
same city:

1. Each sees the other listed; neither sees themselves.
2. With no weapon equipped, Shoot → the no-weapon sentence, not a code.
3. Equip the pistol, buy bullets, Shoot → damage line appears, the target's
   health in the list drops, the log gains a row — all without a reload.
4. Keep shooting until they die → the kill line shows the payout, they vanish
   from the list, and **their** browser lands on the hospital state.
5. Shoot again immediately → the cooldown sentence.
6. Join the same gang → the row greys out and reads "Your gang".
7. Travel away → they are gone from the list.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/Combat.tsx apps/web/src/App.tsx \
        apps/web/src/components/Shell.tsx apps/web/src/lib/errors.ts
git commit -m "feat(web): add the combat page"
```

---

### Task 12: The `/hospital` page

**Files:**
- Create: `apps/web/src/pages/Hospital.tsx`
- Modify: `apps/web/src/App.tsx`, `apps/web/src/components/Shell.tsx`

**Interfaces:**
- Consumes: `useHospital`, `useDischarge`, `useMe`; `describeError`; `formatMoney`; `canAfford`.
- Produces: nothing other tasks import.

Without this page a killed player meets a `423` on every action page with no
way to read or clear it. `Jail.tsx` is the model — read it first and mirror its
countdown handling rather than inventing a second one.

- [ ] **Step 1: Write the page**

Create `apps/web/src/pages/Hospital.tsx`:

```tsx
import { useDischarge, useHospital, useMe } from "../api/queries.js";
import { describeError } from "../lib/errors.js";
import { canAfford, formatMoney } from "../lib/money.js";

function remaining(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export default function Hospital() {
  const hospital = useHospital();
  const me = useMe();
  const discharge = useDischarge();

  if (hospital.isLoading) return <p>Loading…</p>;
  if (hospital.error) return <p className="error">{describeError(hospital.error)}</p>;
  if (!hospital.data) return null;

  const status = hospital.data;
  const cash = me.data?.cash ?? "0";
  const affordable = canAfford(cash, status.dischargeCost);

  if (!status.hospitalised) {
    return (
      <section>
        <h1>Hospital</h1>
        <p>You're not in hospital. Health {status.health} / {status.maxHealth}.</p>
      </section>
    );
  }

  return (
    <section>
      <h1>Hospital</h1>
      <p>Health {status.health} / {status.maxHealth}</p>
      {/*
        The query polls, because nothing pushes an event when a sentence simply
        elapses — the same reason the jail page polls.
      */}
      <p>Out in {remaining(status.remainingSeconds)}.</p>
      <p>Discharge now for {formatMoney(status.dischargeCost)} — heals you fully.</p>
      {discharge.error ? <p className="error">{describeError(discharge.error)}</p> : null}
      <button
        type="button"
        disabled={discharge.isPending || !affordable}
        onClick={() => discharge.mutate()}
      >
        Pay and leave
      </button>
      {!affordable ? <p className="muted">You can't afford it. Wait it out.</p> : null}
    </section>
  );
}
```

- [ ] **Step 2: Wire the route and nav**

`<Route path="/hospital" element={<Hospital />} />`; a `Hospital` entry in
`LINKS`, next to Jail — they are the same kind of page.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Walk it in a browser**

1. Healthy → "You're not in hospital", with health shown.
2. Get killed (Task 11's walkthrough) → the countdown, the cost, the button.
3. Watch it without touching anything → the countdown falls as the poll fires.
4. Pay → health back to max, page flips to the not-hospitalised state, cash
   drops by exactly the quoted amount.
5. Spend down to under the cost first → the button is disabled and the
   "can't afford" line shows; force the request anyway (devtools) and the
   `insufficient_funds` sentence appears rather than a 500.
6. Let a sentence elapse instead of paying → the page flips on its own.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/Hospital.tsx apps/web/src/App.tsx \
        apps/web/src/components/Shell.tsx
git commit -m "feat(web): add the hospital page"
```

---

### Task 13: Full verification and docs

**Files:**
- Modify: `docs/STATUS.md`, `CLAUDE.md`

Nothing new is built here. This task is the gate: the checks that only pass or
fail across the whole tree, run once at the end, plus the two documents that
tell the next person what changed.

- [ ] **Step 1: Run the full suite**

Make sure no agent and no other suite is running first — overlapping runs on
this box produce hook timeouts and cross-talk that look exactly like real
regressions.

```bash
npm run verify > /tmp/verify.log 2>&1; echo "exit=$?"
```

Expected: `exit=0`. **Read the exit code, not the summary.** An unhandled
rejection anywhere makes vitest exit non-zero while still printing
`Tests N passed (N)`; that is how a missing `.catch` survived two runs reported
as green. Any non-zero exit is a failure even if every test passed.

Then read the counts off the tail of the log — file and test totals go into
`docs/STATUS.md` and `CLAUDE.md` in Step 4, and they must be the numbers this
run actually printed, not an estimate. Three test files are new
(`shop.test.ts`, `shop-concurrency.test.ts`, `effects.test.ts`), so the file
count should have risen by three from 83.

- [ ] **Step 2: Run the build the container image runs**

```bash
npx tsc --build --force apps/server/tsconfig.json
```

Expected: clean, no output. This is the check the root `tsconfig.json` hides:
`npm run typecheck` passes even when `apps/server/tsconfig.json` is missing a
project reference, and that failure then only appears in CI. `inventory` gained
three modules in this work, which is exactly the shape that trips it.

- [ ] **Step 3: Confirm no Dockerfile change is needed**

```bash
grep -c "packages/plugins/inventory" Dockerfile.server
grep -c "packages/plugins/combat" Dockerfile.server
```

Expected: `5` from each. No new plugin package was created, so no new COPY
lines are needed — this grep is the cheap proof, since a missing COPY fails
only in CI's `images` job, which cannot be run on this machine.

- [ ] **Step 4: Update `docs/STATUS.md`**

Read the file first and edit in its voice. What must change:

- The gap it currently records — "there is no way to *obtain* an item. No
  blackmarket, no trading, no shops — the only items in the game are the two
  seeded starter rows and whatever an admin inserts directly" — is now half
  closed. Replace it with what shipped (a per-location shop inside the
  `inventory` plugin, buy-only) and what still has not (player-to-player
  trading; no sell-back; no restocking; no drops from crimes or kills).
- The observation that `inventory` and `combat` are the only gameplay plugins
  with no page, and that core hospital has none — all four now exist.
- `inventory` now owns a table (`p_inventory_shop_stock`) and has migrations.
  It is the first *ported/gameplay* plugin to do so; say so, and record that
  the table carries no foreign keys deliberately and therefore adds no lock
  edges (§4.1 of the spec).
- `GET /api/combat/targets` exists and is bounded at 50, unpaginated, and
  advisory — every rule is re-checked under the lock by `attack`.
- The suite totals from Step 1.
- The `effects.ts` duplication between `combat` and `inventory` is unchanged —
  this work deliberately did not make it worse and did not fix it.

- [ ] **Step 5: Update `CLAUDE.md`**

The "Current state" paragraph names the PvP combat cluster as the most recent
work. Add one or two sentences: the item economy shipped on
`feat/item-economy` — a location shop in the `inventory` plugin (its first
table and first migrations) and the four web pages (`/inventory`, `/shop`,
`/combat`, `/hospital`) — and update the suite totals to Step 1's numbers.

Nothing in the six rules changes. No new lock pair was introduced: the buy
handler uses the existing location→player order, and the new table has no FKs.
Do not add a seventh rule.

- [ ] **Step 6: Commit**

```bash
git add docs/STATUS.md CLAUDE.md
git commit -m "docs: record the item economy and the inventory/shop/combat/hospital pages"
```

---

## Done when

- `npm run verify` exits `0`, with the three new test files present and the
  totals recorded in both documents.
- `npx tsc --build --force apps/server/tsconfig.json` is clean.
- Both greps against `Dockerfile.server` report `5`.
- Every acceptance test in Tasks 1–6 was shown failing before it was made to
  pass. The two that matter most, because they are the ones a plausible-looking
  implementation passes by accident:
  - `shop-concurrency.test.ts` must go red — stock negative — when the
    `stock >= quantity` predicate is removed from the UPDATE (Task 4, Steps 2–4).
  - `economy-invariant.test.ts` must go red when the buy handler moves cash by
    any route other than `applyBalanceChange` (Task 5).
- A human has walked all four pages in a browser (Tasks 9–12, Step 4 in each).
