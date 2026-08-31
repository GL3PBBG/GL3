# Operator guide

> **Audience:** someone self-hosting a GL3 game, not developing it.

GL3 is open source; this section covers installing, configuring, and running your
own game. Contributor material lives in the rest of the manual.

## Topics

- **Install & run**: Node 22, Postgres 16, Redis 7 — or one command with
  Docker: `docker compose --profile app up` stands up the whole game from the
  published images (databases, the migrate one-shot, the plugins-install
  one-shot, the server, the web bundle, and an nginx router keeping the
  browser same-origin — see [First boot](./first-boot.md)). The plugins
  installer requires `GL3_NPM_TOKEN` in `.env`, so set that first. Without the
  profile, the same file is the development database pair (`npm run db:up`) —
  and if the dev pair and the app profile share one host, add the shipped
  `deploy/compose.no-db-ports.yml` override to avoid the 5432/6379 host-port
  collision. `.env.example` documents every setting, starting with
  `DATABASE_URL` and `REDIS_URL`.
- **Choosing a game mode**: `GL3_PROFILE` selects which bundled plugins boot —
  `gl3` (default, the flagship hybrid), `v2` (the faithful V2 port), `mccodes`,
  or `framework` (bare engine) — see
  [Game modes](./framework-profile.md).
- **First boot & upgrades**: how an empty database becomes a playable game
  (core migrations in an init container → seeds and plugin migrations at
  server boot → first registered player becomes Administrator), why the
  migrate step runs on *every* boot, and how it coexists with the
  plugin-install init container — see [First boot](./first-boot.md).
- **Installing plugins without rebuilding**: in the Docker deployment, plugins are
  loaded dynamically through `PLUGIN_PACKAGES` and `PLUGIN_DIR` (a mounted volume),
  validated at boot. No image rebuild needed. The install itself (`npm i` from the
  marketplace registry, with credentials) happens *before* boot in an init
  container — the full walkthrough, including Kubernetes and Compose examples, is
  in [Installing plugins](./installing-plugins.md).
- **Choosing plugins**: note the cross-plugin constraints, e.g. setting any town to
  `underground` combat mode requires the `detectives` plugin to be loaded, or every
  attack and target-list read in that town fails.
- **Importing a V2 or MCCodes game**: the migration CLI (`apps/migrate`) offers
  a one-command path from Gangster Legends V2 — or from MCCodes v2 with the
  `--mccodes` dialect flag — with `--dry-run`, `--report`, `--sql-dump`, and
  `--town-combat-mode open|underground` (use `underground` to keep V2's
  everybody-hidden combat rules everywhere; per-town changes happen in admin
  afterwards). Migrated players keep their passwords: legacy hashes are verified on
  first login and transparently upgraded to argon2id.
- **Settings**: per-plugin settings namespaces, read at boot (no live reload), so a
  retune needs a restart. Some values (like a detective report's expiry window) are
  frozen per row at write time and won't retroactively change.
- **Admin pages**: towns (combat mode, prices), shops, roles, and the plugin admin
  surface under `/api/admin/<pluginId>`. "Public towns have cheaper shops"-style
  tuning is admin data entry, not code. The core Facility fees page (`facilities`
  grant, `/admin/facilities`) edits jail/hospital fee settings, which previously
  had no admin editor at all.
- **Wealth-scaled fees**: bail, hospital discharge, and detectives are priced on
  the payer's wealth — raised toward a percent (default 1%) of the payer's
  cash + bank, floored at the flat fee, capped at a multiple of it (default
  10×). A poor player pays exactly the old flat price; a rich player pays
  more, so the sinks stay felt late-game instead of becoming pocket change.
  The bank counts toward wealth on purpose (depositing is not a bail
  shelter), but the debit itself is still cash-only. Rollback is per feature:
  set the percent to 0 and every payer pays the flat fee again. Knobs (all
  restart-to-apply): `jail.bail_wealth_percent` / `_cap_multiplier`,
  `hospital.discharge_wealth_percent` / `_cap_multiplier` on the Facility fees
  page, and `wealth_percent` / `wealth_cap_multiplier` on the detectives admin
  panel (per-detective-hour unit). Detectives' list cost and the jail/hospital
  rosters are caller-relative — two players see different prices for the same
  inmate or patient. Watch the effect in the economy dashboard: the
  `jail.bail`, `hospital.discharge` and `detectives.hire` sink rows should
  grow as wealth concentrates.
- **Wealth tax**: once per UTC day, every player and gang bank above a
  threshold (default $10M) pays a percent (default 1%) on the EXCESS only,
  destroyed through the ledger (`economy.wealth_tax` shows as a sink row in
  the economy dashboard). Demurrage for wealth parked in banks — including
  franchise owners' takings and long-gone accounts — while cash on hand is
  untouched and stays stealable, so banking remains a tradeoff rather than a
  dominant strategy. Drained players get one notification. Runs as a
  background loop (a settings-table day cursor under an advisory lock, so two
  server instances produce one pass), settles at boot after downtime, and a
  missed day is never double-charged. Knobs on the Wealth tax page under the
  `economy` grant (`economy.wealth_tax_percent`, `economy.wealth_tax_threshold`,
  restart-to-apply); percent 0 switches it off.
- **Franchise skim**: a share (default 10%) of every franchise owner CREDIT is
  destroyed rather than paid — bullet-factory sales and casino house takings
  now partly drain the economy instead of purely pooling at owners. Debits
  are never skimmed, so a casino house always pays winnings in full, and the
  exposure checks read the owner's real (post-skim) balance. Property
  buy/sell between players is NOT franchise income and is not skimmed. In the
  economy dashboard the skim appears as net destruction on the consumer's
  reason (e.g. `bullets.purchase` nets to the kept half plus the skim), the
  same shape as a casino house's wager/payout pairing. Knob: `properties.skim_percent` on the properties admin page — unlike
  every other setting it applies immediately, no restart; 0 restores full
  payout.
- **Economy dashboard**: `/admin/economy`, behind its own `economy` grant (grant it
  through Roles like any other module key). The admin panel's one bespoke page:
  total tiles up front (money supply, 7-day and 30-day net, biggest faucet and
  sink of the week), a 30-day daily-net chart (faucet days rise in gold, sink
  days hang in red), a reconstructed money-supply trend, and the per-reason
  flow table. All of it sourced from the transactions ledger and cached for
  five minutes — the footer says when it was measured. Net by reason is the
  faucet/sink signal — a reason whose net is positive creates money (crime
  payouts), negative destroys it (travel, bail), and roughly zero is a
  player-to-player transfer, because transfer pairs post equal-and-opposite
  rows that cancel. No reason list to maintain: a plugin with a new reason
  string appears automatically. Read it before retuning payouts or sink
  prices — it answers "which faucet is running hot" with numbers instead of
  guesses.
- **Anti-bot moderation**: IP telemetry (set `CLIENT_IP_HEADER` behind a
  trusted proxy or every player shares the tunnel's address), the `anti-bot`
  admin section (ledger-scored suspects, IP clusters), the admin-triggered
  human-check challenge, and the default-on same-IP blocks on property
  transfers and membership gifts — see [Anti-bot](./anti-bot.md). Nothing
  automated bans anyone; the tools surface evidence and leave the call to
  you.
