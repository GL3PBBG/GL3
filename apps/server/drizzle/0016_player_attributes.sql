-- Seventeen inert columns. No foreign key, no index: nothing selects on any
-- of them (GL3 leaderboards are Redis ZSETs), so schema.test.ts's two drift
-- counts must stay exactly where they were.
ALTER TABLE "player_stats"
  ADD COLUMN "energy" integer NOT NULL DEFAULT 0,
  ADD COLUMN "energy_max" integer NOT NULL DEFAULT 0,
  ADD COLUMN "will" integer NOT NULL DEFAULT 0,
  ADD COLUMN "will_max" integer NOT NULL DEFAULT 0,
  ADD COLUMN "brave" integer NOT NULL DEFAULT 0,
  ADD COLUMN "brave_max" integer NOT NULL DEFAULT 0,
  ADD COLUMN "nerve" integer NOT NULL DEFAULT 0,
  ADD COLUMN "nerve_max" integer NOT NULL DEFAULT 0,
  ADD COLUMN "strength" bigint NOT NULL DEFAULT 0,
  ADD COLUMN "agility" bigint NOT NULL DEFAULT 0,
  ADD COLUMN "guard" bigint NOT NULL DEFAULT 0,
  ADD COLUMN "labour" bigint NOT NULL DEFAULT 0,
  ADD COLUMN "level" integer NOT NULL DEFAULT 1,
  ADD COLUMN "energy_regen_at" timestamp with time zone,
  ADD COLUMN "will_regen_at" timestamp with time zone,
  ADD COLUMN "brave_regen_at" timestamp with time zone,
  ADD COLUMN "nerve_regen_at" timestamp with time zone;
