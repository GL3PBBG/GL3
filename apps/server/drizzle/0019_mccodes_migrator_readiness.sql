-- Cluster B, milestone B0 (spec 2026-08-26-mccodes-migrator-design §2):
-- the engine pieces the MCCodes migrator needs, both opt-in.
-- weapon_melee_item_id is the melee-only second weapon slot: slot 1
-- (weapon_item_id) stays the firearm slot and stays authoritative when
-- armed, so every GL3-native and V2-migrated game is byte-identical — NULL
-- here is a no-op on every read path (audit §7 item 9's B amendment).
-- crimes.crime_exp_reward is the crime-exp faucet MCCodes' per-crime
-- crimeXP column feeds: without it, the CRIMEXP token of an imported
-- success formula would stagnate at its imported value (audit §7 item 4
-- and item 5's implementation note). Default 0 = GL3-native crimes grant
-- nothing, byte-identical.
-- THIS migration deliberately moves the drift counts: the melee slot's FK
-- mirrors weapon_item_id exactly (REFERENCES items(id) ON DELETE SET NULL —
-- the FK rule for reference columns), so schema.test.ts's totals go
-- 37 -> 38 foreign keys and 13 -> 14 SET NULL, and player_stats's own FK
-- count goes 6 -> 7 in player-attributes-schema.test.ts. Those assertions
-- are restated in the same commit, never loosened.
ALTER TABLE "player_stats"
  ADD COLUMN "weapon_melee_item_id" uuid;
ALTER TABLE "player_stats"
  ADD CONSTRAINT "player_stats_weapon_melee_item_id_items_id_fk"
  FOREIGN KEY ("weapon_melee_item_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "crimes"
  ADD COLUMN "crime_exp_reward" bigint NOT NULL DEFAULT 0;
