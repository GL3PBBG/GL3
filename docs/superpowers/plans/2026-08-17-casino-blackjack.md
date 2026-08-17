# Casino Engine and Blackjack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a casino session engine that owns all money, plus blackjack as the first game, such that a third party can install a new casino game that never touches a balance.

**Architecture:** Two plugins. `@gl3/plugin-casino` (id `casino`) owns one table, wager escrow, payout, house resolution and a `casino.games` filter point; it declares no property type. `@gl3/plugin-blackjack` (id `blackjack`) declares a property type for the house and contributes rules as three **pure functions** through that filter point. A twelfth SDK view node, `cards`, lets an installed game render real playing cards without shipping React.

**Tech Stack:** TypeScript strict ESM, Fastify via the plugin loader, drizzle-orm over Postgres 16, zod at every boundary, vitest against real Postgres/Redis, React 18 + `@letele/playing-cards` in `apps/web`.

**Spec:** `docs/superpowers/specs/2026-08-17-casino-blackjack-design.md` — read it before Task 1. The plan argues from it; where they disagree, the spec wins and the plan is wrong.

## Global Constraints

- **Branch base.** This plan assumes `feat/properties-franchise` is merged to `main` and this branch is rebased onto it. `ownerAt` / `payOwner` / `cost`-as-lever must exist before Task 6. Verify with `git log --oneline main | grep -i "ownerAt and payOwner"` before starting.
- **No `any` in `packages/*`** — not even a cast. In `apps/*` prefer `unknown` plus a zod parse.
- **ESM only**; relative imports carry `.js` despite `.ts` sources.
- **Money is `bigint`** in Postgres and TypeScript, and crosses the wire as a decimal string (`MoneySchema`). Never a JSON number.
- **Bigint column defaults** are written `` .default(sql`0`) ``, never `.default(0n)`.
- **Every balance movement goes through `applyBalanceChange`** (rule 3).
- **Publish events only after commit** (rule 5) — the loader does this; never publish inside `db.transaction`.
- **A foreign key is a lock** (rule 6). Casino is locations-first: `location` → `player([...])` in ONE call → session row.
- **Never run `FLUSHALL`/`FLUSHDB`**; Redis is shared with other agents.
- **Never run two full test suites at once.** Use `npm run verify:related` while iterating. The last run before merge is the bare `npm run verify`, judged by **exit code**, not by its printed summary.
- **Every new `apps/server/test/*.test.ts` must be added to `vitest.workspace.ts`'s `include`** for its project, or it never runs and `verify` stays green without it.
- **A test that drives a plugin without `bootTestServer()` must call `runPluginMigrations(db, [thePlugin])` itself**, or every test in the file dies on 42P01.
- Conventional Commits. Commit at the end of every task.

---

## File Structure

**New — `packages/plugins/casino/`** (id `casino`, owns `p_casino_sessions`)

| file | responsibility |
|---|---|
| `package.json`, `tsconfig.json` | workspace package, mirroring `packages/plugins/properties/` |
| `src/games.ts` | `GameDef`, `GameStep`, the `casino.games` filter point, and `buildRegistry` |
| `src/schema.ts` | drizzle handle for `p_casino_sessions` + read-only mirrors |
| `src/migrations.ts` | the two SQL migrations |
| `src/settings.ts` | `min_bet`, `max_bet`, `session_expiry_minutes` readers with defaults |
| `src/engine.ts` | escrow, exposure check, settle — the money, called by routes |
| `src/index.ts` | manifest, the three routes, admin page |
| `src/pages.ts` | manifest-declared `adminPages` |

**New — `packages/plugins/blackjack/`** (id `blackjack`, owns nothing)

| file | responsibility |
|---|---|
| `package.json`, `tsconfig.json` | workspace package |
| `src/rules.ts` | pure: shoe, hand value, `start` / `act` / `settle` |
| `src/view.ts` | pure: `BlackjackState` → `ViewNode` |
| `src/index.ts` | manifest, `providesProperties`, the filter subscription |

**Modified**

| file | change |
|---|---|
| `packages/plugin-sdk/src/pages.ts` | add the `cards` view node |
| `apps/web/src/plugins/PageRenderer.tsx` | add the `cards` case |
| `apps/web/src/components/cards.ts` (new) | explicit code→component map — plain `.ts`, so the DOM-less `@gl3/web` project can test it |
| `apps/web/src/components/PlayingCard.tsx` (new) | the JSX wrapper over that map |
| `apps/web/src/pages/Casino.tsx` (new) | hand-written table + lobby |
| `apps/web/src/App.tsx` | route `/casino` |
| `packages/shared/src/dto/casino.ts` (new) | `CasinoLobbyResponse`, `CasinoSessionView` |
| `apps/server/src/plugins/core-plugins.ts` | import + list both plugins |
| `apps/server/package.json`, `apps/server/tsconfig.json`, root `tsconfig.json`, `vitest.workspace.ts`, `Dockerfile.server` | the registration sites, twice |

---

# PHASE 1 — the `cards` view node

Independent of the engine and mergeable alone.

### Task 1: `cards` view node in the SDK

**Files:**
- Modify: `packages/plugin-sdk/src/pages.ts`
- Test: `packages/plugin-sdk/test/pages-cards.test.ts` (create)

**Interfaces:**
- Produces: the view node `{ kind: "cards"; cards: string[] }`, valid inside `panel.children` and `list.items`. Task 2 renders it; Task 9 emits it.

- [ ] **Step 1: Write the failing test**

Create `packages/plugin-sdk/test/pages-cards.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ViewNodeSchema } from "../src/pages.js";

describe("cards view node", () => {
  it("accepts rank+suit codes, jokers and backs", () => {
    const parsed = ViewNodeSchema.parse({ kind: "cards", cards: ["Sq", "H2", "Da", "Ck", "B1", "J1"] });
    expect(parsed).toEqual({ kind: "cards", cards: ["Sq", "H2", "Da", "Ck", "B1", "J1"] });
  });

  it("accepts an empty hand", () => {
    expect(ViewNodeSchema.parse({ kind: "cards", cards: [] })).toEqual({ kind: "cards", cards: [] });
  });

  it("rejects a code that is not a component name", () => {
    // The renderer looks the code up in a map; an unmapped code would render
    // nothing and be silently dropped, which pages.ts's own header calls the
    // failure mode hardest to spot from the page that renders wrong.
    expect(() => ViewNodeSchema.parse({ kind: "cards", cards: ["S1"] })).toThrow();
    expect(() => ViewNodeSchema.parse({ kind: "cards", cards: ["queen of spades"] })).toThrow();
    expect(() => ViewNodeSchema.parse({ kind: "cards", cards: [""] })).toThrow();
  });

  it("nests inside a panel", () => {
    const node = { kind: "panel", title: "Your hand", children: [{ kind: "cards", cards: ["Sq"] }] };
    expect(() => ViewNodeSchema.parse(node)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run packages/plugin-sdk/test/pages-cards.test.ts
```

Expected: FAIL — `Invalid input` on the first test, because no `cards` member exists in the union.

- [ ] **Step 3: Add the node to `pages.ts`**

Add next to the other leaves in `leafOptions` (the array beginning at the `text` literal):

```ts
  // A hand of playing cards. Values are @letele/playing-cards component names:
  // suit initial (H/D/C/S) + rank (a, 2-10, j, q, k), plus J1/J2 jokers and
  // B1/B2 backs. Constrained at authoring time rather than at render, for the
  // reason this file's header gives: an unmapped code is silently dropped by
  // the renderer, which is the failure mode hardest to spot from the page.
  z
    .object({
      kind: z.literal("cards"),
      cards: z.array(z.string().regex(/^([HDCS](a|[2-9]|10|j|q|k)|J[12]|B[12])$/, "card must be a playing-card code")),
    })
    .strict(),
```

- [ ] **Step 4: Update the counts in the comments — and add NOTHING to the `ViewNode` union**

