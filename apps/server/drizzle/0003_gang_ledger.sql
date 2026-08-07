ALTER TABLE "transactions" ALTER COLUMN "player_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "gang_id" uuid;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "job_id" text;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_gang_id_gangs_id_fk" FOREIGN KEY ("gang_id") REFERENCES "public"."gangs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transactions_gang_idx" ON "transactions" USING btree ("gang_id");--> statement-breakpoint
CREATE INDEX "transactions_gang_kind_idx" ON "transactions" USING btree ("gang_id","balance_kind");--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_job_id_unique" ON "transactions" USING btree ("job_id");--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_owner_xor" CHECK (("transactions"."player_id" IS NOT NULL) <> ("transactions"."gang_id" IS NOT NULL));