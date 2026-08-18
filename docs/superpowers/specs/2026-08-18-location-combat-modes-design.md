# Location combat modes — V2-style underground towns

Date: 2026-08-18. Status: approved (brainstorm review complete).

## 0. What this is, and what it revises

GL3 combat shipped walk-up: `GET /api/combat/targets` lists everyone in the
caller's town and `POST /api/combat/attack/:targetId` needs nothing but
same-location, bullets and a cooldown. V2 was the opposite: nobody in town
was visible or shootable without a paid, successful, unexpired detective
report. The detectives port (2026-08-12 spec, §0) reconciled that by making
detectives the *cross-location* hunting layer and leaving same-location
combat free — for every town, uniformly.

This design makes that a **per-town choice**. A location is either `open`
(combat exactly as shipped) or `underground` (V2's rule: residents are
invisible to the target list and unshootable without an active detective
report on them). Open towns are the cheap, loud places; underground towns
are where you go to disappear — and where a hit takes capital and patience
again.

**Supersession, scoped.** The detectives spec decided "no combat coupling"
(§0, §6: hide/stealth out of scope). This revises that in one direction
only: `combat` gains a *read-only* dependency on `detectives` — the same
plugin→plugin exported-helper shape as combat→inventory's `itemPriceAt` —
while `detectives` still knows nothing about combat. Its worker, routes and
events are untouched.

Decisions taken with V2 as the reference:

| Question | Decision | V2 comparison |
|---|---|---|
| Where the flag lives | Core `locations.combat_mode`, `'open'` \| `'underground'`, default `'open'` | V2 had no flag — every town was effectively underground. The GL3 default preserves shipped behaviour; a fresh install changes nothing until an admin flips a town |
| Visibility in an underground town | Targets list shows **only players the caller holds an active report on**; everyone else is absent, not reasoned | Same — V2's kill page rendered only report rows |
| Attack gate | Active report required: `succeeded`, `ends_at` passed, `expires_at` not | Same checks as V2's `method_shoot`, minus ownership (the helper filters by hirer) |
| Consumption | **Time expiry only.** Attacking does not consume the report | Deviation — V2 expired the report on the first shot, hit or miss. There a report bought one volley that usually killed; GL3 combat is multi-shot whittling, and per-shot consumption would price a kill at `cost × shots`. The expiry window is the licence. Keeps the detectives table write-free from combat |
| Facility rosters | Hospital and jail rosters stay visible in **all** modes | Same as V2 — the rosters were V2's only in-town visibility, and that leak is counterplay: getting hurt or jailed in a hideout town broadcasts you. Core roster routes are untouched by this design |
| Cooldown on a refused shot | Burned, like every other 4xx | Consistent with attack's claim-before-transaction rule. Not a probe vector: whether *you* hold a report is already yours to know via `GET /api/detectives`, and the targets route shows legality for free |
| Death | Unchanged — hospital, never permadeath | Already decided GL3-wide (combat design) |

## 1. Architecture

No new package — changes land in core (one column), `detectives` (one
column + one export), `combat` (two routes), `travel` (listing + admin),
web (two pages). The eight-registration-sites checklist for a *new
package* does not apply, but the new dependency edge still touches three
existing sites: combat's `package.json` gains `@gl3/plugin-detectives`,
combat's `tsconfig.json` gains a project reference to detectives, and
`Dockerfile.server`'s COPY ordering must be verified at plan time
(detectives is already copied; only order relative to combat's build could
matter).

**Core migration `0013_location_combat_mode.sql`:**

```sql
ALTER TABLE locations ADD COLUMN combat_mode text NOT NULL DEFAULT 'open'
  CHECK (combat_mode IN ('open', 'underground'));
```

Drizzle: `combatMode` on `locations` in `db/schema/content.ts`. No index —
the column is only ever read via a row already fetched by PK. No new lock
edge: every read this design adds is a plain SELECT; nothing inserts a row
with an FK to `locations` that did not already (rule 6 audit below).

