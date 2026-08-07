ALTER TABLE "crime_log" ADD COLUMN "job_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "crime_log_job_id_unique" ON "crime_log" USING btree ("job_id");