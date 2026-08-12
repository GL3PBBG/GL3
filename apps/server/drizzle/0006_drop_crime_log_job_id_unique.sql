-- crime_log.job_id was the deleted core worker's idempotency key; the crimes
-- plugin's guard is plugin_job_runs. The plugin's queue (crimes-commit)
-- numbers jobs from 1 independently of the retired core queue (bull:crime),
-- so on a live database the first plugin-era commit reused a core-era job id
-- and this index failed every attempt of the job — a claimed cooldown and no
-- resolution. The column stays as a per-queue trace; it is no longer unique.
DROP INDEX IF EXISTS "crime_log_job_id_unique";
