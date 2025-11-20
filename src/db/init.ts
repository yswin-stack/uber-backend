import { pool } from "./pool";

export async function initDb() {
  // This will run once on startup and create tables if they don't exist
  const sql = `
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    full_name TEXT,
    role TEXT NOT NULL DEFAULT 'subscriber',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS subscriptions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS rides (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    pickup_location TEXT NOT NULL,
    dropoff_location TEXT NOT NULL,
    pickup_time TIMESTAMPTZ NOT NULL,
    ride_type TEXT NOT NULL,
    is_fixed BOOLEAN NOT NULL DEFAULT false,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS idx_rides_user_time
    ON rides (user_id, pickup_time);
  `;

  await pool.query(sql);
  console.log("✅ Database initialized (tables ensured).");
}
