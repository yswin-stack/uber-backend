-- Basic schema for demo

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  full_name TEXT,
  role TEXT NOT NULL DEFAULT 'subscriber',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  onboarding_completed BOOLEAN NOT NULL DEFAULT FALSE,
  onboarding_skipped BOOLEAN NOT NULL DEFAULT FALSE,
  driver_is_online BOOLEAN NOT NULL DEFAULT FALSE,
  driver_last_online_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
...

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

