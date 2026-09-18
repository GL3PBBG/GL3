-- Presence layer + world hooks (spec 2026-09-17 §1.4): one server-owned
-- scene descriptor per town, so every client agrees where the garage stands.
-- No row → the same defaults the columns carry; the three seed towns need
-- no rows. Read-only outside admin writes (which do not exist yet) — never
-- inserted inside a player transaction, so no new lock-graph edge.
CREATE TABLE location_scenes (
  location_id uuid PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
  scene_key   text NOT NULL DEFAULT 'default',
  bounds      jsonb NOT NULL DEFAULT '{"minX":-40,"minY":-20,"maxX":40,"maxY":20}',
  spawn       jsonb NOT NULL DEFAULT '{"x":0,"y":-15,"facing":0}'
);
