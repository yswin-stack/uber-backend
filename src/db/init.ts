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
        phone TEXT UNIQUE,
        pin TEXT,
        role TEXT NOT NULL DEFAULT 'rider',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_phone
      ON users(phone);
    `);

    //
    // SUBSCRIPTIONS – simple monthly periods for now
    //
    await client.query(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        plan TEXT NOT NULL DEFAULT 'premium', -- 'basic' | 'premium' | 'ultimate'
        period_start DATE NOT NULL,
        period_end DATE NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id
      ON subscriptions(user_id);
    `);

    //
    // RIDES – single-driver world, but driver_id is ready
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
        pickup_time TIMESTAMPTZ NOT NULL,
        pickup_window_start TIMESTAMPTZ,
        pickup_window_end TIMESTAMPTZ,
        arrival_window_start TIMESTAMPTZ,
        arrival_window_end TIMESTAMPTZ,
        arrival_target_time TIMESTAMPTZ,
        ride_type TEXT NOT NULL DEFAULT 'standard', -- 'standard' | 'grocery'
        status TEXT NOT NULL DEFAULT 'pending',
        driver_id INTEGER REFERENCES users(id),
        arrived_at TIMESTAMPTZ,
        in_progress_at TIMESTAMPTZ,
        wait_minutes INTEGER NOT NULL DEFAULT 0,
        wait_charge_cents INTEGER NOT NULL DEFAULT 0,
        late_minutes INTEGER NOT NULL DEFAULT 0,
        compensation_type TEXT NOT NULL DEFAULT 'none',
        compensation_applied BOOLEAN NOT NULL DEFAULT FALSE,
        completed_at TIMESTAMPTZ,
        cancelled_at TIMESTAMPTZ,
        notes TEXT
      );
    `);

    // Extra safety: add missing columns for existing DBs
    await client.query(`
      ALTER TABLE rides
      ADD COLUMN IF NOT EXISTS pickup_lat DOUBLE PRECISION;
    `);
    await client.query(`
      ALTER TABLE rides
      ADD COLUMN IF NOT EXISTS pickup_lng DOUBLE PRECISION;
    `);
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
      ADD COLUMN IF NOT EXISTS ride_type TEXT NOT NULL DEFAULT 'standard';
    `);
    await client.query(`
      ALTER TABLE rides
      ADD COLUMN IF NOT EXISTS driver_id INTEGER REFERENCES users(id);
    `);
    await client.query(`
      ALTER TABLE rides
      ADD COLUMN IF NOT EXISTS arrived_at TIMESTAMPTZ;
    `);
    await client.query(`
      ALTER TABLE rides
      ADD COLUMN IF NOT EXISTS in_progress_at TIMESTAMPTZ;
    `);
    await client.query(`
      ALTER TABLE rides
      ADD COLUMN IF NOT EXISTS wait_minutes INTEGER NOT NULL DEFAULT 0;
    `);
    await client.query(`
      ALTER TABLE rides
      ADD COLUMN IF NOT EXISTS wait_charge_cents INTEGER NOT NULL DEFAULT 0;
    `);
    await client.query(`
      ALTER TABLE rides
      ADD COLUMN IF NOT EXISTS late_minutes INTEGER NOT NULL DEFAULT 0;
    `);
    await client.query(`
      ALTER TABLE rides
      ADD COLUMN IF NOT EXISTS compensation_type TEXT NOT NULL DEFAULT 'none';
    `);
    await client.query(`
      ALTER TABLE rides
      ADD COLUMN IF NOT EXISTS compensation_applied BOOLEAN NOT NULL DEFAULT FALSE;
    `);
    await client.query(`
      ALTER TABLE rides
      ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
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
        month_end DATE NOT NULL,
        standard_total INTEGER NOT NULL DEFAULT 40,
        standard_used INTEGER NOT NULL DEFAULT 0,
        grocery_total INTEGER NOT NULL DEFAULT 4,
        grocery_used INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ride_credits_user_month
      ON ride_credits_monthly(user_id, month_start);
    `);

    //
    // SAVED LOCATIONS – home/work/school shortcuts
    //
    await client.query(`
      CREATE TABLE IF NOT EXISTS saved_locations (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        label TEXT NOT NULL, -- 'home' | 'work' | 'school' | future
        address TEXT NOT NULL,
        lat DOUBLE PRECISION,
        lng DOUBLE PRECISION,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_saved_locations_user_id
      ON saved_locations(user_id);
    `);

    //
    // USER SCHEDULES – weekly patterns (Mon–Fri commute)
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

    //
    // REFERRALS & DISCOUNTS
    //
    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS referral_code TEXT UNIQUE;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS referrals (
        id SERIAL PRIMARY KEY,
        referrer_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        referred_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code TEXT NOT NULL,
        reward_cents INTEGER NOT NULL DEFAULT 5000,
        reward_applied BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(referrer_user_id, referred_user_id)
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_referrals_referrer
      ON referrals(referrer_user_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_referrals_referred
      ON referrals(referred_user_id);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS user_discounts (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        label TEXT,
        amount_cents INTEGER NOT NULL,
        is_recurring BOOLEAN NOT NULL DEFAULT FALSE,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_user_discounts_user_id
      ON user_discounts(user_id);
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
