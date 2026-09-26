require('dotenv').config();

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required. Copy .env.example to .env and set the local connection string.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tracker_connections (
      user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      encrypted_payload TEXT NOT NULL,
      encryption_iv TEXT NOT NULL,
      authentication_tag TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tracker_defaults (
      user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      queue_key TEXT,
      project_id TEXT,
      board_id TEXT,
      sprint_id TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query('ALTER TABLE tracker_defaults ADD COLUMN IF NOT EXISTS queue_key TEXT');
  console.log('Migration completed: users, tracker_connections and tracker_defaults tables are ready.');
}

migrate()
  .catch((error) => {
    console.error('Migration failed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
