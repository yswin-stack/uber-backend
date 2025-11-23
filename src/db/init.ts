import { pool } from "./pool";

export async function initDb() {
  // Ensure all core tables/columns exist. Safe to run repeatedly.
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

    // Ensure newer columns exist on older DBs
    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'subscriber';
    `);

    //
    // RIDES – single source of truth for booked rides
    //
    await client.query(`
      CREATE TABLE IF NOT EXISTS rides (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        pickup_location TEXT NOT NULL,
        dropoff_location TEXT NOT NULL,
        pickup_lat DOUBLE PRECISION,
        pickup_lng DOUBLE PRECISION,
        drop_lat DOUBLE PRECISION,
        drop_lng DOUBLE PRECISION,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        pickup_time TIMESTAMPTZ,
        arrival_target_time TIMESTAMPTZ,
        pickup_window_start TIMESTAMPTZ,
        pickup_window_end TIMESTAMPTZ,
        arrival_window_start TIMESTAMPTZ,
        arrival_window_end TIMESTAMPTZ,
        ride_type TEXT NOT NULL DEFAULT 'standard', -- 'standard' | 'grocery'
        status TEXT NOT NULL DEFAULT 'pending',
        driver_id INTEGER REFERENCES users(id),
        completed_at TIMESTAMPTZ,
        cancelled_at TIMESTAMPTZ,
        notes TEXT
      );
    `);

    // Extra safety: add missing columns for existing DBs
    await client.query(`
      ALTER TABLE rides
      ADD COLUMN IF NOT EXISTS drop_lat DOUBLE PRECISION;
    `);
    await client.query(`
      ALTER TABLE rides
      ADD COLUMN IF NOT EXISTS drop_lng DOUBLE PRECISION;
    `);
    await client.query(`
      ALTER TABLE rides
      ADD COLUMN IF NOT EXISTS arrival_target_time TIMESTAMPTZ;
    `);
    await client.query(`
      ALTER TABLE rides
      ADD COLUMN IF NOT EXISTS pickup_window_start TIMESTAMPTZ;
    `);
    await client.query(`
      ALTER TABLE rides
      ADD COLUMN IF NOT EXISTS pickup_window_end TIMESTAMPTZ;
    `);
    await client.query(`
      ALTER TABLE rides
      ADD COLUMN IF NOT EXISTS arrival_window_start TIMESTAMPTZ;
    `);
    await client.query(`
      ALTER TABLE rides
      ADD COLUMN IF NOT EXISTS arrival_window_end TIMESTAMPTZ;
    `);
    await client.query(`
      ALTER TABLE rides
      ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
    `);
    await client.query(`
      ALTER TABLE rides
      ADD COLUMN IF NOT EXISTS notes TEXT;
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_rides_user_id
      ON rides(user_id);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_rides_pickup_time
      ON rides(pickup_time);
    `);

    //
    // MONTHLY CREDITS – 40 standard + 4 grocery by default
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
    // WEEKLY SCHEDULE TEMPLATES – for future advanced engine
    //
    await client.query(`
      CREATE TABLE IF NOT EXISTS weekly_schedule (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        day_of_week INTEGER NOT NULL, -- 0=Sunday ... 6=Saturday
        arrival_start TIME NOT NULL,
        arrival_end TIME NOT NULL,
        pickup_address TEXT NOT NULL,
        dropoff_address TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('to_work', 'to_home')),
        active BOOLEAN NOT NULL DEFAULT TRUE
      );
    `);

    //
    // USER SCHEDULES – what /schedule API & frontend use today
    //
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_schedules (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        day_of_week INTEGER NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('to_work', 'to_home')),
        arrival_time TIME NOT NULL
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_user_schedules_user_id
      ON user_schedules(user_id);
    `);

    //
    // NOTIFICATIONS – log outgoing SMS/email/push
    //
    await client.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        ride_id INTEGER REFERENCES rides(id) ON DELETE CASCADE,
        channel TEXT NOT NULL,
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
