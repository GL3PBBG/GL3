ALTER TABLE locations ADD COLUMN combat_mode text NOT NULL DEFAULT 'open'
  CHECK (combat_mode IN ('open', 'underground'));
