import pg from 'pg';

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is required. Copy server/.env.example to server/.env and configure PostgreSQL.');
}

export const pool = new Pool({
  connectionString,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: true } : undefined,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err.message);
});

// Create the idempotent application schema automatically on readiness.
export async function checkDatabase() {
  await pool.query(`
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
  `);
}
