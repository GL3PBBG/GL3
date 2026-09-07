ALTER TABLE players ADD COLUMN terms_accepted_at timestamptz;
--> statement-breakpoint
-- Grandfathering is explicit and total, exactly as 0014_email_verified did
-- for verification: nobody already playing is ever asked to accept. New
-- registrations are stamped by the register route, which refuses without
-- acceptTerms: true.
UPDATE players SET terms_accepted_at = now();
