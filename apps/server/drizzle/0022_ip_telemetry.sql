-- Anti-bot layer 0 (spec 2026-08-31-anti-bot-design §Layer 0): where an
-- account came from and where it last acted. Nullable — rows predating this
-- migration have no history to invent — and unindexed on purpose: every
-- reader either has the player id already (the layer-3 pair check) or is an
-- admin-only clustering query that can afford the scan. No FK, no index, so
-- schema.test.ts's counts are untouched.
ALTER TABLE "players" ADD COLUMN "signup_ip" text;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "last_ip" text;
