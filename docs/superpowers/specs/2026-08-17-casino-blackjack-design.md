# Casino engine and blackjack — design

**Date:** 2026-08-17
**Status:** draft, awaiting review
**Depends on:** `2026-08-16-properties-franchise-design.md` Phase 2 (`ownerAt` /
`payOwner`, `cost` as the owner's lever). That work is in flight on
`feat/properties-franchise`; this cluster starts after it merges.

---

## 0. Why this exists

SPEC §6 lists the casino as v1.1 — "ship the schema, stub the gameplay". The
schema shipped and the stub was never filled. Two things have since made the
real thing buildable:

1. **The properties franchise cluster.** `payOwner` accepts a negative amount,
   which is precisely the house model: the owner is credited the wager and
   debited the payout, and can lose. The franchise design named a casino as the
   motivating case it deliberately did not build
   (`2026-08-16-properties-franchise-design.md` §1, "Out of scope").
2. **The re-key to `(location_id, plugin_id)`.** A town can now carry one
   property per plugin, so a Blackjack house and a Roulette house coexist with
   the Bullet Factory.

The goal is not one game. It is an **engine** that makes a casino game a
small, safe thing for a third party to write and install — the marketplace
case M5 exists for — with blackjack as the first game and the proof the
interface is usable.

### What V2 shows

The V2 source (`github.com/ChristopherDay/Gangster-Legends-V2`, `master`) was
read for the properties cluster and four facts about `blackjack.inc.php` were
recorded there:

- `:124` — its own copy of `method_own()`, hardcoded $1,000,000, identical to
  bullets'. Blackjack is one of only two modules in V2 that sell a property.
- `:276` — reads `PR_cost` as the **maximum bet**. This is the lever.
- `:297` — credits the bet to the owner.
- `:406` — debits the payout from the owner. The owner is the house and can
  lose.

**V2's blackjack rules themselves were not read.** The rules in §6 below are
GL3's choice, stated outright rather than inherited. Everything about *money*
follows V2; everything about *cards* is ours.

### The migration fact that fixes the plugin id

`apps/migrate/src/migrators/properties.ts:38` writes `pluginId: row.PR_module`
verbatim. V2's module directory is `blackjack`, so a migrated V2 database
already holds `plugin_id = 'blackjack'` rows carrying real owners and real
`PR_cost` levers, sitting inert as "unregistered" under the franchise design's
§2.3 rule.

Naming the game plugin `blackjack` makes every one of those rows light up on
install, owner and max-bet intact. Naming it `casino` would strand them
permanently. This is why the engine and the game are two packages and not one.

---

## 1. Scope

**In:**

- `@gl3/plugin-casino` — the engine: session table, wager escrow, payout,
  house resolution, lobby, and the `casino.games` extension point.
- `@gl3/plugin-blackjack` — the first game: rules as pure functions, and a
  `providesProperties` declaration for the house.
- A `cards` view node in the plugin SDK plus its `PageRenderer` case, so an
  installed third-party card game renders real cards without shipping React.
- A hand-written `/casino` page in `apps/web`.

**Out, deliberately:**

- **Any second game.** Roulette, slots and poker are what the interface is
  *for*; building one here would prove the interface against a game written by
  the same author on the same day, which proves little. The engine ships with
  one game and the interface is judged on review.
- **Splitting a blackjack hand.** It needs N hands per session and N wagers,
  which the session model in §4 does not carry. Double down does raise the
  wager and is in (§4.4) — split is the same idea one step further and is the
  natural first follow-up.
- **Insurance, surrender, side bets.**
- **Gang-owned houses.** `owner_player_id` stays a player, per the franchise
  design.
- **A progressive jackpot.** It is a second pot with its own accounting; not
  now.
- **Chips as a distinct balance.** Wagers are cash, through
  `applyBalanceChange` like every other movement (rule 3).

---

## 2. Architecture

Two packages, both in-repo, both installed by default. "Built-in" means ships
with GL3 — it does not mean privileged. Blackjack registers through the same
filter point a third-party game would, and the only thing it gets that an
installed game does not is a hand-written page (§7).

| package | plugin id | owns | declares a property type |
|---|---|---|---|
| `@gl3/plugin-casino` | `casino` | `p_casino_sessions`, escrow, payout, lobby, filter point | **no** |
| `@gl3/plugin-blackjack` | `blackjack` | nothing — rules only | **yes** |

The hub declaring no property type is the decision that keeps "who is the
house" unambiguous: for a hand of game `G` in town `T`, the house is the owner
of `(T, G)` and nobody else. A town-level casino licence taking a rake on top
was considered and rejected as a second economic layer with a second
`payOwner` call in the same transaction, for no gameplay nobody has asked for.

**Dependency edges.** `casino → properties` (for `ownerAt`/`payOwner`) and
`blackjack → casino` (for the filter point and the `GameDef` type). Blackjack
needs **no** dependency on `properties`: it declares its property type through
the SDK manifest field, not through an import.

That takes the repo's plugin→plugin edge count from two (`bounties → combat`,
`bullets → properties`) to four. The franchise design's §7 risk 4 asked for a
look at registry mediation at the third edge. The look, recorded here: both new
edges are type-and-token imports of the kind `bounties → combat` already
established, the graph stays acyclic, and mediating them through the loader
would mean putting casino-shaped fields in the generic SDK — which §3 rejects
for the same reason. No change; re-examine at edge six.

