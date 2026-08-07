ALTER TABLE "crimes" ADD COLUMN "jail_chance_percent" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "crimes" ADD COLUMN "jail_seconds" integer DEFAULT 0 NOT NULL;