-- =============================================================================
-- V8 Routing Engine - Database Schema
-- Google Maps-driven routing with traffic-aware timing and detour calculations
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Table: service_zones
-- Geographic areas where the micro-transit service operates
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS service_zones (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  -- Polygon stored as GeoJSON (e.g., {"type": "Polygon", "coordinates": [[[lng, lat], ...]]})
  polygon JSONB NOT NULL,
  -- Center point for quick distance checks
  center_lat DOUBLE PRECISION NOT NULL,
  center_lng DOUBLE PRECISION NOT NULL,
  -- Service configuration
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  max_detour_seconds INTEGER NOT NULL DEFAULT 120, -- 2 minutes default
  max_riders_per_trip INTEGER NOT NULL DEFAULT 2,  -- Pool capacity
  max_anchor_distance_meters INTEGER, -- Optional hard cap from anchor rider
  -- Campus/destination info (default is U of M)
  campus_lat DOUBLE PRECISION NOT NULL DEFAULT 49.8075,
  campus_lng DOUBLE PRECISION NOT NULL DEFAULT -97.1365,
  campus_name TEXT NOT NULL DEFAULT 'University of Manitoba',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_service_zones_active ON service_zones (is_active);

-- -----------------------------------------------------------------------------
-- Table: time_windows
-- Discrete arrival/departure windows within service zones
-- e.g., "Arrive U of M by 08:20", "Leave campus around 15:40"
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS time_windows (
  id SERIAL PRIMARY KEY,
  service_zone_id INTEGER NOT NULL REFERENCES service_zones(id) ON DELETE CASCADE,
  -- Window type and display
  window_type TEXT NOT NULL CHECK (window_type IN ('MORNING', 'EVENING')),
  label TEXT NOT NULL, -- e.g., "Arrive by 08:20"
  -- Timing configuration
  campus_target_time TIME NOT NULL, -- Campus arrival/departure target
  start_pickup_time TIME NOT NULL, -- When driver starts in neighborhood
  -- Capacity
  max_riders INTEGER NOT NULL DEFAULT 4,
  -- Status
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_time_windows_zone ON time_windows (service_zone_id);
CREATE INDEX IF NOT EXISTS idx_time_windows_type ON time_windows (window_type);
CREATE INDEX IF NOT EXISTS idx_time_windows_active ON time_windows (is_active);

-- -----------------------------------------------------------------------------
-- Table: pickup_points
-- Pre-defined or virtual pickup points within service zones
-- -----------------------------------------------------------------------------
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

CREATE INDEX IF NOT EXISTS idx_pickup_points_zone ON pickup_points (service_zone_id);
CREATE INDEX IF NOT EXISTS idx_pickup_points_location ON pickup_points (lat, lng);

-- -----------------------------------------------------------------------------
-- Table: window_assignments
-- Rider assignments to specific time windows for specific dates
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS window_assignments (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  time_window_id INTEGER NOT NULL REFERENCES time_windows(id) ON DELETE CASCADE,
  service_date DATE NOT NULL,
  -- Pickup location
  pickup_lat DOUBLE PRECISION NOT NULL,
  pickup_lng DOUBLE PRECISION NOT NULL,
  pickup_address TEXT,
  pickup_stop_id INTEGER REFERENCES pickup_points(id) ON DELETE SET NULL,
  -- Status
  status TEXT NOT NULL DEFAULT 'CONFIRMED' CHECK (status IN ('CONFIRMED', 'WAITLISTED', 'REJECTED', 'CANCELLED')),
  -- Computed at assignment time
  estimated_pickup_time TIMESTAMPTZ,
  estimated_arrival_time TIMESTAMPTZ,
  -- Tracking
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  UNIQUE(user_id, time_window_id, service_date)
);

CREATE INDEX IF NOT EXISTS idx_window_assignments_user ON window_assignments (user_id);
CREATE INDEX IF NOT EXISTS idx_window_assignments_window ON window_assignments (time_window_id);
CREATE INDEX IF NOT EXISTS idx_window_assignments_date ON window_assignments (service_date);
CREATE INDEX IF NOT EXISTS idx_window_assignments_status ON window_assignments (status);

-- -----------------------------------------------------------------------------
-- Table: route_plans
-- Planned routes for each date + time window combination
-- Stores the ordered pickups and Google route data
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS route_plans (
  id SERIAL PRIMARY KEY,
  service_date DATE NOT NULL,
  time_window_id INTEGER NOT NULL REFERENCES time_windows(id) ON DELETE CASCADE,
  -- Departure time used in Google API calls (includes traffic at this time)
  planned_departure_time TIMESTAMPTZ NOT NULL,
  -- Ordered list of window_assignment IDs in pickup order
  ordered_assignment_ids INTEGER[] NOT NULL DEFAULT '{}',
  -- Google route data
  google_route_polyline TEXT,
  google_base_duration_seconds INTEGER, -- Duration from Google at planned departure time
  google_total_distance_meters INTEGER,
  -- Anchor rider (first confirmed rider sets the base route)
  anchor_assignment_id INTEGER REFERENCES window_assignments(id) ON DELETE SET NULL,
  -- Metadata
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  UNIQUE(service_date, time_window_id)
);

CREATE INDEX IF NOT EXISTS idx_route_plans_date ON route_plans (service_date);
CREATE INDEX IF NOT EXISTS idx_route_plans_window ON route_plans (time_window_id);

-- -----------------------------------------------------------------------------
-- Table: trip_logs
-- Actual trip execution data for analytics
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trip_logs (
  id SERIAL PRIMARY KEY,
  service_date DATE NOT NULL,
  time_window_id INTEGER NOT NULL REFERENCES time_windows(id) ON DELETE CASCADE,
  route_plan_id INTEGER REFERENCES route_plans(id) ON DELETE SET NULL,
  -- Timing
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  actual_duration_seconds INTEGER,
  -- Route data
  actual_route_polyline TEXT,
  -- Metadata
  notes TEXT,
  driver_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trip_logs_date ON trip_logs (service_date);
CREATE INDEX IF NOT EXISTS idx_trip_logs_window ON trip_logs (time_window_id);

-- -----------------------------------------------------------------------------
-- Table: unserved_requests
-- Requests that couldn't be fulfilled (out of zone, detour too large, etc.)
-- Used for expansion planning
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS unserved_requests (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  entered_address TEXT NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  desired_time_type TEXT NOT NULL CHECK (desired_time_type IN ('MORNING', 'EVENING')),
  desired_time TIME,
  -- Rejection reason
  reason TEXT NOT NULL CHECK (reason IN ('OUT_OF_ZONE', 'DETOUR_TOO_LARGE', 'WINDOW_FULL', 'NO_CAPACITY', 'OTHER')),
  reason_details TEXT,
  -- Waitlist
  waitlist_opt_in BOOLEAN NOT NULL DEFAULT FALSE,
  notified_at TIMESTAMPTZ,
  -- Expansion planning
  expansion_cluster_id INTEGER,
  -- Metadata
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_unserved_requests_location ON unserved_requests (lat, lng);
CREATE INDEX IF NOT EXISTS idx_unserved_requests_reason ON unserved_requests (reason);
CREATE INDEX IF NOT EXISTS idx_unserved_requests_waitlist ON unserved_requests (waitlist_opt_in) WHERE waitlist_opt_in = TRUE;

-- -----------------------------------------------------------------------------
-- Table: expansion_clusters
-- Groups of unserved requests that could form new service zones
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS expansion_clusters (
  id SERIAL PRIMARY KEY,
  name TEXT,
  -- Cluster geometry (can be polygon or just center + radius)
  polygon JSONB,
  center_lat DOUBLE PRECISION,
  center_lng DOUBLE PRECISION,
  radius_meters INTEGER,
  -- Stats
  num_requests INTEGER NOT NULL DEFAULT 0,
  -- Status
  is_activated BOOLEAN NOT NULL DEFAULT FALSE,
  activated_service_zone_id INTEGER REFERENCES service_zones(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_expansion_clusters_location ON expansion_clusters (center_lat, center_lng);

-- Add foreign key from unserved_requests to expansion_clusters
ALTER TABLE unserved_requests 
  DROP CONSTRAINT IF EXISTS unserved_requests_expansion_cluster_id_fkey;
ALTER TABLE unserved_requests 
  ADD CONSTRAINT unserved_requests_expansion_cluster_id_fkey 
  FOREIGN KEY (expansion_cluster_id) REFERENCES expansion_clusters(id) ON DELETE SET NULL;

-- -----------------------------------------------------------------------------
-- Table: route_snapshots
-- Historical Google API responses for ML/analytics
-- Captures traffic-aware durations at specific times
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS route_snapshots (
  id SERIAL PRIMARY KEY,
  -- Origin/Destination
  origin_lat DOUBLE PRECISION NOT NULL,
  origin_lng DOUBLE PRECISION NOT NULL,
  destination_lat DOUBLE PRECISION NOT NULL,
  destination_lng DOUBLE PRECISION NOT NULL,
  -- Google response data
  distance_meters INTEGER NOT NULL,
  duration_seconds INTEGER NOT NULL, -- Traffic-aware duration
  duration_in_traffic_seconds INTEGER, -- Explicit traffic duration if available
  -- Context
  time_window_id INTEGER REFERENCES time_windows(id) ON DELETE SET NULL,
  service_date DATE,
  departure_time TIMESTAMPTZ, -- The departure_time used in Google API call
  -- Metadata
  route_type TEXT DEFAULT 'direct', -- 'direct', 'with_stop', etc.
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_route_snapshots_origin ON route_snapshots (origin_lat, origin_lng);
CREATE INDEX IF NOT EXISTS idx_route_snapshots_destination ON route_snapshots (destination_lat, destination_lng);
CREATE INDEX IF NOT EXISTS idx_route_snapshots_window ON route_snapshots (time_window_id);
CREATE INDEX IF NOT EXISTS idx_route_snapshots_departure ON route_snapshots (departure_time);
CREATE INDEX IF NOT EXISTS idx_route_snapshots_date ON route_snapshots (service_date);

-- -----------------------------------------------------------------------------
-- Seed initial service zone for University of Manitoba area
-- St. Vital neighborhood as the initial service area
-- -----------------------------------------------------------------------------
INSERT INTO service_zones (
  name, 
  polygon, 
  center_lat, 
  center_lng,
  campus_lat,
  campus_lng,
  campus_name
)
VALUES (
  'St Vital → U of M',
  '{"type": "Polygon", "coordinates": [[[-97.12, 49.85], [-97.08, 49.85], [-97.08, 49.82], [-97.12, 49.82], [-97.12, 49.85]]]}',
  49.835,
  -97.10,
  49.8075,
  -97.1365,
  'University of Manitoba'
)
ON CONFLICT DO NOTHING;

-- Seed initial time windows for St Vital zone
DO $$
DECLARE
  zone_id INTEGER;
BEGIN
  SELECT id INTO zone_id FROM service_zones WHERE name = 'St Vital → U of M' LIMIT 1;
  
  IF zone_id IS NOT NULL THEN
    -- Morning windows (arriving at U of M)
    INSERT INTO time_windows (service_zone_id, window_type, label, campus_target_time, start_pickup_time, max_riders)
    VALUES 
      (zone_id, 'MORNING', 'Arrive by 08:20', '08:20:00', '07:50:00', 4),
      (zone_id, 'MORNING', 'Arrive by 09:20', '09:20:00', '08:50:00', 4),
      (zone_id, 'MORNING', 'Arrive by 10:20', '10:20:00', '09:50:00', 4)
    ON CONFLICT DO NOTHING;
    
    -- Evening windows (departing from U of M)
    INSERT INTO time_windows (service_zone_id, window_type, label, campus_target_time, start_pickup_time, max_riders)
    VALUES 
      (zone_id, 'EVENING', 'Leave around 15:40', '15:40:00', '15:40:00', 4),
      (zone_id, 'EVENING', 'Leave around 16:40', '16:40:00', '16:40:00', 4),
      (zone_id, 'EVENING', 'Leave around 17:40', '17:40:00', '17:40:00', 4),
      (zone_id, 'EVENING', 'Leave around 18:40', '18:40:00', '18:40:00', 4)
    ON CONFLICT DO NOTHING;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- Function: Update timestamps on route_plans
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_route_plan_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_route_plans_updated ON route_plans;
CREATE TRIGGER trg_route_plans_updated
BEFORE UPDATE ON route_plans
FOR EACH ROW
EXECUTE FUNCTION update_route_plan_timestamp();

-- -----------------------------------------------------------------------------
-- Function: Update timestamps on window_assignments
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_window_assignment_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_window_assignments_updated ON window_assignments;
CREATE TRIGGER trg_window_assignments_updated
BEFORE UPDATE ON window_assignments
FOR EACH ROW
EXECUTE FUNCTION update_window_assignment_timestamp();