**Table ownership.** The hub owns its one table (`p_casino_sessions`). The
repo has sixteen plugins, seven of which declare migrations; this cluster adds
two plugins and one migrator, so it becomes **eight of eighteen**. A game plugin owns no
tables *by design* — its state lives in the session row as opaque JSON, which
is what lets a third-party game ship without a migration runner touching the
database.

---

## 3. The extension point

The hub declares a filter point and exports it; a game subscribes.

```ts
// @gl3/plugin-casino
export const games = filterPoint<GameDef[]>("casino.games");

// @gl3/plugin-blackjack
filters: [on(games, (_ctx, list) => [...list, BLACKJACK])]
```

This is `bounties → combat`'s `killResolved` shape exactly
(`packages/plugins/bounties/src/index.ts:2`), and it is chosen over a new
`providesCasinoGames` manifest field for one reason: **filters already carry
functions and are already collected by the loader**, so the whole extension
point costs no SDK surface and no republish. A manifest field would also put a
casino-specific concept into a generic SDK that no other domain has needed.

```ts
export interface GameStep<S> {
  state: S;
  /** What the player sees now. Rendered by PageRenderer; may contain `cards`. */
  view: ViewNode;
  done: boolean;
  /**
   * Raise the wager mid-hand (blackjack's double down; a poker raise). The hub
   * debits the player, credits the house, updates the session and RE-RUNS the
   * exposure check (§4.3). A game never moves money itself.
   */
  wagerDelta?: bigint;
}

export interface GameDef<S = unknown> {
  /** Must equal the declaring plugin's id — see the validation note below. */
  id: string;
  name: string;
  /**
   * The most a player can be returned per unit of the CURRENT wager. Bounds
   * the house exposure check. Blackjack is 2.5 (a natural pays 3:2); a doubled
   * hand has twice the wager and so is still 2.5 of it, which is exactly why
   * the check re-runs on `wagerDelta` rather than trying to predict the
   * maximum up front.
   */
  maxPayoutMultiplier: number;
  /** Validates the act body's `action`. Rule: zod every external boundary. */
  action: z.ZodType<unknown>;

  start(input: { wager: bigint; seed: string }): GameStep<S>;
  act(state: S, action: unknown): GameStep<S>;
  /** Total returned to the player. 0 = loss, wager = push, 2×wager = win. */
  settle(state: S, wager: bigint): bigint;
  /**
   * Re-render an in-progress hand from stored state, without advancing it.
   * OPTIONAL: a game that omits it resumes viewless (the lobby answers
   * `view: null`) rather than failing to install.
   */
  view?(state: S): ViewNode;
}
```

`view` was added while implementing §4.2's lobby (amended in place, the
`ctx.propertyTypes` precedent). It is not a fourth idea — it is the one this
block was missing: §4.2 requires the lobby to return "the open session's view",
and nothing else could produce one. A `ViewNode` was otherwise reachable only
inside a `GameStep`; `state` is opaque game-owned jsonb the hub cannot
interpret; `act` cannot peek because every action mutates; and the hub must not
import a game to render it. Without `view`, a player who reloads `/casino`
mid-hand cannot be shown their own cards.

**The handlers are pure**, `view` included. No database, no ctx, no clock, no
randomness, no io. Two things follow, and both are the point of this design:

- A game plugin **cannot get money wrong, because it never touches money.** It
  returns a payout figure; the hub decides whether the house can pay it and
  writes every ledger row. This is what makes installing a third-party game a
  smaller act of trust than installing an arbitrary plugin — which matters,
  because `publishCore` means trust is otherwise granted wholesale at install
  time with no runtime guard (CLAUDE.md, design §5).
