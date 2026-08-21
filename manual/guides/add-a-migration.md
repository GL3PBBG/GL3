# Add a migration

> **Audience:** a contributor changing the database schema, core or plugin.

## Rules that apply to every migration

- **One statement per migration file.** A file does one `ALTER`/`CREATE`; two
  changes are two files.
- Migrations are append-only: never edit a migration that has shipped.
- Prefer nullable new columns with a read-side fallback over backfill migrations
  when old rows have a sensible degraded meaning (see
  [ADR 0001](/explanation/adr/0001-detective-reports-expire-not-consume) for a
  worked example of the pattern).
- Bigint column defaults must be written `` .default(sql`0`) ``, never
  `.default(0n)`; drizzle-kit's serialiser crashes on `BigInt`.

## Core migrations

- Drizzle schema lives in `apps/server/src/db/schema/`; SQL migrations in
  `apps/server/drizzle/`, numbered `NNNN_description.sql`.
- Generate with `npm --workspace @gl3/server run db:generate` after editing the
  schema, or write the SQL by hand for anything drizzle-kit gets wrong. Schema and
  migration change in the same PR.
- Add an index only when a query needs it; a column read via a row already fetched
  by primary key does not.
- **A core migration that adds a foreign key or an index breaks
  `apps/server/test/schema.test.ts`.** It counts every FK by `ON DELETE` rule and
  every non-primary-key index, with a comment block tracing each number to the
  migration that moved it. The fix is always to restate the counts and extend the
  comment, never to loosen the assertion. It runs only under the integration suite,
  so `npm run typecheck` and `verify:ci` stay green with it broken.

## Plugin migrations

Plugin migrations live inside the plugin package and only touch that plugin's
`p_<id>_` tables. The same one-statement rule applies.

## Lock-edge audit

Any migration that adds a table with a foreign key into a table that participates in
locking paths adds a potential lock edge, because **a foreign key is a lock**
(`FOR KEY SHARE` on insert, conflicting with `FOR UPDATE`). Audit against rule 6 in
`NOTES.md`: either add a lock-order regression test or record in the design doc why
no new edge exists. A concurrency test whose participants all acquire locks via the
same helper proves only the case that was already safe.

## Running

```sh
npm --workspace @gl3/server run db:migrate
```

Run this against your dev database after pulling schema changes, not just in tests.
Test databases migrate automatically from a fresh template; your dev database does
not, and a stale one fails silently in background jobs (see
[Getting started](/tutorials/getting-started)).
