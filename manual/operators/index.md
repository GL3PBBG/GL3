# Operator guide

> **Audience:** someone self-hosting a GL3 game, not developing it.

GL3 is open source; this section covers installing, configuring, and running your
own game. Contributor material lives in the rest of the manual.

## Topics

- **Install & run**: Node 22, Postgres 16, Redis 7. `docker-compose.yml` and
  `Dockerfile.server` / `Dockerfile.web` cover the containerised path;
  `.env.example` documents every setting, starting with `DATABASE_URL` and
  `REDIS_URL`.
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
  tuning is admin data entry, not code.