- A game's entire test surface is pure functions. `blackjack-rules.test.ts`
  needs neither Postgres nor Redis and lives in `@gl3/server:unit`.

**Validation gap, stated.** `definePlugin` checks that a `providesProperties`
id equals the plugin's own id. It cannot do the same for a `GameDef`, which
arrives inside a filter subscription rather than a manifest field. The hub
therefore builds its registry on first use and memoises it, throwing on a
`GameDef` whose `id` is not an installed plugin id or which collides with
another. That is a request-time failure where the property registry gets a
boot-time one, and it is the price of §3's zero-SDK-change choice. It is
recorded as risk 2 in §11.

---

## 4. Sessions and money

### 4.1 The table

`p_casino_sessions`, plugin migration `0000_sessions`:

| column | notes |
|---|---|
| `id` | uuid pk, uuidv7 |
| `player_id` | FK `players` on delete cascade |
| `game_id` | text — the `GameDef` id |
| `location_id` | FK `locations` on delete cascade |
| `property_id` | uuid null — the house row, resolved at `play` and **frozen for the hand** |
| `wager` | bigint, `` .default(sql`0`) `` |
| `state` | jsonb — opaque, game-owned |
| `status` | text, `open` \| `settled` |
| `seed` | text — the shuffle seed, kept for audit |
| `created_at`, `settled_at` | |

```sql
CREATE UNIQUE INDEX p_casino_sessions_one_open
  ON p_casino_sessions (player_id) WHERE status = 'open';
```

One open session per player **across all games**, the shape OC uses for
one-active-heist-per-player. It stops a player holding two hands open, and it
is what makes the escrow accounting single-threaded per player.

`property_id` is frozen at `play` on purpose: a house sold mid-hand must not
move the payout to a new owner who never took the wager.

These are plugin migrations, so `apps/server/test/schema.test.ts` — which
counts FKs and indexes created by *core* migrations — is unaffected. Asserted
under a full `npm run verify`, not assumed.

### 4.2 Routes

| route | body | behaviour |
|---|---|---|
| `GET /api/casino` | — | Lobby. Installed games; for the player's current town, each game's house owner and max bet; the open session's view if there is one. |
| `POST /api/casino/play` | `{ gameId, wager }` | Opens a hand. |
| `POST /api/casino/act` | `{ action }` | Advances it. `action` validated by the game's own zod schema. |

`accessInJail: false`, `accessInHospital: true` on all three — a hospital bed
does not stop you gambling; a cell does.

There is no explicit "settle" route. A hand settles inside whichever call
returns `done: true`, so a one-shot game (roulette, slots) opens and settles in
a single `play` and never writes an open session row at all.

### 4.3 The money path

`play`, in order, in one transaction:

1. **Locks: location → players → session** (§5).
2. Read the player's `location_id` from `player_stats`. The town is where the
   player *is*, never a body parameter.
3. `ownerAt(tx, gameId, locationId)` → the house. `lever` is the **maximum
   bet**, exactly V2 `:276`; `null` falls back to the hub's `max_bet` setting,
   which is bullets' fallback shape.
4. Reject: `no_such_game` (404), `session_open` (409), `wager_below_min`,
   `wager_above_max`, `insufficient_funds` (409).
5. **House exposure check.** If `wager × maxPayoutMultiplier > ownerCash` →
   409 `house_cannot_cover`. Without this the game is quietly broken:
   `payOwner` clamps a debit to the owner's cash, so a player who wins more
   than the house holds would be silently short-paid with no error anywhere.
6. **Escrow**: `payOwner(tx, propertyId, wager, "casino.<gameId>.wager")`
   credits the house, and the player is debited the same amount. V2 `:297`.
7. `game.start({ wager, seed })`. If `done`, settle now; else insert the
   session row.

`act` re-reads the session `FOR UPDATE`, calls `game.act`, applies any
`wagerDelta` (debit player, credit house, update `wager`, **re-run step 5**
against the new wager), and settles when `done`.

**Settle** calls `game.settle(state, wager)` for the total returned to the
player, then `payOwner(tx, propertyId, -payout, "casino.<gameId>.payout")` and
credits the player. V2 `:406`. Because the wager was escrowed at `play`, the
net across a hand is correct without a second bookkeeping concept: a push
returns the wager, a loss returns nothing and the house keeps it.