`ViewNode` is `z.infer<typeof Leaf> | { panel } | { list }`, and `Leaf` is a
`discriminatedUnion` over `leafOptions`. Step 3 put `cards` in `leafOptions`, so
the type union **already contains it by inference**. Do not add a hand-written
`| { kind: "cards"; cards: string[] }` member: no other leaf kind has one — only
`panel` and `list` are written by hand, because they recurse into `ViewNode[]`
and cannot come from `Leaf` — and an explicit entry would contradict the comment
directly above it.

Update three stale counts instead:

- the type-level comment above `Leaf`: "its nine non-nesting members" → **ten**
- the file header: "eleven node kinds" → **twelve**, and "Nine of the eleven are
  leaves" → "Ten of the twelve"
- the `discriminatedUnion` comment further down: "over all eleven kinds" →
  **twelve**

All three are the same drift, and fixing only some of them in the commit that
causes it is how the stale ones survive.

- [ ] **Step 5: Run the test to verify it passes**

```bash
npx vitest run packages/plugin-sdk/test/pages-cards.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 6: Typecheck the package**

```bash
npx tsc --build --force packages/plugin-sdk/tsconfig.json
```

Expected: exit 0. If `apps/web`'s `PageRenderer` switch is exhaustive over `ViewNode`, it will now fail with TS2366 — that is expected and Task 2 fixes it. Do not widen the switch here.

- [ ] **Step 7: Commit**

```bash
git add packages/plugin-sdk/src/pages.ts packages/plugin-sdk/test/pages-cards.test.ts
git commit -m "feat(sdk): cards view node"
```

---

### Task 2: Render the `cards` node

**Files:**
- Create: `apps/web/src/components/cards.ts`, `apps/web/src/components/PlayingCard.tsx`
- Modify: `apps/web/src/plugins/PageRenderer.tsx`, `apps/web/package.json`
- Test: `apps/web/test/cards.test.ts` (create)

**Interfaces:**
- Consumes: the `cards` node from Task 1.
- Produces: `cardComponent(code): CardComponent | null` and `CARD_CODES` from `apps/web/src/components/cards.ts`; `<PlayingCard code="Sq" />` and `<Hand codes={[...]} />` from `apps/web/src/components/PlayingCard.tsx`. Task 10's page uses both components.

- [ ] **Step 1: Verify the library works with React 18 before building on it**

`@letele/playing-cards@0.1.0` declares **no React peer dependency** and was last published 2023-08-18 (spec §7 risk 3). Establish it works before anything depends on it.

```bash
npm install @letele/playing-cards --workspace @gl3/web
node -e "const d=require('@letele/playing-cards'); console.log(typeof d.Sq, Object.keys(d).length)"
```

Expected: `function 55` (52 cards + 2 jokers + backs; the exact count may differ — a `function` for `Sq` and a count near 54 is the pass condition).

**If this fails**, stop and report. The fallback is vendoring the SVGs, which the CC0-1.0 licence permits outright; do not proceed on a broken dependency.

- [ ] **Step 2: Write the failing test — as pure logic, not a rendered component**

The `@gl3/web` vitest project has **no jsdom and no component rendering**, and
its `include` is `["test/**/*.test.ts"]` — a `.tsx` file is not even collected.
`vitest.workspace.ts:174-177` states the rule outright: everything there is a
function of its arguments, and anything needing a rendered component belongs in
the manual walkthrough until that project grows a DOM environment.

So the code→component map lives in a **plain `.ts` module** that the JSX imports,
and the test covers the map. Do not add `@testing-library/react` or jsdom for
this cluster; growing that project a DOM environment is its own decision, not a
side effect of shipping a casino.

Create `apps/web/test/cards.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CARD_CODES, cardComponent } from "../src/components/cards.js";

describe("card component map", () => {
  it("resolves every code the SDK schema admits", () => {
    // The two lists must agree: the schema is the authoring-time gate and this
    // map is the render-time one. A code that passes the schema and misses the
    // map renders a blank card, which is the failure hardest to spot.
    for (const code of CARD_CODES) expect(cardComponent(code)).toBeTypeOf("function");
  });

  it("covers 52 cards plus two jokers and two backs", () => {
    expect(CARD_CODES).toHaveLength(56);
  });

  it("returns null for an unknown code rather than throwing", () => {
    // The schema rejects bad codes at authoring time, but a plugin built
    // against an older SDK can still send one. A blank card is recoverable; an
    // exception unmounts the React root, because there is no ErrorBoundary
    // (pages.ts says so of the money leaf, for the same reason).
    expect(cardComponent("ZZ")).toBeNull();
    expect(cardComponent("")).toBeNull();
  });

  it("agrees with the SDK's own regex", async () => {
    const { ViewNodeSchema } = await import("@gl3/plugin-sdk");
    expect(() => ViewNodeSchema.parse({ kind: "cards", cards: [...CARD_CODES] })).not.toThrow();
  });
});
```

The last test is the one that earns its place: it fails if Task 1's regex and
this map ever drift apart, in either direction.

- [ ] **Step 3: No test-file registration needed here — confirm and move on**

The `@gl3/web` project **globs** (`include: ["test/**/*.test.ts"]`,
`vitest.workspace.ts:181`), as does `@gl3/plugin-sdk` (`:159`). The
per-file registration rule in the Global Constraints applies only to the four
`@gl3/server*` projects, which enumerate explicitly (`:189`, `:215`, `:228`,
`:250`). **Do not add an explicit entry beside the glob** — it contradicts the
file's convention for this project. Confirm the glob is still in place and
proceed.

- [ ] **Step 4: Run it to verify it fails**

```bash
npx vitest run apps/web/test/cards.test.ts
```

Expected: FAIL — cannot resolve `../src/components/cards.js`.

- [ ] **Step 5: Write the map as a plain module**

Create `apps/web/src/components/cards.ts` — no JSX, so the test can import it
in a project with no DOM:

```ts
import * as deck from "@letele/playing-cards";
import type { ComponentType, CSSProperties } from "react";

export type CardComponent = ComponentType<{ style?: CSSProperties }>;

/**
 * An EXPLICIT map, not `deck[code]`. The library's README shows
 * `import * as deck` with a dynamic lookup, which defeats tree-shaking
 * entirely and pulls all ~558 KB of SVG into the bundle whether a page shows
 * one card or none. Listing the components keeps the bundler's dead-code
 * analysis working.
 */
const CARDS: Record<string, CardComponent> = {
  Ha: deck.Ha, H2: deck.H2, H3: deck.H3, H4: deck.H4, H5: deck.H5, H6: deck.H6, H7: deck.H7,
  H8: deck.H8, H9: deck.H9, H10: deck.H10, Hj: deck.Hj, Hq: deck.Hq, Hk: deck.Hk,
  Da: deck.Da, D2: deck.D2, D3: deck.D3, D4: deck.D4, D5: deck.D5, D6: deck.D6, D7: deck.D7,
  D8: deck.D8, D9: deck.D9, D10: deck.D10, Dj: deck.Dj, Dq: deck.Dq, Dk: deck.Dk,
  Ca: deck.Ca, C2: deck.C2, C3: deck.C3, C4: deck.C4, C5: deck.C5, C6: deck.C6, C7: deck.C7,
  C8: deck.C8, C9: deck.C9, C10: deck.C10, Cj: deck.Cj, Cq: deck.Cq, Ck: deck.Ck,
  Sa: deck.Sa, S2: deck.S2, S3: deck.S3, S4: deck.S4, S5: deck.S5, S6: deck.S6, S7: deck.S7,
  S8: deck.S8, S9: deck.S9, S10: deck.S10, Sj: deck.Sj, Sq: deck.Sq, Sk: deck.Sk,
  J1: deck.J1, J2: deck.J2, B1: deck.B1, B2: deck.B2,
};

export const CARD_CODES: readonly string[] = Object.keys(CARDS);

