-- Null preserves legacy defaults for unsettled rounds and unknown prize
-- schedules for historical rounds. New rounds store their explicit schedule.
ALTER TABLE rounds ADD COLUMN payout_points jsonb;
