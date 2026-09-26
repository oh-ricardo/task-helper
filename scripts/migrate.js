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
      email TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  // Поддержка базы, созданной предыдущей однопользовательской версией.
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT');
  await pool.query("UPDATE users SET email = 'legacy-' || id || '@local.invalid' WHERE email IS NULL");
  await pool.query("UPDATE users SET display_name = 'Пользователь ' || id WHERE display_name IS NULL");
  await pool.query('ALTER TABLE users ALTER COLUMN email SET NOT NULL');
  await pool.query('ALTER TABLE users ALTER COLUMN display_name SET NOT NULL');
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_idx ON users (email)');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      timezone TEXT NOT NULL DEFAULT 'Europe/Moscow',
      default_priority TEXT NOT NULL DEFAULT 'normal',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT user_settings_priority_check CHECK (default_priority IN ('blocker', 'critical', 'normal', 'minor'))
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
  console.log('Migration completed: users, user_settings, tracker_connections and tracker_defaults tables are ready.');
}

migrate()
  .catch((error) => {
    console.error('Migration failed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