export function cardComponent(code: string): CardComponent | null {
  return CARDS[code] ?? null;
}
```

Then create `apps/web/src/components/PlayingCard.tsx` for the JSX, which is
covered by the manual walkthrough rather than by a test:

```tsx
import { cardComponent } from "./cards.js";

export function PlayingCard({ code }: { code: string }): JSX.Element {
  const Card = cardComponent(code);
  if (Card === null) {
    // Recoverable by design — see the test. A card is 5:7 width to height.
    return <span data-card aria-label="unknown card" className="card card--unknown" />;
  }
  return (
    <span data-card className="card">
      <Card style={{ height: "100%", width: "100%" }} />
    </span>
  );
}

export function Hand({ codes }: { codes: string[] }): JSX.Element {
  return (
    <span className="hand">
      {codes.map((code, i) => (
        <PlayingCard key={`${code}-${i}`} code={code} />
      ))}
    </span>
  );
}
```

- [ ] **Step 6: Add the `cards` case to `PageRenderer`**

In `apps/web/src/plugins/PageRenderer.tsx`, alongside `case "money":`:

```tsx
      case "cards":
        return <Hand codes={node.cards} />;
```

with `import { Hand } from "../components/PlayingCard.js";` at the top.

- [ ] **Step 7: Run the tests to verify they pass**

```bash
npx vitest run apps/web/test/cards.test.ts
npx vitest run --project @gl3/web
npx tsc --build --force apps/web/tsconfig.json
```

Expected: PASS on both, and exit 0 on the build — which is what confirms the TS2366 exhaustiveness error from Task 1 Step 6 is closed. The vitest project alone would not: it never typechecks the renderer.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/cards.ts apps/web/src/components/PlayingCard.tsx \
        apps/web/src/plugins/PageRenderer.tsx apps/web/package.json \
        apps/web/test/cards.test.ts package-lock.json
git commit -m "feat(web): render the cards view node"
```

---

# PHASE 2 — the engine

### Task 3: The `casino` plugin package and its session table

**Files:**
- Create: `packages/plugins/casino/package.json`, `tsconfig.json`, `src/schema.ts`, `src/migrations.ts`, `src/settings.ts`, `src/index.ts`
- Modify: the eight registration sites (below)
- Test: `apps/server/test/casino-boot.test.ts` (create)

**Interfaces:**
- Produces: `casinoSessions` drizzle handle and `CASINO_MIGRATIONS` from `@gl3/plugin-casino`; a manifest with `basePaths: ["/api/casino"]` and no routes yet.

- [ ] **Step 1: Create the package**

`packages/plugins/casino/package.json` — mirror `packages/plugins/properties/package.json`:

```json
{
  "name": "@gl3/plugin-casino",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": { "build": "tsc --build" },
  "dependencies": {
    "@gl3/plugin-properties": "*",
    "@gl3/plugin-sdk": "*",
    "drizzle-orm": "^0.45.2",
    "zod": "^3.23.8"
  }
}
```

Copy `packages/plugins/properties/tsconfig.json` verbatim to `packages/plugins/casino/tsconfig.json`, then correct any `references` paths it carries so they point at `../properties` and `../../plugin-sdk`.

- [ ] **Step 2: Write the migrations**

Create `packages/plugins/casino/src/migrations.ts`:

```ts
/**
 * One migration per entry: `runPluginMigrations` issues exactly one
 * `tx.execute(sql.raw(...))` per declaration and postgres.js rejects a
 * multi-statement string, so the partial index is its own entry.
 *
 * The two foreign keys are deliberate and are what rule 6's lock graph is
 * reasoned about (spec §5): inserting a session takes FOR KEY SHARE on the
 * player and location rows, which this transaction already holds FOR UPDATE.
 */
export const CASINO_MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "0001_sessions",
    sql: `CREATE TABLE p_casino_sessions (
      id           uuid PRIMARY KEY,
      player_id    uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      game_id      text NOT NULL,
      location_id  uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      property_id  uuid,
      wager        bigint NOT NULL DEFAULT 0,
      state        jsonb NOT NULL,
      status       text NOT NULL,
      seed         text NOT NULL,
      created_at   timestamptz NOT NULL DEFAULT now(),
      settled_at   timestamptz
    )`,
  },
  {
    // One open hand per player across ALL games — OC's one-active-heist shape.
    // It is what makes the escrow accounting single-threaded per player.
    name: "0002_one_open_session",
    sql: `CREATE UNIQUE INDEX p_casino_sessions_one_open
            ON p_casino_sessions (player_id) WHERE status = 'open'`,
  },
];
```

`property_id` carries **no** foreign key: it is frozen at `play` (spec §4.1) and must survive the property row being re-keyed or seized mid-hand. A FK would also add a third edge to the lock graph for no benefit.

- [ ] **Step 3: Write the drizzle handle**

Create `packages/plugins/casino/src/schema.ts`:

```ts
import { sql } from "drizzle-orm";
import { bigint, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/** The table this plugin OWNS. `migrations.ts` is the definition; this handle
 *  must be kept in step with it by hand. */
export const casinoSessions = pgTable("p_casino_sessions", {
  id: uuid("id").primaryKey(),
  playerId: uuid("player_id").notNull(),
  gameId: text("game_id").notNull(),
  locationId: uuid("location_id").notNull(),
  propertyId: uuid("property_id"),
  wager: bigint("wager", { mode: "bigint" }).notNull().default(sql`0`),
  state: jsonb("state").notNull(),
  status: text("status").notNull(),
  seed: text("seed").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  settledAt: timestamp("settled_at", { withTimezone: true }),
});

/** Read-only mirrors of core-owned tables — the pattern
 *  `packages/plugins/theft/src/schema.ts` established. No FKs on mirrors. */
export const playerStats = pgTable("player_stats", {
  playerId: uuid("player_id").primaryKey(),
  locationId: uuid("location_id"),
  cash: bigint("cash", { mode: "bigint" }).notNull(),
});

export const locations = pgTable("locations", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
});

export const players = pgTable("players", {
  id: uuid("id").primaryKey(),
  username: text("username").notNull(),
});
```

- [ ] **Step 4: Write the settings readers**

Create `packages/plugins/casino/src/settings.ts`. Settings resolve DB row `casino.<key>` and return `string | null`; the plugin supplies its own default, as `packages/plugins/oc/src/settings.ts` does.

```ts
/** Settings are read via ctx.settings.get(key), which resolves DB row `casino.<key>`. */
export const DEFAULT_MIN_BET = 10_000n;             // $100 — V2's PR_cost floor
export const DEFAULT_MAX_BET = 10_000_000n;         // $100,000, when no house lever is set
export const DEFAULT_SESSION_EXPIRY_MINUTES = 30;

interface SettingsReader { get(key: string): string | null }

function readBigint(settings: SettingsReader, key: string, fallback: bigint): bigint {
  const raw = settings.get(key);
  if (raw === null || !/^\d+$/.test(raw)) return fallback;
  return BigInt(raw);
}

export function readMinBet(s: SettingsReader): bigint { return readBigint(s, "min_bet", DEFAULT_MIN_BET); }
export function readMaxBet(s: SettingsReader): bigint { return readBigint(s, "max_bet", DEFAULT_MAX_BET); }

export function readExpiryMinutes(s: SettingsReader): number {
  const raw = s.get("session_expiry_minutes");
  if (raw === null || !/^\d+$/.test(raw)) return DEFAULT_SESSION_EXPIRY_MINUTES;
  const parsed = Number(raw);
  return parsed > 0 ? parsed : DEFAULT_SESSION_EXPIRY_MINUTES;
}
```

- [ ] **Step 5: Write a minimal manifest**

Create `packages/plugins/casino/src/index.ts`:

```ts
import { definePlugin } from "@gl3/plugin-sdk";
import { CASINO_MIGRATIONS } from "./migrations.js";

export { casinoSessions } from "./schema.js";

export default definePlugin({
  id: "casino",
  version: "1.0.0",
  basePaths: ["/api/casino"],
  migrations: CASINO_MIGRATIONS,
  tables: { sessions: "p_casino_sessions" },
  routes: [],
});
```

