-- =============================================================================
-- V8 Scheduling & Reliability Engine - Database Schema
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Table: slot_capacity
-- Tracks capacity for each time slot (peak vs off-peak, premium vs non-premium)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS slot_capacity (
  id SERIAL PRIMARY KEY,
  slot_id TEXT NOT NULL UNIQUE,
  date DATE NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('home_to_campus', 'campus_to_home', 'home_to_work', 'work_to_home', 'other')),
  slot_type TEXT NOT NULL CHECK (slot_type IN ('peak', 'off_peak')),
  arrival_start TIME NOT NULL,
  arrival_end TIME NOT NULL,
  
  -- Premium capacity (always available in this slot)
  max_riders_premium INTEGER NOT NULL DEFAULT 2,
  used_riders_premium INTEGER NOT NULL DEFAULT 0,
  
  -- Non-Premium capacity (only for off-peak slots)
  max_riders_non_premium INTEGER NOT NULL DEFAULT 0,
  used_riders_non_premium INTEGER NOT NULL DEFAULT 0,
  
  -- Fragile flag: if true, this slot is tight and at risk
  fragile BOOLEAN NOT NULL DEFAULT FALSE,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  
  CHECK (used_riders_premium >= 0),
  CHECK (used_riders_non_premium >= 0),
  CHECK (used_riders_premium <= max_riders_premium),
  CHECK (used_riders_non_premium <= max_riders_non_premium)
);

CREATE INDEX IF NOT EXISTS idx_slot_capacity_date ON slot_capacity (date);
CREATE INDEX IF NOT EXISTS idx_slot_capacity_date_direction ON slot_capacity (date, direction);
CREATE INDEX IF NOT EXISTS idx_slot_capacity_slot_type ON slot_capacity (date, slot_type);