**Detectives plugin migration `0002_report_expiry`** (one statement per
migration, per bounties' rule):

```sql
ALTER TABLE p_detectives_searches ADD COLUMN expires_at timestamptz;
```

Written at hire: `expires_at = ends_at + detectiveExpire` (the setting as
read at hire time — a settings snapshot, matching the read-at-boot
posture). Why a column instead of computing `ends_at + expire` at read
time: the expire setting lives under the *detectives* settings namespace,
and a combat-side reader cannot reach it — `ctx.settings` prepends the
calling plugin's own id (ctx.ts:302). Materialising the deadline on the row
makes the helper a pure row read and freezes each report's window against
later retuning. Nullable, no backfill migration: a NULL `expires_at` (only
pre-upgrade rows) is treated as expired by the helper (SQL `expires_at >
now` is false for NULL, so this costs nothing) and as
`ends_at + detectiveExpire` by detectives' own tracker route, which keeps
its current behaviour for old rows. The tracker route also switches to
`expires_at` for new rows so the two read paths cannot diverge.

**Detectives export**, from the manifest module (same placement reasoning
as combat's `resolveShot` re-export):

```ts
export async function activeReportTargetIds(
  tx: PluginTx, hirerId: string, now: Date,
): Promise<Set<string>>
```

One SELECT over `p_detectives_searches`: `player_id = hirerId AND
succeeded = true AND ends_at <= now AND expires_at > now`. Read-only, takes
no locks. Combat calls it with a Set-membership check for the single-target
case rather than a second helper — one export, one query shape to test.

**Combat changes** (`packages/plugins/combat`):

- `schema.ts` mirrors gain `locations` (`id`, `combatMode`) — the same
  mirror pattern detectives already uses for `locations`.
- `package.json` gains `@gl3/plugin-detectives` — the **fifth**
  plugin→plugin dependency edge, after combat→inventory, bounties→combat,
  bullets→properties and bullets→travel.
- `attackRoute`: after the `target_elsewhere` check (both parties'
  location is known and equal), plain-SELECT the location's `combat_mode`.
  If `'underground'`, `activeReportTargetIds(tx, player.id, new Date())`
  and 409 `no_detective_report` unless the target is in the set. Placed
  *after* the gang and newbie checks so the error a gangmate or protected
  newbie sees is the same in both town modes — mode must not leak through
  error-ordering differences.
- `targetsRoute`: after reading `me`, plain-SELECT the caller's location
  mode. `'open'`: body as today plus `mode: "open"`. `'underground'`:
  fetch the caller's active-report set once, then run the target query
  with an additional `WHERE player_id IN (<report set>)` predicate —
  **the filter is in SQL, before the `LIMIT 50`, not applied to the 50
  rows afterwards**. A post-`LIMIT` filter would hide a legally
  attackable reported player who ranks below 50th by exp in a crowded
  town, which inverts the route's own never-spend-a-cooldown-to-learn-a-
  rule purpose. The report set is bounded (the tracker caps at 100
  searches), so the `IN` list is small. An empty report set skips the
  query entirely and returns no rows. Body carries
  `mode: "underground"`. Filtered players are **absent**, not reasoned —
  the same shape as `target_elsewhere`, and the route stays advisory-only
  (attack re-checks under the lock; a report expiring between list and
  shot 409s there).

**Operational constraint, recorded:** setting a town to `underground` on a
deployment that does not load the `detectives` plugin makes every attack
and target-list read in that town fail on the missing
`p_detectives_searches` table. The default `'open'` makes this opt-in;
admin-side validation of loaded plugins is out of scope (§6) because the
travel plugin, which owns the admin page, has no view of the loader's
plugin list.

**Travel changes:**

- `LocationListing` gains `readonly combatMode: "open" | "underground"`;
  the list route selects it. Subscribers to `travel.locationsListed`
  (bullets) are unaffected — the interface grows, their stamps don't.
- The admin towns section gains the field as a `select` with the two
  values; 400 `invalid_combat_mode` on anything else (zod enum).

**Migration CLI** (`apps/migrate`): V2 imports default every town to
`'open'`. A `--town-combat-mode=underground` flag flips the default for
operators whose players expect V2 rules everywhere; per-town flips happen
in admin afterwards. One flag, no mapping table.

## 2. Data flow

**Attack in an underground town.** Cooldown claim (unchanged, before the
transaction) → locks → sentence settlement → existing checks through
`protected` → mode read → report-set read → 409 `no_detective_report` or
proceed into the unchanged shot path. Both new reads are single-statement
SELECTs inside the already-open transaction; the report row is never
locked or written.

**Targets in an underground town.** One extra SELECT (mode) and, only when
`'underground'`, one more (report set) feeding the `IN` predicate on the
target query. The empty-town response and the `location_id = null`
response are unchanged.

**Live tracking still composes.** A report's location join lives in
detectives' tracker route and is untouched: hunt from anywhere, watch the
target's current town, travel, and — if their town is underground — the
same report that found them is the licence to shoot them. If they flee to
an *open* town, the report is unnecessary but harmless. The V2 loop
(bounty → detectives → travel → kill → sweep) now ends in either town
type with the same report in hand.

## 3. Web

- `/combat`: the targets response's `mode` drives one new empty-state —
  `"underground"` with no rows renders "Nobody shows their face in this
  town. Hire a detective." linking `/detectives`. Rows that do appear
  (active reports) render exactly as today. No polling change.
- `/travel`: each town row shows a small badge for `combatMode` —
  the board is where the strategic choice ("hide here, hunt there")
  is made, so the mode must be visible before paying the fare.
- `/detectives`: unchanged; succeeded-active rows already link to
  `/travel`.

## 4. Error handling

- **409** `no_detective_report` — attack in an underground town without an
  active report on that target. After `same_gang`/`protected` in check
  order (see §1). Cooldown already burned, deliberately (§0 table).
- **400** `invalid_combat_mode` — admin sets anything outside the enum
  (zod, before any DB read).
- Everything else unchanged; in particular a report that is pending
  (`now < ends_at`), failed, or expired is simply "no report" — one
  error, no oracle for *why* the report doesn't count.

## 5. Testing

- `apps/server/test/location-combat-modes.test.ts` — needs
  `runPluginMigrations` for `combat`, `inventory`, `detectives` and
  `travel` (per the CLAUDE.md template-database rule). Cases: open-town
  attack unchanged; underground attack with no / pending / failed /
  expired report → 409 `no_detective_report` and the cooldown is burned
  (`peek > 0`); with an active report → the shot resolves and the
  existing kill path (payout, hospital, `killResolved`) fires; targets
  list filters to reported players and carries `mode`; a reported player
  appears in an underground town's list even when more than 50 unreported
  players out-rank them by exp (the SQL-side-filter guarantee); gangmate
  in an underground town still gets `same_gang`, proving check order;
  NULL `expires_at` rows count as expired.
- `apps/server/test/detectives.test.ts` gains: hire writes `expires_at =
  ends_at + expire`; tracker route agrees with the helper about the same
  row (the two-read-paths-cannot-diverge claim, pinned).
- Admin: towns section round-trips the field; `invalid_combat_mode` 400.
- **No lock-order test, deliberately** — rule 6 audit: the new reads are
  plain SELECTs on `locations` and `p_detectives_searches`, no new
  INSERT carries an FK into either from a locking path, and
  `p_detectives_searches`'s FKs point at `players`, an edge hire already
  took. No new edge, so a test would prove the already-safe case
  (CLAUDE.md rule 6 corollary). Recorded so nobody adds one.
- `apps/server/test/schema.test.ts`: `0013` adds no FK and no index, so
  the counts hold — but the CHECK constraint and column land in
  `pg_catalog`; verify at plan time whether the file asserts anything the
  new column moves.
- `economy-invariant.test.ts`: untouched — no money moves in this design.
- New test file goes into `vitest.workspace.ts`'s explicit `include`
  list; both failure modes are silent (STATUS, Plan 3).
- `@gl3/shared`: targets DTO gains `mode`, locations DTO gains
  `combatMode` — additive, patch bump. Version number is decided at
  publish time against the live registry, not now — other sessions have
  taken numbers out from under a draft before (see STATUS on `0.1.12`).

## 6. Out of scope

- **Consumption-on-shot** as a per-town or global setting (the V2-exact
  rule). The column and check order make it a small later addition;
  decided against now for the §0 cost reasoning.
- **A third `ghost` mode** (invisible even to detective reports, at a
  price). Wants the shop-price differential shipped first so the
  trade-off exists.
- **Shop-price differentials between town modes** — needs no code:
  per-town bullet prices are core columns and shop prices are per-location
  rows in `p_inventory_shop_stock` with `itemPriceAt` preferring the local
  listing. "Public towns have cheaper shops" is admin data entry today.
- **Admin validation that the detectives plugin is loaded** before
  allowing `'underground'` (recorded as an operational constraint in §1).
- **Roster gating by mode** — decided against, not deferred (§0 table:
  the hospital/jail leak is V2-faithful counterplay).
- **Live settings reload** (system-wide limitation, already in STATUS).
