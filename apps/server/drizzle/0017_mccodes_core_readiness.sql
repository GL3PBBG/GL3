-- Core readiness for MCCodes imports (spec 2026-08-26-mccodes-mechanics-audit,
-- §7 items 1-5, 8, 9, 11). The nerve pool leaves the vocabulary — MCCodes has
-- three pools and "nerve" was a memory-slip for Torn's name for brave's slot;
-- the drop is uniquely cheap while the 0.2.4 SDK releases are unpublished. The
-- import columns arrive in the same window: iq/crime_exp are bigint because
-- MCCodes players grind these past 2^31; health_max is nullable (NULL = max
-- health stays rank-derived); gangs gain respect (war score, default 100 =
-- MCCodes' new-gang value) and points (gangCRYSTALS → points); players gain
-- the second legacy hash pair; locations gain the travel level gate; crimes
-- gain the sandboxed success-formula home.
-- No foreign key, no index: schema.test.ts's two drift counts and
-- player-attributes-schema.test.ts's player_stats counts must stay exactly
-- where they were.
ALTER TABLE "player_stats"
  ADD COLUMN "iq" bigint NOT NULL DEFAULT 0,
  ADD COLUMN "crime_exp" bigint NOT NULL DEFAULT 0,
  ADD COLUMN "health_max" integer,
  DROP COLUMN "nerve",
  DROP COLUMN "nerve_max",
  DROP COLUMN "nerve_regen_at";
ALTER TABLE "players"
  ADD COLUMN "legacy_mccodes_hash" text,
  ADD COLUMN "legacy_mccodes_salt" text;
ALTER TABLE "gangs"
  ADD COLUMN "respect" bigint NOT NULL DEFAULT 100,
  ADD COLUMN "points" bigint NOT NULL DEFAULT 0;
ALTER TABLE "locations"
  ADD COLUMN "min_level" integer NOT NULL DEFAULT 0;
ALTER TABLE "crimes"
  ADD COLUMN "success_formula" text;
