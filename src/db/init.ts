import { pool } from "./pool";

/**
 * Initialize database schema.
 * - Ensures users & rides tables exist
 * - Ensures users table has phone + pin columns
 */
export async function initDb(): Promise<void> {
  try {
    // 1) Create base tables if they don't exist yet
    await pool.query(`
      -- Users table
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        -- optional extra fields can go here (e.g. name, role)
        phone TEXT,
        pin TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Rides table
      CREATE TABLE IF NOT EXISTS rides (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        pickup_location TEXT NOT NULL,
        dropoff_location TEXT NOT NULL,
        pickup_time TIMESTAMPTZ NOT NULL,
        ride_type TEXT NOT NULL,
        is_fixed BOOLEAN NOT NULL DEFAULT FALSE,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // 2) Make sure phone + pin exist on users in case table was created earlier without them
    await pool.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS phone TEXT,
      ADD COLUMN IF NOT EXISTS pin TEXT;
    `);

    console.log("✅ Database initialized (tables ensured).");
  } catch (err) {
    console.error("❌ Failed to initialize database", err);
    throw err;
  }
}