- [ ] **Step 6: Complete all eight registration sites**

Missing any of these fails silently, in CI only, or grades against a stale `dist/` (CLAUDE.md):

1. the package itself — done in Step 1
2. `apps/server/package.json` dependencies: `"@gl3/plugin-casino": "*"`, then `npm install`
3. `apps/server/tsconfig.json` `references` — **CI-only failure if missed**
4. root `tsconfig.json` `references`
5. `vitest.workspace.ts` `srcAliases` — **fails nothing if missed**, silently grades against stale `dist/`
6. `apps/server/src/plugins/core-plugins.ts`: `import casinoPlugin from "@gl3/plugin-casino";` and add `casinoPlugin` to `CORE_PLUGINS`
7. no old `app.ts` registration to delete — this plugin is new
8. **five COPY lines in `Dockerfile.server`**, mirroring properties' at lines 59, 97, 98, 159, 186

- [ ] **Step 7: Write the boot test**

Create `apps/server/test/casino-boot.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { bootTestServer } from "./helpers/boot.js";

describe("casino plugin boot", () => {
  it("creates its table and its one-open-session partial index", async () => {
    const { db, close } = await bootTestServer();
    try {
      const cols = await db.execute(sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'p_casino_sessions' ORDER BY column_name`);
      expect(cols.map((r) => r.column_name)).toContain("property_id");

      const idx = await db.execute(sql`
        SELECT indexdef FROM pg_indexes WHERE indexname = 'p_casino_sessions_one_open'`);
      expect(idx).toHaveLength(1);
      expect(String(idx[0]?.indexdef)).toContain("WHERE (status = 'open'");
    } finally {
      await close();
    }
  });
});
```

Match the existing helper import path and `bootTestServer` return shape by copying from a current file such as `apps/server/test/admin-properties.test.ts` — do not invent a signature.

- [ ] **Step 8: Register the test file**

Add `apps/server/test/casino-boot.test.ts` to the default `@gl3/server` project's `include` in `vitest.workspace.ts`.

- [ ] **Step 9: Run it**

```bash
npx vitest run apps/server/test/casino-boot.test.ts
npx tsc --build --force apps/server/tsconfig.json
grep -c "packages/plugins/casino" Dockerfile.server   # must print 5
```

Expected: PASS, exit 0, `5`.

- [ ] **Step 10: Commit**

```bash
git add packages/plugins/casino apps/server/package.json apps/server/tsconfig.json tsconfig.json \
        vitest.workspace.ts apps/server/src/plugins/core-plugins.ts Dockerfile.server \
        apps/server/test/casino-boot.test.ts package-lock.json
git commit -m "feat(casino): plugin scaffold and session table"
```

---

### Task 4: The `casino.games` extension point

**Files:**
- Create: `packages/plugins/casino/src/games.ts`
- Modify: `packages/plugins/casino/src/index.ts`
- Test: `apps/server/test/casino-registry.test.ts` (create)

**Interfaces:**
- Produces, all exported from `@gl3/plugin-casino`:
  - `games: FilterPoint<GameDef[]>` — the point a game subscribes to
  - `interface GameStep<S> { state: S; view: ViewNode; done: boolean; wagerDelta?: bigint }`
  - `interface GameDef<S>` with `id`, `name`, `maxPayoutMultiplier`, `action`, `start`, `act`, `settle`
  - `buildRegistry(ctx, installedIds): Promise<Map<string, GameDef>>`
- Task 5 implements a `GameDef`; Tasks 6–8 consume the registry.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/casino-registry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { on } from "@gl3/plugin-sdk";
import { buildRegistry, games, type GameDef } from "@gl3/plugin-casino";

function fakeGame(id: string): GameDef<{ n: number }> {
  return {
    id, name: id, maxPayoutMultiplier: 2,
    action: z.literal("go"),
    start: () => ({ state: { n: 0 }, view: { kind: "text", value: "" }, done: false }),
    act: (state) => ({ state, view: { kind: "text", value: "" }, done: true }),
    settle: () => 0n,
  };
}

/** The registry only needs `filters.apply`; the rest of PluginCtx is unused. */
function ctxWith(subs: ReturnType<typeof on>[]) {
  return { filters: { apply: async (point, value) => {
    let cur = value;
    for (const s of subs.filter((x) => x.pointName === point.name)) cur = await s.run(ctxWith(subs), cur);
    return cur;
  } } };
}

describe("casino game registry", () => {
  it("collects a subscribed game", async () => {
    const subs = [on(games, (_c, list) => [...list, fakeGame("blackjack")])];
    const registry = await buildRegistry(ctxWith(subs), new Set(["blackjack"]));
    expect(registry.get("blackjack")?.name).toBe("blackjack");
  });

  it("rejects a game whose id is not an installed plugin id", async () => {
    // The SDK checks this for providesProperties at definePlugin time. A
    // GameDef arrives inside a filter subscription, so the hub is the only
    // place it can be checked (spec §3).
    const subs = [on(games, (_c, list) => [...list, fakeGame("nonesuch")])];
    await expect(buildRegistry(ctxWith(subs), new Set(["blackjack"]))).rejects.toThrow(/nonesuch/);
  });

  it("rejects two games claiming one id", async () => {
    const subs = [
      on(games, (_c, list) => [...list, fakeGame("blackjack")]),
      on(games, (_c, list) => [...list, fakeGame("blackjack")]),
    ];
    await expect(buildRegistry(ctxWith(subs), new Set(["blackjack"]))).rejects.toThrow(/duplicate/i);
  });
});
```

- [ ] **Step 2: Register the test file**

Add `apps/server/test/casino-registry.test.ts` to the **`@gl3/server:unit`** project's `include` — it needs neither Postgres nor Redis.

- [ ] **Step 3: Run it to verify it fails**

```bash
npx vitest run apps/server/test/casino-registry.test.ts
```

Expected: FAIL — `buildRegistry` is not exported.

- [ ] **Step 4: Write `games.ts`**

```ts
import { filterPoint, type PluginCtx, type ViewNode } from "@gl3/plugin-sdk";
import type { z } from "zod";

export interface GameStep<S> {
  state: S;
  /** What the player sees now. Rendered by PageRenderer; may contain `cards`. */
  view: ViewNode;
  done: boolean;
  /**
   * Raise the wager mid-hand (blackjack's double down; a poker raise). The hub
   * debits the player, credits the house, updates the session and RE-RUNS the
   * exposure check. A game never moves money itself.
   */
  wagerDelta?: bigint;
}

/**
 * The whole contract a casino game implements. `start`, `act` and `settle` are
 * PURE — no database, no ctx, no clock, no randomness, no io. That is what
 * makes installing a third-party game a smaller act of trust than installing
 * an arbitrary plugin: it returns a payout figure and the hub decides whether
 * the house can pay it and writes every ledger row.
 */
export interface GameDef<S = unknown> {
  /** Must equal the declaring plugin's id — checked in `buildRegistry`. */
  id: string;
  name: string;
  /**
   * The most a player can be returned per unit of the CURRENT wager. Blackjack
   * is 2.5 (a natural pays 3:2). A doubled hand has twice the wager and is
   * still 2.5 of it, which is why the exposure check re-runs on `wagerDelta`
   * rather than predicting a maximum up front.
   */
  maxPayoutMultiplier: number;
  /** Validates the act body's `action`. Rule: zod every external boundary. */
  action: z.ZodTypeAny;
  start(input: { wager: bigint; seed: string }): GameStep<S>;
  act(state: S, action: unknown): GameStep<S>;
  /** Total returned to the player. 0 = loss, wager = push, 2×wager = win. */
  settle(state: S, wager: bigint): bigint;
}

export const games = filterPoint<GameDef[]>("casino.games");

/**
 * Built on first use and memoised by the caller. Request-time rather than
 * boot-time, because a GameDef arrives inside a filter subscription and
 * `definePlugin` cannot see it — the tradeoff spec §3 records.
 */
export async function buildRegistry(
  ctx: Pick<PluginCtx, "filters">,
  installedPluginIds: ReadonlySet<string>,
): Promise<Map<string, GameDef>> {
  const declared = await ctx.filters.apply(games, []);
  const registry = new Map<string, GameDef>();
  for (const game of declared) {
    if (!installedPluginIds.has(game.id)) {
      throw new Error(`casino game "${game.id}" is not an installed plugin id`);
    }
    if (registry.has(game.id)) throw new Error(`duplicate casino game id "${game.id}"`);
    registry.set(game.id, game);
  }
  return registry;
}
```