Every movement goes through `applyBalanceChange` (rule 3).

**Unowned town.** No owner means no `payOwner`: the escrow is a sink and the
payout a faucet, bounded by the `max_bet` setting and the same exposure check
with an infinite house. Both paths are specified and both are tested — the
franchise design's §2.3 keeps unregistered and unowned rows alive, so this is
the common case in a town nobody has bought yet, not an edge.

### 4.4 Abandoned hands

A player who opens a hand and closes the tab holds their one open session
forever. Sessions expire lazily: past the `session_expiry_minutes` setting, the
next `play` settles the stale session as a **forfeit** (payout 0, house keeps
the wager) and proceeds. Lazy at read, no cron — `ensureCurrentRound`'s
pattern. The lobby shows a Resume for an unexpired open session.

### 4.5 Settings

In the hub's `settings.ts`, following properties' shape: `min_bet`,
`max_bet` (the fallback when a house has no lever), `session_expiry_minutes`.
Per-game economics are the game's own business and stay out of settings.

---

## 5. Lock order (rule 6)

Casino is a **locations-first** cluster, joining bullets, theft and properties:

```
tx.locks.location(locationId)
tx.locks.player([playerId, ownerId])   // ONE call — sorts and dedupes
session row FOR UPDATE
payOwner(...)                          // takes the owner; a no-op, already held
```

The one call for both players is what makes **owner-plays-at-own-table** safe
against a second player at the same table — the identical hazard the franchise
design documents at `properties/src/api.ts:51-58` and proves in
`properties-consumer-lock-order.test.ts`. Locking the player first and letting
`payOwner` take the owner second is an ABBA cycle.

The session row is taken after both, and its FKs to `players` and `locations`
take `FOR KEY SHARE` on rows this transaction already holds `FOR UPDATE` — no
inversion. A foreign key is a lock, and these two were read rather than
assumed.

`casino-lock-order.test.ts` proves it, and per the CLAUDE.md corollary its
participants must **not** all acquire through the same helper — a test where
ordering agrees by construction proves only the case that was already safe.

---

## 6. Blackjack

**Rules** (GL3's choice; V2's were not read):

- Six-deck shoe, shuffled once at `start`, dealer stands on all 17.
- A natural pays 3:2 → `settle` returns `2.5 × wager`. A win returns `2×`, a
  push `1×`, a loss `0`.
- Double down on the first two cards only: `wagerDelta = +wager`, one card,
  hand ends. Maximum return stays 2.5 of the *current* wager, which is why
  `maxPayoutMultiplier` is 2.5 and the exposure check re-runs on the delta.
- No split, no insurance, no surrender (§1).

**`state`** holds the shuffled shoe, the cursor into it, both hands, and the
phase. **The whole shoe is dealt at `start`** — that is, shuffled and stored —
so `act` only advances a cursor.

**Randomness.** SPEC §7 says resolve random outcomes in workers so a retry
cannot re-roll a favourable one. A worker per hit is absurd, and the rule is
already not absolute: theft rolls at route time with `node:crypto`'s
`randomInt` (`theft/src/index.ts:160-166`). Blackjack satisfies the rule's
*intent* structurally rather than by machinery — shuffling once at `start` and
persisting the order means **no later roll exists to re-roll**. Every `act` is
a deterministic read of a committed shoe. The `seed` column stores the shuffle
seed so a disputed hand can be replayed.

`node:crypto`'s `randomInt` is the source, never `Math.random` (SPEC §7).

**Property declaration:**

```ts
providesProperties: [{
  id: "blackjack",
  name: "Blackjack Table",
  price: 100_000_000n,      // $1,000,000 in cents — V2's hardcoded figure
  leverLabel: "Maximum bet",
}]
```

`leverLabel` is what makes the same `cost` column read as "Price per bullet" on
a factory and "Maximum bet" on a table — V2's two readings of `PR_cost`, now
labelled instead of implied.

---

## 7. Player surface

**The `cards` view node.** A twelfth kind in the SDK's `pages.ts`:

```ts
{ kind: "cards", cards: string[] }   // ["Sq", "H2", "B1"]
```

Codes are `@letele/playing-cards`' component names — suit initial plus rank
(`Sq`, `H2`, `Da`), with `B1`/`B2` for a face-down back. `PageRenderer` gains
one `case` mapping code → component.

This node is the entire reason an installed third-party game is not
second-class. Rules extensibility is solved by §3; without a card node, UI
extensibility is not — a game that cannot ship React into our bundle could only
render a hand as text. With it, an installed poker plugin declares a page and
gets real cards.

