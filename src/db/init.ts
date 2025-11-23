import { pool } from "./pool";

export async function initDb() {
  // This function runs at server start and ensures all tables/columns exist.
  // It is safe to run repeatedly because we use IF NOT EXISTS everywhere.

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    //
    // USERS
    //
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT,
        name TEXT,
        role TEXT NOT NULL DEFAULT 'subscriber',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        phone TEXT UNIQUE,
        pin TEXT NOT NULL
      );
    `);

    // Make sure role column exists even on older DBs
    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'subscriber';
    `);

    //
    // RIDES (basic version – we will extend later in other steps)
    //
    await client.query(`
      CREATE TABLE IF NOT EXISTS rides (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        pickup_location TEXT NOT NULL,
        dropoff_location TEXT NOT NULL,
        pickup_lat DOUBLE PRECISION,
        pickup_lng DOUBLE PRECISION,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        pickup_time TIMESTAMPTZ,
        ride_type TEXT NOT NULL DEFAULT 'standard', -- 'standard' | 'grocery'
        status TEXT NOT NULL DEFAULT 'pending',     -- pending, confirmed, driver_en_route, arrived, in_progress, completed, cancelled
        driver_id INTEGER REFERENCES users(id),
        completed_at TIMESTAMPTZ
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_rides_user_id ON rides(user_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_rides_pickup_time ON rides(pickup_time);
    `);

    //
    // MONTHLY RIDE CREDITS (older basic model – 40 normal + 4 grocery)
    //
    await client.query(`
      CREATE TABLE IF NOT EXISTS ride_credits_monthly (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        month_start DATE NOT NULL,
        standard_total INTEGER NOT NULL DEFAULT 40,
        standard_used INTEGER NOT NULL DEFAULT 0,
        grocery_total INTEGER NOT NULL DEFAULT 4,
        grocery_used INTEGER NOT NULL DEFAULT 0,
        UNIQUE (user_id, month_start)
      );
    `);

    //
    // WEEKLY SCHEDULE (future, more advanced template with windows)
    // NOTE: not used by current frontend yet, but we will hook into this later.
    //
    await client.query(`
      CREATE TABLE IF NOT EXISTS weekly_schedule (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        day_of_week INTEGER NOT NULL, -- 0=Sunday ... 6=Saturday
        -- desired arrival window (we'll convert to pickup_time when generating rides)
        arrival_start TIME NOT NULL,
        arrival_end TIME NOT NULL,
        pickup_address TEXT NOT NULL,
        dropoff_address TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('to_work', 'to_home')),
        active BOOLEAN NOT NULL DEFAULT TRUE
      );
    `);

    //
    // USER_SCHEDULES (this is what your current /schedule API + frontend use)
    // day_of_week + direction + single arrival_time.
    //
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_schedules (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        day_of_week INTEGER NOT NULL, -- 0=Sunday ... 6=Saturday
        direction TEXT NOT NULL CHECK (direction IN ('to_work', 'to_home')),
        arrival_time TIME NOT NULL
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_user_schedules_user_id
      ON user_schedules(user_id);
    `);

    //
    // NOTIFICATIONS (logging + future in-app messaging)
    //
    await client.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        ride_id INTEGER REFERENCES rides(id) ON DELETE CASCADE,
        channel TEXT NOT NULL,                -- 'sms' | 'email' | 'push'
        message TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query("COMMIT");
    console.log("✅ Database initialized (tables ensured).");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Failed to initialize database", err);
    throw err;
  } finally {
    client.release();
  }
}
