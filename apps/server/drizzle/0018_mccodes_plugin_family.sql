-- Cluster C, milestone C1 (spec 2026-08-26-mccodes-plugin-family-design §2):
-- the last schema pieces the plugin family needs. crimes.brave_cost is where
-- MCCodes' crimeBRAVE lands — the crimes route prices a commit in brave from
-- this column iff the brave pool is declared (audit §7 item 13). The
-- health_regen_at stamp is the lazy hp-regen clock C3's settleHealth drives
-- (⅓ of max per 5 minutes, whole intervals — the settlePool discipline);
-- NULL means the clock has never started, the same convention as the pool
-- stamps, so a migrated player regenerates nothing retroactively.
-- No foreign key, no index: schema.test.ts's two drift counts and
-- player-attributes-schema.test.ts's player_stats counts must stay exactly
-- where they were.
ALTER TABLE "crimes"
  ADD COLUMN "brave_cost" integer NOT NULL DEFAULT 0;
ALTER TABLE "player_stats"
  ADD COLUMN "health_regen_at" timestamp with time zone;
