-- Ban state lives on the players row, not in a separate table: no new FK, no
-- new index, no history — matching V2, which kept none either. A NULL
-- banned_at means not banned; ban_expires_at NULL under a non-NULL banned_at
-- means permanent.
ALTER TABLE players ADD COLUMN banned_at timestamptz;
--> statement-breakpoint
ALTER TABLE players ADD COLUMN ban_reason text;
--> statement-breakpoint
ALTER TABLE players ADD COLUMN ban_expires_at timestamptz;