**Library due diligence** (`@letele/playing-cards`):

| | |
|---|---|
| licence | CC0-1.0 — public domain, no attribution burden |
| version | 0.1.0, last published 2023-08-18, single version |
| size | 557 KB unpacked (52 SVG components) |
| React peer dep | **not declared** — only `@babel/runtime` |

Two consequences for the implementation. The renderer builds an **explicit**
code → component map rather than the README's dynamic `deck[code]` lookup, so
that a code which is not a real export fails `tsc` instead of compiling to
`undefined`. And the absent React peer dependency must be verified before
anything is built on it — a 0.1.0 package abandoned for three years is a
reasonable bet for public-domain SVG assets and a poor one for anything with
behaviour, which is why only the assets are relied on.

**Corrected during implementation.** This section originally justified the
explicit map by *tree-shaking*, and that was wrong: the map names all 56
exports, so no unused export survives for a dead-code pass to strip and the
whole deck lands in the bundle either way — measured at **860.86 kB (266 kB
gzip)**, over Vite's 500 kB warning threshold. Typo safety is the map's real
and only benefit. Shrinking the bundle needs a different mechanism (a lazy
import of the map, or vendoring only the cards actually used) and is left as
follow-up rather than folded into this cluster.

Two further facts, found only by building against the package and worth
recording because both were invisible from its npm page:

- **It ships no type declarations.** The manifest names
  `"types": "lib/index.d.ts"` while `"files"` is `["dist"]`, so `lib/` was never
  published. `apps/web` is `strict`, so the import fails TS7016 and
  `skipLibCheck` does not help. An ambient declaration enumerating all 56
  exports is required, and is what makes the typo safety above real.
- **It is not resolvable by Node**, declaring only `"module"` with no `main` or
  `exports`. Vite bundles it fine, but Vitest hardcodes `resolve.mainFields: []`
  for every project's SSR resolution by design, so the test run cannot load it
  until `mainFields` is restored for that one project. Probing with bare `node`
  — or even with `vite-node` — gives an answer that does not predict the test
  run.

**`/casino`** is hand-written at `apps/web/src/pages/Casino.tsx`, like every
other gameplay page (Combat, Properties, OrganizedCrime). It renders the lobby,
the table, and the hand via the same card components the node uses.

**`/admin/casino`** is a manifest-declared `adminPages` table: the three
settings, and a read-only open-sessions list. No UUID is rendered — ids travel
as `valueKey` only, enforced by the existing `admin-ids-hidden.test.ts`.

---

## 8. Events

