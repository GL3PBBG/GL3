-- Core relinquishes three tables it never touched.
--
-- `bounties` and `detective_searches` shipped in 0000_core_schema and
-- `combat_log` in 0005_combat_log, all three because the core schema predated
-- the plugin migration runner — not because core code ever read or wrote them.
-- Each has exactly one consumer, and that consumer now owns and creates it:
--
--   bounties          -> packages/plugins/bounties   p_bounties_bounties
--   detective_searches-> packages/plugins/detectives p_detectives_searches
--   combat_log        -> packages/plugins/combat     p_combat_log
--
-- DROP, not RENAME: GL3 has no live installs, and a rename would leave the
-- plugin migrations doing CREATE TABLE IF NOT EXISTS — weaker than the plain
-- CREATE that p_inventory_shop_stock and p_oc_* use, and weaker than the
-- 42P07 that plugin-migrate.test.ts relies on to prove a migration ran once.
-- Any deployment that DOES hold rows here must dump these three tables before
-- applying this migration and reload them into the p_-prefixed tables after
-- boot; the column sets are unchanged, only the names are.
--
-- Ordering: core migrations run to completion before loadPlugins calls
-- runPluginMigrations (apps/server/src/plugins/loader.ts:37), so on a fresh
-- database 0000/0005 create these, this drops them, and the plugins recreate
-- them under their own names — all within one boot.
--
-- IF EXISTS throughout so this is a no-op on a database that somehow lacks
-- them, and CASCADE because nothing else references them (checked: no FK in
-- any other core table points here).
DROP TABLE IF EXISTS "bounties" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "detective_searches" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "combat_log" CASCADE;
