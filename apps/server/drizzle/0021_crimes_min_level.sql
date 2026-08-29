-- The crime level gate goes live. The column has existed since 0000 as
-- min_rank (the V2 migrator has always written C_level into it), but nothing
-- read it — dead data. Turning the gate on renames it to what it actually
-- compares against, player_stats.level (the same axis locations.min_level
-- was built for, and the numeric level the MCCodes family grows; V2's own
-- C_level was compared against US_rank, a numeric level in practice).
-- Default 0 = ungated, so every native seed and existing install is
-- byte-identical until an admin sets a level on a crime.
-- Drift guard (apps/server/test/schema.test.ts): unchanged — a rename moves
-- no foreign keys and no non-primary-key indexes.
ALTER TABLE "crimes"
  RENAME COLUMN "min_rank" TO "min_level";
