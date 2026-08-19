ALTER TABLE players ADD COLUMN email_verified_at timestamptz;
--> statement-breakpoint
-- Grandfathering is explicit and total: nobody playing before this migration
-- is ever gated. New registrations insert NULL and verify to clear it.
UPDATE players SET email_verified_at = now();
