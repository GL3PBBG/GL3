-- Core relinquishes three more tables it never touched.
--
-- `cars`, `theft_tiers` and `garage` shipped in 0000_core_schema because the
-- core schema predated the plugin migration runner — not because core code
-- ever read or wrote them. The single consumer of all three is the `theft`
-- plugin, which now owns and creates them as p_theft_cars / p_theft_tiers /
-- p_theft_garage. This is 0007_relinquish_plugin_tables applied to the next
-- three tables that qualify.
--
-- DROP, not RENAME, for the reason 0007 gives: a rename would leave the
-- plugin migrations doing CREATE TABLE IF NOT EXISTS, weaker than the plain
-- CREATE every other p_-prefixed table uses and weaker than the 42P07 that
-- plugin-migrate.test.ts relies on to prove a migration ran once.
--
-- Ordering: core migrations run to completion before loadPlugins calls
-- runPluginMigrations, so on a fresh database 0000 creates these, this drops
-- them, and the plugin recreates them under its own names — all in one boot.
--
-- `garage` is dropped FIRST because it holds the FKs to the other two;
-- CASCADE would handle it either way, but the explicit order documents that
-- the dependency was considered rather than delegated.
DROP TABLE IF EXISTS "garage" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "theft_tiers" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "cars" CASCADE;
