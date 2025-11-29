-- Basic schema for demo

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE,
  phone TEXT UNIQUE,
  name TEXT,
  full_name TEXT,
  role TEXT NOT NULL DEFAULT 'rider',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  onboarding_completed BOOLEAN NOT NULL DEFAULT FALSE,
  onboarding_skipped BOOLEAN NOT NULL DEFAULT FALSE,
  driver_is_online BOOLEAN NOT NULL DEFAULT FALSE,
  driver_last_online_at TIMESTAMPTZ
);

-- ---------------------------------------------------
-- Subscription plans available for users
-- ---------------------------------------------------
CREATE TABLE IF NOT EXISTS subscription_plans (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  monthly_price_cents INTEGER NOT NULL DEFAULT 0,
  included_ride_credits INTEGER NOT NULL DEFAULT 0,
  included_grocery_credits INTEGER NOT NULL DEFAULT 0,
  peak_access BOOLEAN NOT NULL DEFAULT false,
  max_slots INTEGER,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Insert default plans
INSERT INTO subscription_plans (code, name, description, monthly_price_cents, included_ride_credits, included_grocery_credits, peak_access, max_slots)
VALUES 
  ('light', 'Light', 'Fewer rides for lighter schedules', 9900, 10, 1, false, null),
  ('standard', 'Standard', 'All mid-day rides, no peak', 14900, 20, 2, false, null),
  ('premium', 'Premium', 'Peak hours + best reliability', 19900, 30, 4, true, 50)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS subscriptions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  plan_id INTEGER REFERENCES subscription_plans(id),
  status TEXT NOT NULL DEFAULT 'pending',
  start_date DATE,
  end_date DATE,
  current_period_start DATE,
  current_period_end DATE,
  standard_credits_total INTEGER NOT NULL DEFAULT 0,
  standard_credits_used INTEGER NOT NULL DEFAULT 0,
  grocery_credits_total INTEGER NOT NULL DEFAULT 0,
  grocery_credits_used INTEGER NOT NULL DEFAULT 0,
  payment_method TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user
  ON subscriptions (user_id);

CREATE TABLE IF NOT EXISTS rides (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
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
  ride_type TEXT NOT NULL,
  is_fixed BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'pending',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rides_user_time
  ON rides (user_id, pickup_time);

-- ---------------------------------------------------
-- Ride feedback: rating, comment, optional tip.
-- Each ride can have at most one feedback record.
-- ---------------------------------------------------
CREATE TABLE IF NOT EXISTS ride_feedback (
  id SERIAL PRIMARY KEY,
  ride_id INTEGER NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  rider_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  comment TEXT,
  tip_cents INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Future-ready: when we have multiple drivers, we can populate this:
  driver_id INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ride_feedback_ride
  ON ride_feedback (ride_id);

-- ---------------------------------------------------
-- Saved locations: home, work, school, other addresses
-- ---------------------------------------------------
CREATE TABLE IF NOT EXISTS saved_locations (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL CHECK (label IN ('home', 'work', 'school', 'other')),
  address TEXT NOT NULL,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, label)
);

CREATE INDEX IF NOT EXISTS idx_saved_locations_user
  ON saved_locations (user_id);

-- ---------------------------------------------------
-- Weekly schedule: recurring ride times per day
-- ---------------------------------------------------
CREATE TABLE IF NOT EXISTS user_weekly_schedule (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL CHECK (day_of_week >= 0 AND day_of_week <= 6),
  direction TEXT NOT NULL CHECK (direction IN ('to_work', 'to_home')),
  arrival_time TIME NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, day_of_week, direction)
);

CREATE INDEX IF NOT EXISTS idx_user_weekly_schedule_user
  ON user_weekly_schedule (user_id);

