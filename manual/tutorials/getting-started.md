# Getting started

> **Audience:** a new contributor starting from a fresh clone. By the end you have the
> server and web client running locally and the test suite green.

## Prerequisites

- Node.js 22+
- Docker (optional but easiest for the databases), or natively installed
  PostgreSQL 16 and Redis 7
- MariaDB 10.11 (or MySQL) — only if you want the **full** `npm run verify`:
  `apps/migrate`'s tests need `MYSQL_ADMIN_URL` for their fixtures and are not
  covered by `docker-compose.yml`
- Git

## 1. Clone and install

```sh
git clone https://github.com/GL3PBBG/GL3.git
cd GL3
npm install
```

## 2. Start Postgres and Redis

```sh
npm run db:up
```

This starts Postgres 16 and Redis 7 via the included `docker-compose.yml`. Docker is
not required: all that matters is that `DATABASE_URL` and `REDIS_URL` point at a
Postgres 16 and Redis 7 instance. Nothing in the repo auto-loads a `.env` file —
`.env.example` documents the variables, but **export them in your shell** (only
`docker compose` consumes `.env` directly).

## 3. Run migrations

```sh
npm --workspace @gl3/server run db:migrate
```

Run this against your dev database, not just in tests. Test databases are created
fresh per test file and migrate automatically, so the test suite can be fully green
while your dev database is stale: the server boots fine, but every background job
going through BullMQ silently fails because its tables don't exist yet.

## 4. Start the server and web client

```sh
npm --workspace @gl3/server run dev   # http://localhost:3000
npm --workspace @gl3/web run dev      # http://localhost:5173
```

## 5. Verify

```sh
npm run verify   # typecheck + full test suite; needs Postgres and Redis up,
                 # plus MYSQL_ADMIN_URL (MariaDB) for the apps/migrate tests
```

Run this before every commit. `npm run test:nodb` runs the subset that needs no
databases. Before writing tests, read
[Testing conventions](/guides/testing-conventions): new test files must be listed
explicitly in `vitest.workspace.ts` or they silently never run.

## Where to go next

- [Create a plugin](/guides/create-a-plugin): the heart of GL3's architecture,
  including the working conventions (lock ordering, ledger discipline). Read it
  before your first PR.
- [Repository layout](/reference/repo-layout): what lives where.
- [Design decisions](/explanation/): why the system is shaped the way it is.
