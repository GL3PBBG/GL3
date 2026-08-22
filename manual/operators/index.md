# Operator guide

> **Audience:** someone self-hosting a GL3 game, not developing it.

GL3 is open source; this section covers installing, configuring, and running your
own game. Contributor material lives in the rest of the manual.

## Topics

- **Install & run**: Node 22, Postgres 16, Redis 7. `docker-compose.yml` and
  `Dockerfile.server` / `Dockerfile.web` cover the containerised path;
  `.env.example` documents every setting, starting with `DATABASE_URL` and
  `REDIS_URL`.
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
- **Importing a V2 game**: the migration CLI (`apps/migrate`) offers a one-command
  path from Gangster Legends V2, with `--dry-run`, `--report`, and
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
  economy dashboard the skim appears as positive net flow on the consumer's
  reason (e.g. `properties.bullets`), the same way bullets' half-split already
  did. Knob: `properties.skim_percent` on the properties admin page — unlike
  every other setting it applies immediately, no restart; 0 restores full
  payout.
- **Economy dashboard**: `/admin/economy`, behind its own `economy` grant (grant it
  through Roles like any other module key). Read-only, sourced entirely from the
  transactions ledger: current money supply (player and gang cash/bank, points
  alongside), net flow by ledger reason over the last 7 days, and daily net flow
  over the last 30 days. Net by reason is the faucet/sink signal — a reason whose
  net is positive creates money (crime payouts), negative destroys it (travel,
  bail), and roughly zero is a player-to-player transfer, because transfer pairs
  post equal-and-opposite rows that cancel. No reason list to maintain: a plugin
  with a new reason string appears automatically. Read it before retuning payouts
  or sink prices — it answers "which faucet is running hot" with numbers instead
  of guesses.
