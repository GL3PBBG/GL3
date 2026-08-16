-- Rounds become a scoring window. `rounds` gains two independent stamps:
-- `snapshotted_at` (the round's opening whole-population snapshot has been
-- taken) and `finalized_at` (the freeze-and-pay has run). `round_entries` holds
-- one row per player per round: the opening figures, and — once finalized —
-- the frozen final figures. It is also the hall of fame; there is no separate
-- winners table.
--
-- Statement 8 is DML and it is NOT a stray backfill. A V2-migrated install is
-- the only kind that has `rounds` rows before this migration: `apps/migrate`
-- copies EVERY historical V2 round, all long expired. Without this UPDATE every
-- one of them lands `finalized_at = NULL`, which `ensureCurrentRound`'s probe
-- reads as "expired and unsettled" — so the first request after deploy would
-- cascade-finalize the entire V2 history in one transaction, and above the
-- 50-round cap it throws instead, making every rounds and leaderboard request
-- 500 from then on. It touches only rows that are unambiguously over, is a
-- no-op on a fresh install, and leaves the one open-ended migrated round alone
-- so it becomes the install's live round.
ALTER TABLE "rounds" ADD COLUMN "finalized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rounds" ADD COLUMN "snapshotted_at" timestamp with time zone;--> statement-breakpoint
CREATE TABLE "round_entries" (
	"round_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"exp_at_start" bigint DEFAULT 0 NOT NULL,
	"cash_at_start" bigint DEFAULT 0 NOT NULL,
	"bank_at_start" bigint DEFAULT 0 NOT NULL,
	"final_exp" bigint,
	"final_cash" bigint,
	"final_bank" bigint,
	CONSTRAINT "round_entries_round_id_player_id_pk" PRIMARY KEY("round_id","player_id")
);
--> statement-breakpoint
ALTER TABLE "round_entries" ADD CONSTRAINT "round_entries_round_id_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."rounds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "round_entries" ADD CONSTRAINT "round_entries_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "round_entries_player_idx" ON "round_entries" USING btree ("player_id");--> statement-breakpoint
CREATE INDEX "rounds_open_idx" ON "rounds" USING btree ("starts_at") WHERE "finalized_at" IS NULL;--> statement-breakpoint
UPDATE "rounds"
   SET "finalized_at" = now(), "snapshotted_at" = now()
 WHERE "ends_at" IS NOT NULL AND "ends_at" < now();
