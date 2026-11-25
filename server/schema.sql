-- Clutch Arena standalone PostgreSQL schema.
-- JSONB keeps the imported domain records flexible while the API migration is completed.
CREATE TABLE IF NOT EXISTS ca_events (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ca_teams (
  id text PRIMARY KEY,
  event_id text NOT NULL REFERENCES ca_events(id) ON DELETE CASCADE,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ca_teams_event_id_idx ON ca_teams(event_id);
CREATE TABLE IF NOT EXISTS ca_team_history (
  id text PRIMARY KEY,
  event_id text NOT NULL,
  team_id text NOT NULL,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ca_team_history_event_id_idx ON ca_team_history(event_id);
CREATE INDEX IF NOT EXISTS ca_team_history_team_id_idx ON ca_team_history(team_id);