- [ ] **Step 5: Re-export from the manifest module**

In `packages/plugins/casino/src/index.ts`:

```ts
export { games, buildRegistry, type GameDef, type GameStep } from "./games.js";
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
npx vitest run apps/server/test/casino-registry.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 7: Commit**

```bash
git add packages/plugins/casino/src/games.ts packages/plugins/casino/src/index.ts \
        apps/server/test/casino-registry.test.ts vitest.workspace.ts
git commit -m "feat(casino): games filter point and registry"
```

---

### Task 5: Blackjack rules, as pure functions

**Files:**
- Create: `packages/plugins/blackjack/package.json`, `tsconfig.json`, `src/rules.ts`, `src/view.ts`, `src/index.ts`
- Modify: the eight registration sites, again
- Test: `apps/server/test/blackjack-rules.test.ts` (create)

**Interfaces:**
- Consumes: `GameDef`, `GameStep`, `games` from `@gl3/plugin-casino` (Task 4).
- Produces: the default-exported manifest with `providesProperties` for `blackjack`, and `BLACKJACK: GameDef<BlackjackState>`.

- [ ] **Step 1: Create the package**

`packages/plugins/blackjack/package.json`, mirroring Task 3 Step 1 but depending on `@gl3/plugin-casino` instead of `@gl3/plugin-properties`:

```json
{
  "name": "@gl3/plugin-blackjack",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": { "build": "tsc --build" },
  "dependencies": { "@gl3/plugin-casino": "*", "@gl3/plugin-sdk": "*", "zod": "^3.23.8" }
}
```

No `drizzle-orm`: this plugin owns no tables and touches no database, which is the design's central claim about what a game plugin is.

- [ ] **Step 2: Write the failing test**

Create `apps/server/test/blackjack-rules.test.ts`. These are pure functions, so the whole file needs neither Postgres nor Redis:

```ts
import { describe, expect, it } from "vitest";
import { BLACKJACK, handValue, shuffle, type BlackjackState } from "@gl3/plugin-blackjack";

const WAGER = 100_000n;

describe("hand value", () => {
  it("counts an ace as 11 when it fits and 1 when it does not", () => {
    expect(handValue(["Sa", "Sk"])).toBe(21);
    expect(handValue(["Sa", "Sk", "H5"])).toBe(16);
    expect(handValue(["Sa", "Sa"])).toBe(12);
  });

  it("counts faces as ten", () => {
    expect(handValue(["Sj", "Hq", "Dk"])).toBe(30);
  });
});

describe("shoe", () => {
  it("is deterministic in the seed", () => {
    expect(shuffle("seed-a")).toEqual(shuffle("seed-a"));
    expect(shuffle("seed-a")).not.toEqual(shuffle("seed-b"));
  });

  it("is six full decks", () => {
    const shoe = shuffle("seed-a");
    expect(shoe).toHaveLength(312);
    expect(shoe.filter((c) => c === "Sa")).toHaveLength(6);
  });
});

describe("blackjack game", () => {
  it("deals two cards to each side and does not finish on a normal deal", () => {
    // A seed whose first four cards make no natural. Pick one by running
    // shuffle() and reading the head; hardcode it here once known.
    const step = BLACKJACK.start({ wager: WAGER, seed: "no-natural" });
    expect(step.state.player).toHaveLength(2);
    expect(step.state.dealer).toHaveLength(2);
    expect(step.done).toBe(false);
  });

  it("pays a natural 3:2 and ends the hand immediately", () => {
    const step = BLACKJACK.start({ wager: WAGER, seed: "natural" });
    expect(step.done).toBe(true);
    expect(BLACKJACK.settle(step.state, WAGER)).toBe(250_000n);
  });

  it("returns 0 when the player busts", () => {
    const state = { ...baseState(), player: ["Sk", "Hq", "D5"], phase: "player" } as BlackjackState;
    const step = BLACKJACK.act(state, "stand");
    expect(BLACKJACK.settle(step.state, WAGER)).toBe(0n);
  });

  it("returns the wager on a push", () => {
    const state = { ...baseState(), player: ["Sk", "H9"], dealer: ["Dk", "C9"], phase: "player" } as BlackjackState;
    const step = BLACKJACK.act(state, "stand");
    expect(step.done).toBe(true);
    expect(BLACKJACK.settle(step.state, WAGER)).toBe(WAGER);
  });

  it("stands the dealer on 17", () => {
    const state = { ...baseState(), player: ["Sk", "H9"], dealer: ["Dk", "C7"], phase: "player" } as BlackjackState;
    const step = BLACKJACK.act(state, "stand");
    expect(step.state.dealer).toHaveLength(2);   // no third card drawn on 17
  });

  it("doubling asks the hub for exactly one more wager and ends the hand", () => {
    const step = BLACKJACK.act({ ...baseState(), player: ["S5", "H6"], phase: "player" } as BlackjackState, "double");
    expect(step.wagerDelta).toBe(WAGER);
    expect(step.done).toBe(true);
  });

  it("refuses to double after the first two cards", () => {
    const state = { ...baseState(), player: ["S5", "H6", "D2"], phase: "player" } as BlackjackState;
    expect(() => BLACKJACK.act(state, "double")).toThrow(/double/i);
  });

  it("rejects an action its schema does not allow", () => {
    expect(BLACKJACK.action.safeParse("split").success).toBe(false);
    expect(BLACKJACK.action.safeParse("hit").success).toBe(true);
  });
});

/** A state whose shoe has plenty left, for the hand-constructed cases above. */
function baseState(): BlackjackState {
  return { shoe: shuffle("fixture"), cursor: 4, player: [], dealer: [], wager: WAGER, phase: "player" };
}
```

Two of these tests name seeds (`"no-natural"`, `"natural"`) chosen for their outcome. **Find them empirically in Step 4** by running `shuffle()` over candidate strings and reading the first four cards, then hardcode the winners. Do not weaken the assertions to fit whatever the first seed gives.

- [ ] **Step 3: Register the test file and run it to verify it fails**

Add `apps/server/test/blackjack-rules.test.ts` to the **`@gl3/server:unit`** project's `include`.

```bash
npx vitest run apps/server/test/blackjack-rules.test.ts
```

Expected: FAIL — cannot resolve `@gl3/plugin-blackjack`.

- [ ] **Step 4: Write `rules.ts`**

```ts
import { createHash } from "node:crypto";

export type Card = string;                      // a @letele/playing-cards code
export type Phase = "player" | "done";

export interface BlackjackState {
  shoe: Card[];
  cursor: number;
  player: Card[];
  dealer: Card[];
  wager: bigint;
  phase: Phase;
}

const SUITS = ["H", "D", "C", "S"] as const;
const RANKS = ["a", "2", "3", "4", "5", "6", "7", "8", "9", "10", "j", "q", "k"] as const;
const DECKS = 6;

/**
 * A six-deck shoe, shuffled ONCE and stored, which is how this satisfies
 * SPEC §7. The rule's intent is that a retry cannot re-roll a favourable
 * outcome; here no later roll exists to re-roll, because every `act` is a
 * deterministic read of a committed shoe.
 *
 * Deterministic in the seed so a disputed hand can be replayed from the
 * session's `seed` column. The seed itself comes from `node:crypto` at the
 * hub (never `Math.random`, SPEC §7); this function only expands it.
 */
