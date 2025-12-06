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

    // Add default pickup address fields to users
    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS default_pickup_address TEXT;
    `);
    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS default_pickup_lat DOUBLE PRECISION;
    `);
    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS default_pickup_lng DOUBLE PRECISION;
    `);
    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS address_validated BOOLEAN NOT NULL DEFAULT FALSE;
    `);
    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS address_zone_id INTEGER REFERENCES service_zones(id);
    `);
    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN NOT NULL DEFAULT FALSE;
    `);
    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS onboarding_skipped BOOLEAN NOT NULL DEFAULT FALSE;
    `);
    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS driver_is_online BOOLEAN NOT NULL DEFAULT FALSE;
    `);
    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS driver_last_online_at TIMESTAMPTZ;
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

        //
    // SUBSCRIPTION PLANS & CREDITS (V2)
    //
    await client.query(`
      CREATE TABLE IF NOT EXISTS subscription_plans (
        id SERIAL PRIMARY KEY,
        code TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        monthly_price_cents INTEGER NOT NULL,
        included_ride_credits INTEGER NOT NULL DEFAULT 0,
        included_grocery_credits INTEGER NOT NULL DEFAULT 0,
        peak_access BOOLEAN NOT NULL DEFAULT false,
        max_slots INTEGER,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_plans_code
      ON subscription_plans(code);
    `);

    // Ensure extra columns exist on subscriptions for plan linkage & periods.
    await client.query(`
      ALTER TABLE subscriptions
      ADD COLUMN IF NOT EXISTS plan_id INTEGER REFERENCES subscription_plans(id);
    `);

    await client.query(`
      ALTER TABLE subscriptions
      ADD COLUMN IF NOT EXISTS current_period_start DATE;
    `);

    await client.query(`
      ALTER TABLE subscriptions
      ADD COLUMN IF NOT EXISTS current_period_end DATE;
    `);

    await client.query(`
      ALTER TABLE subscriptions
      ADD COLUMN IF NOT EXISTS payment_method TEXT;
    `);

    await client.query(`
      ALTER TABLE subscriptions
      ADD COLUMN IF NOT EXISTS notes TEXT;
    `);

    // Seed the three core plans (idempotent).
    await client.query(`
      INSERT INTO subscription_plans (
        code,
        name,
        description,
        monthly_price_cents,
        included_ride_credits,
        included_grocery_credits,
        peak_access,
        max_slots,
        is_active
      )
      VALUES
        (
          'premium',
          'Premium Plan',
          '40 rides / month with peak-hour access and highest reliability.',
          20000,
          40,
          4,
          true,
          20,
          true
        ),
        (
          'standard',
          'Standard Plan',
          '40 rides / month outside of peak windows. Great for mid-day classes or shifts.',
          15000,
          40,
          4,
          false,
          NULL,
          true
        ),
        (
          'light',
          'Light Plan',
          'Light plan with fewer rides per month for lighter schedules or occasional commuting.',
          10000,
          15,
          2,
          false,
          NULL,
          true
        )
      ON CONFLICT (code) DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        monthly_price_cents = EXCLUDED.monthly_price_cents,
        included_ride_credits = EXCLUDED.included_ride_credits,
        included_grocery_credits = EXCLUDED.included_grocery_credits,
        peak_access = EXCLUDED.peak_access,
        max_slots = EXCLUDED.max_slots,
        is_active = EXCLUDED.is_active;
    `);


    //
    // ROUTING ENGINE TABLES (V8)
    //

    // Service Zones
    await client.query(`
      CREATE TABLE IF NOT EXISTS service_zones (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        polygon JSONB NOT NULL,
        center_lat DOUBLE PRECISION NOT NULL,
        center_lng DOUBLE PRECISION NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        max_detour_seconds INTEGER NOT NULL DEFAULT 120,
        max_riders_per_trip INTEGER NOT NULL DEFAULT 2,
        max_anchor_distance_meters INTEGER,
        campus_lat DOUBLE PRECISION NOT NULL DEFAULT 49.8075,
        campus_lng DOUBLE PRECISION NOT NULL DEFAULT -97.1365,
        campus_name TEXT NOT NULL DEFAULT 'University of Manitoba',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Time Windows
    await client.query(`
      CREATE TABLE IF NOT EXISTS time_windows (
        id SERIAL PRIMARY KEY,
        service_zone_id INTEGER NOT NULL REFERENCES service_zones(id) ON DELETE CASCADE,
        window_type TEXT NOT NULL CHECK (window_type IN ('MORNING', 'EVENING')),
        label TEXT NOT NULL,
        campus_target_time TIME NOT NULL,
        start_pickup_time TIME NOT NULL,
        max_riders INTEGER NOT NULL DEFAULT 4,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Pickup Points
    await client.query(`
      CREATE TABLE IF NOT EXISTS pickup_points (
        id SERIAL PRIMARY KEY,
        service_zone_id INTEGER NOT NULL REFERENCES service_zones(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        lat DOUBLE PRECISION NOT NULL,
        lng DOUBLE PRECISION NOT NULL,
        is_virtual_stop BOOLEAN NOT NULL DEFAULT FALSE,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Window Assignments
    await client.query(`
      CREATE TABLE IF NOT EXISTS window_assignments (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        time_window_id INTEGER NOT NULL REFERENCES time_windows(id) ON DELETE CASCADE,
        service_date DATE NOT NULL,
        pickup_lat DOUBLE PRECISION NOT NULL,
        pickup_lng DOUBLE PRECISION NOT NULL,
        pickup_address TEXT,
        pickup_stop_id INTEGER REFERENCES pickup_points(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'CONFIRMED' CHECK (status IN ('CONFIRMED', 'WAITLISTED', 'REJECTED', 'CANCELLED')),
        estimated_pickup_time TIMESTAMPTZ,
        estimated_arrival_time TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(user_id, time_window_id, service_date)
      );
    `);

    // Route Plans
    await client.query(`
      CREATE TABLE IF NOT EXISTS route_plans (
        id SERIAL PRIMARY KEY,
        service_date DATE NOT NULL,
        time_window_id INTEGER NOT NULL REFERENCES time_windows(id) ON DELETE CASCADE,
        planned_departure_time TIMESTAMPTZ NOT NULL,
        ordered_assignment_ids INTEGER[] NOT NULL DEFAULT '{}',
        google_route_polyline TEXT,
        google_base_duration_seconds INTEGER,
        google_total_distance_meters INTEGER,
        anchor_assignment_id INTEGER REFERENCES window_assignments(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(service_date, time_window_id)
      );
    `);

    // Trip Logs
    await client.query(`
      CREATE TABLE IF NOT EXISTS trip_logs (
        id SERIAL PRIMARY KEY,
        service_date DATE NOT NULL,
        time_window_id INTEGER NOT NULL REFERENCES time_windows(id) ON DELETE CASCADE,
        route_plan_id INTEGER REFERENCES route_plans(id) ON DELETE SET NULL,
        started_at TIMESTAMPTZ,
        ended_at TIMESTAMPTZ,
        actual_duration_seconds INTEGER,
        actual_route_polyline TEXT,
        notes TEXT,
        driver_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Unserved Requests
    await client.query(`
      CREATE TABLE IF NOT EXISTS unserved_requests (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        entered_address TEXT NOT NULL,
        lat DOUBLE PRECISION NOT NULL,
        lng DOUBLE PRECISION NOT NULL,
        desired_time_type TEXT NOT NULL CHECK (desired_time_type IN ('MORNING', 'EVENING')),
        desired_time TIME,
        reason TEXT NOT NULL CHECK (reason IN ('OUT_OF_ZONE', 'DETOUR_TOO_LARGE', 'WINDOW_FULL', 'NO_CAPACITY', 'OTHER')),
        reason_details TEXT,
        waitlist_opt_in BOOLEAN NOT NULL DEFAULT FALSE,
        notified_at TIMESTAMPTZ,
        expansion_cluster_id INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Expansion Clusters
    await client.query(`
      CREATE TABLE IF NOT EXISTS expansion_clusters (
        id SERIAL PRIMARY KEY,
        name TEXT,
        polygon JSONB,
        center_lat DOUBLE PRECISION,
        center_lng DOUBLE PRECISION,
        radius_meters INTEGER,
        num_requests INTEGER NOT NULL DEFAULT 0,
        is_activated BOOLEAN NOT NULL DEFAULT FALSE,
        activated_service_zone_id INTEGER REFERENCES service_zones(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Route Snapshots (for ML/analytics)
    await client.query(`
      CREATE TABLE IF NOT EXISTS route_snapshots (
        id SERIAL PRIMARY KEY,
        origin_lat DOUBLE PRECISION NOT NULL,
        origin_lng DOUBLE PRECISION NOT NULL,
        destination_lat DOUBLE PRECISION NOT NULL,
        destination_lng DOUBLE PRECISION NOT NULL,
        distance_meters INTEGER NOT NULL,
        duration_seconds INTEGER NOT NULL,
        duration_in_traffic_seconds INTEGER,
        time_window_id INTEGER REFERENCES time_windows(id) ON DELETE SET NULL,
        service_date DATE,
        departure_time TIMESTAMPTZ,
        route_type TEXT DEFAULT 'direct',
        captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Create indexes for routing tables
    await client.query(`CREATE INDEX IF NOT EXISTS idx_service_zones_active ON service_zones (is_active);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_time_windows_zone ON time_windows (service_zone_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_window_assignments_date ON window_assignments (service_date);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_route_plans_date ON route_plans (service_date);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_unserved_requests_waitlist ON unserved_requests (waitlist_opt_in) WHERE waitlist_opt_in = TRUE;`);

    // Seed initial service zone for U of M area
    await client.query(`
      INSERT INTO service_zones (name, polygon, center_lat, center_lng, campus_lat, campus_lng, campus_name)
      VALUES (
        'St Vital → U of M',
        '{"type": "Polygon", "coordinates": [[[-97.12, 49.85], [-97.08, 49.85], [-97.08, 49.82], [-97.12, 49.82], [-97.12, 49.85]]]}',
        49.835, -97.10, 49.8075, -97.1365, 'University of Manitoba'
      )
      ON CONFLICT DO NOTHING;
    `);

    // Seed time windows for the initial zone
    await client.query(`
      INSERT INTO time_windows (service_zone_id, window_type, label, campus_target_time, start_pickup_time, max_riders)
      SELECT sz.id, 'MORNING', 'Arrive by 08:20', '08:20:00', '07:50:00', 4
      FROM service_zones sz WHERE sz.name = 'St Vital → U of M'
      ON CONFLICT DO NOTHING;
    `);
    await client.query(`
      INSERT INTO time_windows (service_zone_id, window_type, label, campus_target_time, start_pickup_time, max_riders)
      SELECT sz.id, 'MORNING', 'Arrive by 09:20', '09:20:00', '08:50:00', 4
      FROM service_zones sz WHERE sz.name = 'St Vital → U of M'
      ON CONFLICT DO NOTHING;
    `);
    await client.query(`
      INSERT INTO time_windows (service_zone_id, window_type, label, campus_target_time, start_pickup_time, max_riders)
      SELECT sz.id, 'EVENING', 'Leave around 16:00', '16:00:00', '16:00:00', 4
      FROM service_zones sz WHERE sz.name = 'St Vital → U of M'
      ON CONFLICT DO NOTHING;
    `);
    await client.query(`
      INSERT INTO time_windows (service_zone_id, window_type, label, campus_target_time, start_pickup_time, max_riders)
      SELECT sz.id, 'EVENING', 'Leave around 17:00', '17:00:00', '17:00:00', 4
      FROM service_zones sz WHERE sz.name = 'St Vital → U of M'
      ON CONFLICT DO NOTHING;
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
