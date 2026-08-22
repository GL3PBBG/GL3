# First boot and the schema lifecycle

> **Audience:** an operator standing up a GL3 deployment, or upgrading one.

A GL3 game goes from empty database to playable in one boot, and stays
schema-correct across every upgrade, through three layers that run in a fixed
order. Understanding which layer owns what answers most "why is this
running?" questions.

## The three layers

**1. Core migrations — `apps/server/dist/db/migrate.js`, in an init container.**
Applies the core schema (`players`, `locations`, `settings`, `transactions`,
…) from the SQL files baked into the image, tracked in `__drizzle_migrations`.
The server's own CMD deliberately does **not** do this.

**2. Seeds and plugin migrations — inside the server process, at boot.**
- Starter content (crimes, ranks, towns, items) is seeded by the server on
  startup, guarded by "if any row exists, do nothing" — it fires exactly once
  per database and never touches a live game. Importing a V2 game with
  `apps/migrate` fills those tables first, so the seeds stay out of the way.
- Each loaded plugin's migrations (including its seed rows — shop stock,
  theft tiers, and so on) are applied by the plugin loader, tracked in
  `plugin_migrations`, idempotent across reboots. **Installing or updating a
  plugin never needs a schema step from you** — drop the package into
  `PLUGIN_DIR`, name it in `PLUGIN_PACKAGES`, boot.

**3. The first Administrator — at registration, not at boot.**
The first player to register becomes Administrator with the `*` grant
(advisory-lock guarded, so two simultaneous first registrations cannot both
win). A brand-new deployment is: boot, register, you are the admin.

## Why migrate runs on every boot

The migrate init container is not a first-boot-only step. It runs before
every server start, and that is deliberate:

- **It is idempotent and nearly free.** Already-applied migrations are
  skipped; a boot with nothing new completes in under a second.
- **It removes a whole outage class.** Image and schema always deploy in
  lockstep — there is no "pulled the new image, forgot the migrate step"
  state. A server booted against a stale schema does not fail politely; it
  dies on its first query with `42703 column does not exist` or
  `42P01 relation does not exist`.

Treat it as "assert the schema matches this image", which happens to also
perform the first-boot creation.

**The single-replica assumption.** Per-boot migration assumes one server
replica (or serialized rollouts). N replicas booting simultaneously race the
migrator. If you scale GL3 to multiple server pods, promote the migrate step
to a one-shot Job that runs once per rollout, before any pod starts.

## Two init containers, one pod

If you install marketplace plugins you already run a second init container
(see [Installing plugins](./installing-plugins.md)). They are a list, not a
slot — Kubernetes runs them sequentially, all before the server. Their
relative order does not matter (one talks only to Postgres, the other only to
the registry and a volume); keeping them separate is deliberate, so the
registry token exists only in the installer and the migrate container needs
no network beyond Postgres.

```yaml
spec:
  template:
    spec:
      volumes:
        - name: plugins
          emptyDir: {}
      initContainers:
        - name: db-migrate
          image: ghcr.io/<you>/gl3-server:<tag>     # the server image itself
          command: ["node", "apps/server/dist/db/migrate.js"]
          env:
            - name: DATABASE_URL
              valueFrom: { secretKeyRef: { name: gl3, key: database-url } }
        - name: install-plugins
          image: node:22-alpine                     # has npm; the server image does not
          command: ["npm", "ci", "--prefix", "/data/plugins"]
          volumeMounts: [{ name: plugins, mountPath: /data/plugins }]
          # registry credentials live HERE only — see Installing plugins
      containers:
        - name: server
          image: ghcr.io/<you>/gl3-server:<tag>
          env:
            - name: PLUGIN_DIR
              value: /data/plugins
          volumeMounts: [{ name: plugins, mountPath: /data/plugins }]
```

Compose has no native init containers; the same effect is two one-shot
services with `depends_on: { condition: service_completed_successfully }` on
the server.

## Troubleshooting

- **Migrate init container never finishes.** It has no loop; "still running"
  means "stuck waiting". Two causes cover it:
  1. *Postgres unreachable* — wrong `DATABASE_URL` from inside the pod
     network, or the DB not up yet. The hang is silent.
  2. *Lock wait* — DDL in a new migration waits behind live connections,
     classically an old replica still serving during a rolling deploy. Check:
     ```sql
     select pid, state, wait_event_type, wait_event, left(query,60)
     from pg_stat_activity where datname = current_database();
     ```
     A `Lock` wait → `select pg_blocking_pids(<pid>);` names the blocker.
     Stop the old replica (or terminate the stale backend) and migrate
     finishes in seconds.
- **Server boots then dies on `42703` / `42P01`.** The migrate step was
  skipped or pointed at a different database than the server. Both must use
  the same `DATABASE_URL`.
- **Empty game after import.** The seeds only fire on an empty database; if
  `apps/migrate` reported success but the game looks empty, the server is
  pointed at a different database than the import target.