-- -----------------------------------------------------------------------------
-- Table: slot_holds
-- Temporary holds on slots (5-minute expiry)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS slot_holds (
  id SERIAL PRIMARY KEY,
  hold_id TEXT NOT NULL UNIQUE,
  slot_id TEXT NOT NULL REFERENCES slot_capacity(slot_id) ON DELETE CASCADE,
  rider_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_type TEXT NOT NULL CHECK (plan_type IN ('premium', 'standard', 'off_peak')),
  
  -- Hold details
  origin_lat DOUBLE PRECISION NOT NULL,
  origin_lng DOUBLE PRECISION NOT NULL,
  destination_lat DOUBLE PRECISION NOT NULL,
  destination_lng DOUBLE PRECISION NOT NULL,
  origin_address TEXT,
  destination_address TEXT,
  
  -- Timing
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  
  -- Status
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'confirmed', 'expired', 'cancelled')),
  confirmed_at TIMESTAMPTZ,
  confirmed_ride_id INTEGER REFERENCES rides(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_slot_holds_status ON slot_holds (status);
CREATE INDEX IF NOT EXISTS idx_slot_holds_expires ON slot_holds (expires_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_slot_holds_rider ON slot_holds (rider_id);
CREATE INDEX IF NOT EXISTS idx_slot_holds_slot ON slot_holds (slot_id);

-- -----------------------------------------------------------------------------
-- Table: simulation_jobs
-- Monte Carlo simulation jobs and results
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS simulation_jobs (
  id SERIAL PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE,
  date DATE NOT NULL,
  
  -- Scenario parameters
  scenario JSONB NOT NULL DEFAULT '{}',
  
  -- Job status
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  
  -- Results (populated on completion)
  results JSONB,
  
  -- Timing
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  
  -- Metadata
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  run_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_simulation_jobs_date ON simulation_jobs (date);
CREATE INDEX IF NOT EXISTS idx_simulation_jobs_status ON simulation_jobs (status);

-- -----------------------------------------------------------------------------
-- Table: daily_capacity_summary
-- Pre-computed daily capacity summaries for fast admin lookups
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS daily_capacity_summary (
  id SERIAL PRIMARY KEY,
  date DATE NOT NULL UNIQUE,
  
  -- Premium capacity (fixed at 20)
  premium_capacity INTEGER NOT NULL DEFAULT 20,
  premium_booked_count INTEGER NOT NULL DEFAULT 0,
  
  -- Non-Premium capacity (computed dynamically)
  non_premium_capacity_computed INTEGER NOT NULL DEFAULT 0,
  non_premium_booked_count INTEGER NOT NULL DEFAULT 0,
  
  -- Computed metrics
  reliability_score DOUBLE PRECISION, -- 0-1, computed by Monte Carlo
  last_simulation_id INTEGER REFERENCES simulation_jobs(id) ON DELETE SET NULL,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_daily_capacity_summary_date ON daily_capacity_summary (date);

-- -----------------------------------------------------------------------------
-- Table: rider_behavior_stats
-- Historical rider behavior for predictive modeling
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rider_behavior_stats (
  id SERIAL PRIMARY KEY,
  rider_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  
  -- Aggregated stats
  total_rides INTEGER NOT NULL DEFAULT 0,
  on_time_pickups INTEGER NOT NULL DEFAULT 0,
  late_pickups INTEGER NOT NULL DEFAULT 0,
  no_shows INTEGER NOT NULL DEFAULT 0,
  
  -- Delay statistics (in minutes)
  avg_ready_delay_minutes DOUBLE PRECISION NOT NULL DEFAULT 0,
  std_ready_delay_minutes DOUBLE PRECISION NOT NULL DEFAULT 2,
  max_ready_delay_minutes DOUBLE PRECISION NOT NULL DEFAULT 0,
  
  -- Reliability score (0-1)
  reliability_score DOUBLE PRECISION NOT NULL DEFAULT 0.9,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  
  UNIQUE(rider_id)
);

CREATE INDEX IF NOT EXISTS idx_rider_behavior_stats_rider ON rider_behavior_stats (rider_id);

-- -----------------------------------------------------------------------------
-- Extend rides table with scheduling engine fields
-- -----------------------------------------------------------------------------
ALTER TABLE rides ADD COLUMN IF NOT EXISTS slot_id TEXT;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS plan_type TEXT DEFAULT 'standard';
ALTER TABLE rides ADD COLUMN IF NOT EXISTS hold_id TEXT;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS predicted_arrival TIMESTAMPTZ;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS actual_arrival TIMESTAMPTZ;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS was_on_time BOOLEAN;

CREATE INDEX IF NOT EXISTS idx_rides_slot_id ON rides (slot_id);
CREATE INDEX IF NOT EXISTS idx_rides_plan_type ON rides (plan_type);

-- -----------------------------------------------------------------------------
-- Function: Update slot capacity on ride insert/update/delete
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_slot_capacity_on_ride_change()
RETURNS TRIGGER AS $$
BEGIN
  -- This function is called after INSERT/UPDATE/DELETE on rides
  -- It updates the used_riders_premium and used_riders_non_premium counters
  
  IF TG_OP = 'INSERT' AND NEW.slot_id IS NOT NULL THEN
    IF NEW.plan_type = 'premium' THEN
      UPDATE slot_capacity 
      SET used_riders_premium = used_riders_premium + 1,
          updated_at = now()
      WHERE slot_id = NEW.slot_id;
    ELSE
      UPDATE slot_capacity 
      SET used_riders_non_premium = used_riders_non_premium + 1,
          updated_at = now()
      WHERE slot_id = NEW.slot_id;
    END IF;
  END IF;
  
  IF TG_OP = 'UPDATE' AND OLD.status NOT IN ('cancelled', 'cancelled_by_user', 'cancelled_by_admin', 'cancelled_by_driver', 'no_show') 
     AND NEW.status IN ('cancelled', 'cancelled_by_user', 'cancelled_by_admin', 'cancelled_by_driver', 'no_show') 
     AND OLD.slot_id IS NOT NULL THEN
    -- Ride was cancelled, decrement capacity
    IF OLD.plan_type = 'premium' THEN
      UPDATE slot_capacity 
      SET used_riders_premium = GREATEST(used_riders_premium - 1, 0),
          updated_at = now()
      WHERE slot_id = OLD.slot_id;
    ELSE
      UPDATE slot_capacity 
      SET used_riders_non_premium = GREATEST(used_riders_non_premium - 1, 0),
          updated_at = now()
      WHERE slot_id = OLD.slot_id;
    END IF;
  END IF;
  
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_update_slot_capacity ON rides;
CREATE TRIGGER trg_update_slot_capacity
AFTER INSERT OR UPDATE ON rides
FOR EACH ROW
EXECUTE FUNCTION update_slot_capacity_on_ride_change();

-- -----------------------------------------------------------------------------
-- Seed initial subscription_plans with premium subscriber tracking
-- -----------------------------------------------------------------------------
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS max_premium_subscribers INTEGER DEFAULT NULL;

-- Update premium plan to have max 20 subscribers
UPDATE subscription_plans 
SET max_premium_subscribers = 20 
WHERE code = 'premium';

-- Add premium subscriber counter table
CREATE TABLE IF NOT EXISTS premium_subscriber_count (
  id SERIAL PRIMARY KEY,
  current_count INTEGER NOT NULL DEFAULT 0,
  max_count INTEGER NOT NULL DEFAULT 20,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (current_count >= 0),
  CHECK (current_count <= max_count)
);

-- Initialize with single row
INSERT INTO premium_subscriber_count (current_count, max_count) 
VALUES (0, 20) 
ON CONFLICT DO NOTHING;