export function shuffle(seed: string): Card[] {
  const shoe: Card[] = [];
  for (let d = 0; d < DECKS; d++) {
    for (const s of SUITS) for (const r of RANKS) shoe.push(`${s}${r}`);
  }
  // Fisher-Yates driven by a SHA-256 counter stream — no floating point, and
  // reproducible across Node versions, which `Math.random` would not be.
  let counter = 0;
  const next = (): number => {
    const digest = createHash("sha256").update(`${seed}:${counter++}`).digest();
    return digest.readUInt32BE(0);
  };
  for (let i = shoe.length - 1; i > 0; i--) {
    const j = next() % (i + 1);
    const a = shoe[i]!, b = shoe[j]!;
    shoe[i] = b; shoe[j] = a;
  }
  return shoe;
}

export function handValue(hand: readonly Card[]): number {
  let total = 0, aces = 0;
  for (const card of hand) {
    const rank = card.slice(1);
    if (rank === "a") { aces++; total += 11; }
    else if (rank === "j" || rank === "q" || rank === "k" || rank === "10") total += 10;
    else total += Number(rank);
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}

export function isNatural(hand: readonly Card[]): boolean {
  return hand.length === 2 && handValue(hand) === 21;
}

/** Dealer stands on all 17. Mutates a copy, never its argument. */
export function playDealer(state: BlackjackState): BlackjackState {
  const dealer = [...state.dealer];
  let cursor = state.cursor;
  while (handValue(dealer) < 17) dealer.push(state.shoe[cursor++]!);
  return { ...state, dealer, cursor, phase: "done" };
}
```

- [ ] **Step 5: Write the `GameDef` and the view**

`packages/plugins/blackjack/src/view.ts` renders the state; keep it pure and return a `panel` containing two `cards` nodes and the totals. `packages/plugins/blackjack/src/index.ts`:

```ts
import { z } from "zod";
import { definePlugin, on } from "@gl3/plugin-sdk";
import { games, type GameDef, type GameStep } from "@gl3/plugin-casino";
import { handValue, isNatural, playDealer, shuffle, type BlackjackState } from "./rules.js";
import { renderState } from "./view.js";

export { handValue, shuffle, type BlackjackState } from "./rules.js";

const ActionSchema = z.enum(["hit", "stand", "double"]);

export const BLACKJACK: GameDef<BlackjackState> = {
  id: "blackjack",
  name: "Blackjack",
  /** A natural pays 3:2. A doubled hand has twice the wager and is still 2.5
   *  of it — which is why the hub re-checks exposure on `wagerDelta`. */
  maxPayoutMultiplier: 2.5,
  action: ActionSchema,

  start({ wager, seed }): GameStep<BlackjackState> {
    const shoe = shuffle(seed);
    const state: BlackjackState = {
      shoe, cursor: 4,
      player: [shoe[0]!, shoe[2]!],
      dealer: [shoe[1]!, shoe[3]!],
      wager, phase: "player",
    };
    if (isNatural(state.player) || isNatural(state.dealer)) {
      const done = { ...state, phase: "done" as const };
      return { state: done, view: renderState(done), done: true };
    }
    return { state, view: renderState(state), done: false };
  },

  act(state, action): GameStep<BlackjackState> {
    const parsed = ActionSchema.parse(action);
    if (state.phase === "done") throw new Error("hand is already finished");

    if (parsed === "hit") {
      const player = [...state.player, state.shoe[state.cursor]!];
      const next: BlackjackState = { ...state, player, cursor: state.cursor + 1 };
      if (handValue(player) > 21) {
        const done = { ...next, phase: "done" as const };
        return { state: done, view: renderState(done), done: true };
      }
      return { state: next, view: renderState(next), done: false };
    }

    if (parsed === "double") {
      if (state.player.length !== 2) throw new Error("can only double on the first two cards");
      const player = [...state.player, state.shoe[state.cursor]!];
      const drawn: BlackjackState = { ...state, player, cursor: state.cursor + 1, wager: state.wager * 2n };
      const done = handValue(player) > 21 ? { ...drawn, phase: "done" as const } : playDealer(drawn);
      // The hub debits the player, credits the house and re-runs the exposure
      // check. This function moves no money and knows nothing about balances.
      return { state: done, view: renderState(done), done: true, wagerDelta: state.wager };
    }

    const done = playDealer(state);
    return { state: done, view: renderState(done), done: true };
  },

  settle(state, wager): bigint {
    const player = handValue(state.player);
    const dealer = handValue(state.dealer);
    if (player > 21) return 0n;
    if (isNatural(state.player) && !isNatural(state.dealer)) return (wager * 5n) / 2n;  // 3:2
    if (dealer > 21) return wager * 2n;
    if (player > dealer) return wager * 2n;
    if (player === dealer) return wager;                                                // push
    return 0n;
  },
};

export default definePlugin({
  id: "blackjack",
  version: "1.0.0",
  basePaths: ["/api/blackjack"],
  providesProperties: [{
    id: "blackjack",
    name: "Blackjack Table",
    price: 100_000_000n,     // $1,000,000 in cents — V2's hardcoded figure
    leverLabel: "Maximum bet",
  }],
  filters: [on(games, (_ctx, list) => [...list, BLACKJACK as GameDef])],
});
```

`basePaths` is required and must be unique, but this plugin serves no routes — all play goes through `/api/casino`. Declaring `/api/blackjack` reserves the namespace without using it.

- [ ] **Step 6: Find the two fixture seeds**

```bash
node --input-type=module -e "
import { shuffle } from './packages/plugins/blackjack/dist/rules.js';
for (const s of ['natural','no-natural','a','b','c','d','e']) {
  const k = shuffle(s); console.log(s, k[0], k[1], k[2], k[3]);
}"
```

Pick a seed whose cards 0 and 2 make 21 for the `natural` case, and one where neither side has 21 for `no-natural`. Substitute the real strings into the Task 5 Step 2 test.

- [ ] **Step 7: Complete the eight registration sites for `blackjack`**

Exactly as Task 3 Step 6, with `blackjack` in place of `casino`. Note `blackjack` must be listed **after** `casino` in `CORE_PLUGINS` — the filter point must exist before a subscriber references it.

- [ ] **Step 8: Run the tests**

```bash
npx vitest run apps/server/test/blackjack-rules.test.ts
npx tsc --build --force apps/server/tsconfig.json
grep -c "packages/plugins/blackjack" Dockerfile.server   # must print 5
```

Expected: PASS on all rules tests, exit 0, `5`.

- [ ] **Step 9: Commit**

```bash
git add packages/plugins/blackjack apps/server/package.json apps/server/tsconfig.json tsconfig.json \
        vitest.workspace.ts apps/server/src/plugins/core-plugins.ts Dockerfile.server \
        apps/server/test/blackjack-rules.test.ts package-lock.json
git commit -m "feat(blackjack): pure rules and the game definition"
```

---

### Task 6: `POST /api/casino/play` — escrow, house, exposure

**Files:**
- Create: `packages/plugins/casino/src/engine.ts`
- Modify: `packages/plugins/casino/src/index.ts`
- Test: `apps/server/test/casino-play.test.ts` (create)

**Interfaces:**
- Consumes: `buildRegistry` (Task 4), `ownerAt`/`payOwner` from `@gl3/plugin-properties`, the settings readers (Task 3).
- Produces: `resolveHouse(tx, gameId, locationId, settings)` and `assertHouseCanCover(...)` in `engine.ts`, used again by Task 7.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/casino-play.test.ts` covering, each as its own `it`:

```
1. a wager below `min_bet` → 400 wager_below_min
2. a wager above the house lever → 400 wager_above_max
3. an unknown gameId → 404 no_such_game
4. insufficient cash → 409 insufficient_funds
5. wager × 2.5 > owner cash → 409 house_cannot_cover
6. a successful play debits the player and credits the house by exactly the wager
7. a second play while one is open → 409 session_open
8. an unowned town plays fine, capped by the `max_bet` setting
```

Test 6 is the one that must be precise — assert on both the ledger and the property row:

```ts
it("escrows the wager to the house", async () => {
  const { cashBefore, ownerCashBefore } = await snapshot(db, player.id, owner.id);
  const res = await callPluginRoute(app, "POST", "/api/casino/play", {
    gameId: "blackjack", wager: "100000",
  }, player);
  expect(res.statusCode).toBe(200);

  const { cash, ownerCash } = await snapshot(db, player.id, owner.id);
  expect(cash).toBe(cashBefore - 100_000n);
  expect(ownerCash).toBe(ownerCashBefore + 100_000n);

  // profit moves with the money — payOwner does both or neither
  const [prop] = await db.select().from(propertiesTable).where(eq(propertiesTable.id, propertyId));
  expect(prop?.profit).toBe(100_000n);
});
```

Copy the `bootTestServer` / `callPluginRoute` / seeding idiom from an existing route test such as `apps/server/test/properties-routes.test.ts` rather than inventing helper signatures.

- [ ] **Step 2: Register the test file and run it to verify it fails**

Add to the default `@gl3/server` project. Expected: FAIL — 404, no such route.

- [ ] **Step 3: Write `engine.ts`**

```ts
import { PluginError, type PluginTx } from "@gl3/plugin-sdk";
import { ownerAt, payOwner } from "@gl3/plugin-properties";

export interface House {
  /** Null in a town nobody owns: escrow is a sink and payout a faucet. */
  propertyId: string | null;
  ownerId: string | null;
  /** The owner's lever read as the maximum bet — V2 blackjack.inc.php:276. */
  maxBet: bigint;
}

export async function resolveHouse(
  tx: PluginTx, gameId: string, locationId: string, fallbackMaxBet: bigint,
): Promise<House> {
  const owner = await ownerAt(tx, gameId, locationId);
  if (owner === null) return { propertyId: null, ownerId: null, maxBet: fallbackMaxBet };
  return {
    propertyId: owner.propertyId,
    ownerId: owner.ownerId,
    // `null` lever means the owner has set none — use our own default, which
    // is bullets' fallback shape.
    maxBet: owner.lever ?? fallbackMaxBet,
  };
}

/**
 * `payOwner` CLAMPS a debit to the owner's cash. Without this check a player
 * who wins more than the house holds is silently short-paid, with no error
 * anywhere and a ledger that still balances. Re-run whenever the wager grows.
 */
export function assertHouseCanCover(wager: bigint, multiplier: number, ownerCash: bigint | null): void {
  if (ownerCash === null) return;                       // unowned house is a faucet
  // multiplier is a float (2.5); scale by 10 and divide to stay in bigint.
  const exposure = (wager * BigInt(Math.round(multiplier * 10))) / 10n;
  if (exposure > ownerCash) throw new PluginError("house_cannot_cover", 409);
}

/** Credit the house and debit the player, or sink the wager in an unowned town. */
export async function escrow(
  tx: PluginTx, house: House, playerId: string, amount: bigint, gameId: string,
): Promise<void> {
  await tx.economy.applyBalanceChange({
    playerId, amount: -amount, kind: "cash", reason: `casino.${gameId}.wager`,
  });
  if (house.propertyId !== null) {
    await payOwner(tx, house.propertyId, amount, `casino.${gameId}.wager`);
  }
}
```

- [ ] **Step 4: Write the `play` route**

In `index.ts`, with this lock order and no other (spec §5):

```ts
    return ctx.transaction(async (tx) => {
      // RULE 6: location first, then BOTH players in ONE call. Locking the
      // player first and letting payOwner take the owner second is an ABBA
      // cycle — the hazard properties/src/api.ts:51-58 documents.
      await tx.locks.location(locationId);
      const house = await resolveHouse(tx, body.gameId, locationId, readMaxBet(ctx.settings));
      await tx.locks.player(house.ownerId === null ? [player.id] : [player.id, house.ownerId]);
      // ... re-read cash under the lock, then check, then escrow
    });
```

`resolveHouse` runs after the location lock and before the player lock because it needs the owner's id to build the one `locks.player` call. It reads without `FOR UPDATE`; `payOwner` re-reads the row `FOR UPDATE` itself, so a transfer between the two cannot pay the wrong player.

Order inside the lock: read cash → `min_bet`/`max_bet` checks → `insufficient_funds` → `assertHouseCanCover` → `escrow` → `game.start` → settle-now if `done`, else insert the session row.

The seed is `randomBytes(16).toString("hex")` from `node:crypto` — never `Math.random` (SPEC §7).

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx vitest run apps/server/test/casino-play.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/plugins/casino/src apps/server/test/casino-play.test.ts vitest.workspace.ts
git commit -m "feat(casino): play route with escrow and house exposure check"
```

---

### Task 7: `POST /api/casino/act` — wagerDelta, settle, payout

**Files:**
- Modify: `packages/plugins/casino/src/index.ts`, `src/engine.ts`
- Test: `apps/server/test/casino-act.test.ts` (create)

**Interfaces:**
- Consumes: `assertHouseCanCover`, `escrow` (Task 6); `GameDef.act`/`settle` (Task 4).
- Produces: `settleSession(tx, session, game, house)` in `engine.ts`, reused by Task 8's lazy forfeit.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/casino-act.test.ts`:

```
1. hit then stand settles, and the player's net across the hand equals payout − wager
2. a push returns exactly the wager (net zero for both sides)
3. a natural pays 2.5× and the house is debited 2.5×
4. double debits a second wager AND credits the house before the hand resolves
5. double when the house can no longer cover → 409 house_cannot_cover, and the
   session stays open and unchanged
6. acting on a settled session → 409 session_closed
7. acting on another player's session → 404
8. sum(ledger) == balance still holds for both players afterwards
```

Test 5 is the reason the exposure check is a function rather than an inline
check in `play` — it must run again here.

Test 8 is not optional decoration: `test/economy-invariant.test.ts` enforces
`sum(ledger) == balance` globally, and a casino that mints or destroys money
outside `applyBalanceChange` breaks it.

- [ ] **Step 2: Register the file and run it to verify it fails**

Add to the default `@gl3/server` project. Expected: FAIL — no such route.

- [ ] **Step 3: Write `settleSession` in `engine.ts`**

```ts
/**
 * Pays the player and debits the house, then closes the session. The wager was
 * escrowed at `play` (V2 blackjack.inc.php:297) so the net across a hand is
 * correct without a second bookkeeping concept: a push returns the wager, a
 * loss returns nothing and the house keeps it. V2 :406 is the debit.
 */
export async function settleSession(
  tx: PluginTx, sessionId: string, playerId: string, gameId: string,
  house: House, payout: bigint,
): Promise<void> {
  if (payout > 0n) {
    if (house.propertyId !== null) {
      await payOwner(tx, house.propertyId, -payout, `casino.${gameId}.payout`);
    }
    await tx.economy.applyBalanceChange({
      playerId, amount: payout, kind: "cash", reason: `casino.${gameId}.payout`,
    });
  }
  await tx.db.update(casinoSessions)
    .set({ status: "settled", settledAt: new Date() })
    .where(eq(casinoSessions.id, sessionId));
}
```

- [ ] **Step 4: Write the `act` route**

Same lock order as Task 6, plus the session row `FOR UPDATE` after both players. Then: parse `action` with `game.action`, call `game.act`, and if `step.wagerDelta` is set — `assertHouseCanCover(newWager, game.maxPayoutMultiplier, ownerCash)` **before** `escrow`, then update `session.wager`. Persist `step.state`. If `step.done`, `settleSession`.

A `PluginError` thrown by the exposure check rolls the whole transaction back, which is what leaves the session open and unchanged for test 5.

- [ ] **Step 5: Run the tests**

```bash
npx vitest run apps/server/test/casino-act.test.ts
npx vitest run apps/server/test/economy-invariant.test.ts
```

Expected: PASS on both.

- [ ] **Step 6: Commit**

```bash
git add packages/plugins/casino/src apps/server/test/casino-act.test.ts vitest.workspace.ts
git commit -m "feat(casino): act route, wager raises and settlement"
```

---

### Task 8: Lock order under concurrency

**Files:**
- Test: `apps/server/test/casino-lock-order.test.ts` (create)

This is its own task because it is its own reviewer gate: it is the test that would have caught the two deadlocks already shipped in this codebase.

- [ ] **Step 1: Write the test**

```ts
it("does not deadlock when the house owner plays at their own table", async () => {
  // The owner playing their own table means one transaction touches ONE player
  // row twice (as buyer and as house). tx.locks.player dedupes, which is what
  // makes it safe — but only if both ids go through ONE call.
  const results = await Promise.all([
    play(owner, "100000"),
    play(stranger, "100000"),
  ]);
  expect(results.every((r) => r.statusCode === 200)).toBe(true);
});

it("deadlocks when a caller takes the player lock before the location lock", async () => {
  // CLAUDE.md's corollary: a concurrency test whose participants all acquire
  // locks via the same helper proves only the case that was already safe. This
  // one deliberately inverts the order in a second connection and asserts the
  // failure, so the passing test above is known to be load-bearing.
  await expect(raceAgainstInvertedOrder()).rejects.toThrow(/40P01|deadlock/);
});
```

The second test must be **shown failing** if the inverted helper is corrected — demand that proof before accepting this task (CLAUDE.md: "a green acceptance test that was never shown turning red proves nothing").

- [ ] **Step 2: Register the file, run it, commit**

```bash
npx vitest run apps/server/test/casino-lock-order.test.ts
git add apps/server/test/casino-lock-order.test.ts vitest.workspace.ts
git commit -m "test(casino): lock order under concurrency"
```

---

### Task 9: Lobby, lazy forfeit and the admin page

**Files:**
- Modify: `packages/plugins/casino/src/index.ts`, `src/engine.ts`
- Create: `packages/plugins/casino/src/pages.ts`
- Test: `apps/server/test/casino-lobby.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```
1. the lobby lists every installed game with its house owner and max bet for
   the player's current town
2. a town with no owner shows the `max_bet` setting as the limit
3. an open session is returned with its current view
4. a session older than `session_expiry_minutes` is forfeited on the next
   `play` — the house keeps the wager, the new hand opens, and only ONE
   session ends up open
5. the admin page renders no UUID
```

Test 4 is the lazy-settle path: assert both that the stale session's `status`
is `settled` and that the player's cash did not move at forfeit time (it moved
at `play`, when it was escrowed).

- [ ] **Step 2: Implement**

`GET /api/casino` builds the registry (memoised), reads the player's town, and
for each game calls `resolveHouse`. The lazy forfeit belongs in `play`, before
the `session_open` check: if the open session's `created_at` is older than
`readExpiryMinutes(ctx.settings)`, call `settleSession(..., payout: 0n)` and
continue. `ensureCurrentRound`'s pattern — lazy at read, no cron.

`src/pages.ts` declares the `adminPages` table over settings plus a read-only
open-sessions list. Ids travel as `valueKey` only — `admin-ids-hidden.test.ts`
enforces this repo-wide and will fail the build if a UUID is rendered.

- [ ] **Step 3: Run, commit**

```bash
npx vitest run apps/server/test/casino-lobby.test.ts apps/server/test/admin-ids-hidden.test.ts
git add packages/plugins/casino/src apps/server/test/casino-lobby.test.ts vitest.workspace.ts
git commit -m "feat(casino): lobby, lazy forfeit and admin section"
```

---

# PHASE 3 — surface and release

### Task 10: The `/casino` page

**Files:**
- Create: `packages/shared/src/dto/casino.ts`, `apps/web/src/pages/Casino.tsx`
- Modify: `packages/shared/src/index.ts`, `apps/web/src/App.tsx`

- [ ] **Step 1: Add the DTOs to `@gl3/shared`**

`CasinoLobbyResponseSchema` and `CasinoSessionViewSchema`. Money fields are
`MoneySchema` decimal strings, never JSON numbers.

- [ ] **Step 2: Write the page**

Hand-written, like every other gameplay page. Lobby (game, town, owner, max
bet, wager input) and table (both hands via `<Hand>`, totals, Hit/Stand/Double).
Use the shared `Hand` from Task 2 so the hand-written page and a declared page
render cards identically.

- [ ] **Step 3: Route it, typecheck, commit**

```bash
npx tsc --build --force apps/web/tsconfig.json
npx vitest run --project @gl3/web
git add packages/shared apps/web && git commit -m "feat(web): casino page"
```

---

### Task 11: Version bumps, publish, and the merge gate

- [ ] **Step 1: Confirm the current published versions**

```bash
npm view @gl3/shared versions --registry https://npm.gl3.dev
npm view @gl3/plugin-sdk versions --registry https://npm.gl3.dev
```

The spec predicts `@gl3/shared@0.1.6` and `@gl3/plugin-sdk@0.1.2`, but the
franchise cluster may have landed more than one bump. **Read the registry; do
not assume.** Additive changes ship as a patch under `0.x` — a minor bump
breaks every `^0.1.0` peer range in the wild and is a deliberate act.

- [ ] **Step 2: Bump and publish `@gl3/shared` FIRST**

`pages.ts` imports *values* from it, not only types, so the SDK cannot be
published against an unpublished shared. Check `files` is present in both
manifests — `dist/` is gitignored, and without it npm publishes a package with
no build output.

- [ ] **Step 3: Bump and publish `@gl3/plugin-sdk`**

- [ ] **Step 4: Run the full suite, bare**

```bash
npm run verify
```

Not piped through `grep` or `tail` — that discards npm's exit status, and an
unhandled rejection makes vitest exit non-zero while still printing
`Tests N passed`. **Judge by the exit code.** Do not start this while another
agent is running a suite.

- [ ] **Step 5: Confirm the two guards this cluster could have moved**

`apps/server/test/schema.test.ts` counts FKs and indexes created by **core**
migrations. Every migration here is a plugin migration, so its counts must be
**unchanged**. If that test fails, something was added to core by mistake —
fix the migration, do not restate the count.

`apps/server/test/plugin-ctx-core-events.test.ts`'s `CORPUS` and
`packages/shared/test/events.test.ts`'s census both guard the `GameEvent`
union. This cluster adds no core event variant (spec §8), so both must be
untouched.

- [ ] **Step 6: Commit and open the PR**

```bash
git add -A && git commit -m "chore: publish @gl3/shared and @gl3/plugin-sdk for the casino cluster"
```

---

## Self-Review

**Spec coverage.** §2 packages → Tasks 3, 5. §3 extension point → Task 4. §4.1
table → Task 3. §4.2 routes → Tasks 6, 7, 9. §4.3 money → Tasks 6, 7. §4.4
abandoned hands → Task 9. §4.5 settings → Task 3. §5 lock order → Tasks 6, 8.
§6 blackjack → Task 5. §7 UI → Tasks 1, 2, 10. §8 events (none) → Task 11
Step 5 asserts the guards stay untouched. §9 versions → Task 11. §10 testing →
every task. §11 risk 3 (the library) → Task 2 Step 1, which is a stop-and-report
gate rather than a note.

**Known gap, stated rather than hidden.** The spec's §11 risk 1 — that a game
is trusted with the player's screen but not their wallet — has no task, because
there is nothing to build for it. It is a property of the design, recorded in
the spec and not mitigated here.

**Type consistency.** `GameDef`/`GameStep` (Task 4) are used unchanged in Tasks
5, 6, 7. `House` (Task 6) is consumed by `settleSession` (Task 7) and the lobby
(Task 9). `BlackjackState` (Task 5) is opaque to the hub throughout — it crosses
only as `jsonb`. `resolveHouse` / `assertHouseCanCover` / `escrow` /
`settleSession` keep one signature each across every task that calls them.