**None per hand.** One event per blackjack hand floods the feed, which is the
reasoning that killed the `income` event in the franchise design (§3.5, "V2
sends none"). The hand's money is visible in the ledger and in the house's
`profit`. Each route returns the current view directly, so there is no WS
invalidation to trigger either.

No new core `GameEvent` variant, so the four-places rule
(`eventCopy.ts`, `ws/invalidation.ts`, the `CORPUS` guard, and
`packages/shared/test/events.test.ts`'s census) does not fire.

**If a jackpot event is ever added, it must be published from a hub route, not
from a filter.** `runFilterChain` calls a subscriber with the *applying*
plugin's ctx, so `ctx.pluginId` inside a filter is the caller's id — the reason
`properties/src/seizure.ts` uses `tx.notify` rather than `tx.events.publish`.
The engine calls `start`/`act`/`settle` directly inside its own transaction, so
it is not exposed to this; a future contributor adding an event from the wrong
place would be.

---

## 9. Package versions and registration

- **`@gl3/plugin-sdk`** — the `cards` view node is additive → **patch**, and
  republished. The franchise cluster takes it to `0.1.1`, so this is `0.1.2`.
- **`@gl3/shared`** — the hand-written page's DTOs (`CasinoLobbyResponse`,
  `CasinoSessionView`) are additive → **patch**, published **first**, since
  `pages.ts` imports values from it. The registry serves `0.1.4` today and the
  franchise cluster takes it to `0.1.5`, so this is `0.1.6` — to be confirmed
  against the registry at implementation time rather than assumed, since that
  cluster may land more than one bump.
- **`@gl3/plugin-casino`, `@gl3/plugin-blackjack`** — workspace-local, not
  published.
- **`apps/web`** gains `@letele/playing-cards`.

**Two new workspace-local plugins means the eight registration sites, twice**
(CLAUDE.md), three of which fail silently or only in CI: the
`apps/server/tsconfig.json` reference (CI-only — catch it locally with
`npx tsc --build --force apps/server/tsconfig.json`), the `vitest.workspace.ts`
`srcAliases` entry (fails *nothing*, silently grades against a stale `dist/`),
and **five `Dockerfile.server` COPY lines per plugin** —
`grep -c "packages/plugins/casino" Dockerfile.server` must return 5, likewise
for `blackjack`.

The ninth site is per test file: every new `apps/server/test/*.test.ts` must be
listed in `vitest.workspace.ts`'s `include`, or it never runs and `verify`
stays green without it. This bit three tasks on `feat/car-theft`.

---

## 10. Testing

| file | project | proves |
|---|---|---|
| `blackjack-rules.test.ts` | `server:unit` | pure rules: hit, stand, bust, push, natural 3:2, dealer-17, double down's `wagerDelta`; the same seed yields the same shoe |
| `casino-registry.test.ts` | `server:unit` | filter registration; unknown `gameId` → 404; a `GameDef` id that is not an installed plugin id is rejected; duplicate ids rejected |
| `casino-engine.test.ts` | `server` | escrow at `play`, payout at settle, ledger sums, one-open-session, `house_cannot_cover`, exposure re-check on `wagerDelta`, unowned-town faucet/sink, lazy forfeit |
| `casino-lock-order.test.ts` | `server` | owner plays at own table under concurrency; participants do **not** share one lock helper |
| `casino-pages.test.ts` | `plugin-sdk` | the `cards` node's schema, valid and invalid codes |
| `PageRenderer` card case | `@gl3/web` | a `cards` node renders the right components; an unknown code degrades rather than throwing |

Both new plugins own or drive plugin tables, so any file using
`callPluginRoute` / `runPluginJob` without `bootTestServer()` must call
`runPluginMigrations` itself — the template database is built from core
migrations only, and without it every test in the file dies on 42P01.

The last run before merge is the bare `npm run verify`, read by **exit code**,
not by its summary — and not while another agent is running one.

---

## 11. Risks

1. **A third-party game is trusted with the player's screen, not their
   wallet.** §3's purity is a real boundary for money and none at all for the
   `view` a game returns, which is rendered as-is. That is the same trust
   already granted at install time by `publishCore`, and it is narrowed here,
   not widened. Worth stating plainly rather than implying the engine
   sandboxes anything.
2. **`GameDef` id validation is request-time, not boot-time** (§3). A typo'd id
   surfaces on the first lobby load rather than at boot. Accepted as the cost
   of adding no SDK surface; revisit if a second extension point wants the same
   shape.
3. **`@letele/playing-cards` is a 0.1.0 abandoned in 2023 with no declared
   React peer** (§7). Mitigated by relying only on its SVG assets, verifying
   against React 18 in the first task, and the CC0 licence — which means the
   assets can simply be vendored if the package ever breaks.
4. **The engine is judged on one game.** §1 declines to write a second, so the
   interface's generality is an argument, not a demonstration. `wagerDelta`
   exists because blackjack's double down forced it; a roulette or poker port
   will likely force one more thing. Expect a `GameDef` revision at the second
   game and keep the type unpublished until then.

   **Update: the revision landed early, and not from where this predicted.**
   `view?(state)` (§3) was forced by the HUB — §4.2's lobby had to redraw an
   in-progress hand and no second game was involved — during Task 9, before
   any second game exists. That is the more interesting outcome: the pressure
   on this interface comes from what the engine itself needs of a game, not
   only from what the next game needs of the engine, so a second game is no
   longer the only event to watch for. Keeping the type unpublished still
   stands.
5. **Casinos concentrate wealth.** A house that wins over time takes cash from
   many players to one. That is the intended mechanic and the same shape as
   V2's, but it interacts with rounds: a house owner's takings move the very
   leaderboards a round measures. No cap is proposed; flagged for the release
   note.

---

## 12. The reversible decisions

Listed so review knows where the cheap changes are:

- **No per-hand events** (§8) — additive later, costs a `GameEvent`-free plugin
  event and the feed volume question.
- **One open session across all games** rather than per game (§4.1) — a
  narrower partial index, no data migration.
- **Forfeit on expiry** (§4.4) rather than auto-stand. Auto-stand is kinder and
  needs the game to expose a "resolve as if the player stood" path, which
  `settle(state)` almost is.
- **The hub owns no property type** (§2) — adding a town licence later is a new
  plugin, not a change to this one.
