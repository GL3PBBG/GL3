-- The transactional outbox (audit item: "DB COMMIT succeeds, Redis PUBLISH
-- fails"). Side effects that used to live only in the in-memory post-commit
-- buffer — plugin/core event envelopes, leaderboard ZADDs, and (with this
-- cluster) job enqueues — are now written as rows in the SAME transaction as
-- the facts, then delivered by a post-commit fast path with a dispatcher as
-- the crash/outage recovery. Rows are deleted on delivery: a queue, not an
-- audit trail. No foreign keys on purpose — a transient row must not take a
-- lock on anything (rule 6), and the payload is self-describing JSON.
-- Drift guard (apps/server/test/schema.test.ts): non-primary-key indexes
-- 30 -> 31 (outbox_not_before_idx). Foreign keys unchanged at 38 — this
-- table deliberately has none.
CREATE TABLE "outbox" (
  "id" uuid PRIMARY KEY,
  "kind" text NOT NULL,
  "payload" jsonb NOT NULL,
  "attempts" integer NOT NULL DEFAULT 0,
  "not_before" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "outbox_not_before_idx" ON "outbox" USING btree ("not_before");
