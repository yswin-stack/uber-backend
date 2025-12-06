/**
 * Routing Engine - Google Maps integration for traffic-aware routing
 * Handles route calculation, detour checks, and time window feasibility
 */

import { pool } from "../db/pool";

// Use native fetch (Node 18+) - no external dependency needed
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || "";

interface LatLng {
  lat: number;
  lng: number;
}

interface RouteResult {
  durationSeconds: number;
  durationInTrafficSeconds: number;
  distanceMeters: number;
  polyline?: string;
}

interface WindowAssignment {
  id: number;
  userId: number;
  pickupLat: number;
  pickupLng: number;
  pickupAddress?: string;
  estimatedPickupTime?: string;
}

interface CanAddResult {
  accepted: boolean;
  bestInsertionIndex?: number;
  extraSeconds?: number;
  newTotalDurationSeconds?: number;
  estimatedPickupTime?: string;
  estimatedArrivalTime?: string;
  reason?: string;
  alternativeWindows?: Array<{
    timeWindowId: number;
    label: string;
    availableSeats: number;
  }>;
}

/**
 * Logs a route snapshot for analytics/ML training
 */
async function logRouteSnapshot(
  origin: LatLng,
  destination: LatLng,
  distanceMeters: number,
  durationSeconds: number,
  durationInTrafficSeconds: number,
  departureTime: Date,
  timeWindowId?: number,
  serviceDate?: string
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO route_snapshots 
       (origin_lat, origin_lng, destination_lat, destination_lng, 
        distance_meters, duration_seconds, duration_in_traffic_seconds,
        departure_time, time_window_id, service_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        origin.lat,
        origin.lng,
        destination.lat,
        destination.lng,
        distanceMeters,
        durationSeconds,
        durationInTrafficSeconds,
        departureTime.toISOString(),
        timeWindowId || null,
        serviceDate || null,
      ]
    );
  } catch (err) {
    console.error("Failed to log route snapshot:", err);
    // Don't throw - logging failure shouldn't break the main flow
  }
}

/**
 * Get traffic-aware duration between two points using Google Distance Matrix API
 */
export async function getTrafficAwareDuration(
  origin: LatLng,
  destination: LatLng,
  departureTime: Date
): Promise<RouteResult> {
  if (!GOOGLE_MAPS_API_KEY) {
    console.warn("GOOGLE_MAPS_API_KEY not set - using fallback estimate");
    // Fallback: estimate ~30 km/h average speed in urban area
    const distKm = haversineDistance(origin, destination);
    const durationSec = Math.round((distKm / 30) * 3600);
    return {
      durationSeconds: durationSec,
      durationInTrafficSeconds: durationSec,
      distanceMeters: Math.round(distKm * 1000),
    };
  }

  try {
    const url = new URL("https://maps.googleapis.com/maps/api/distancematrix/json");
    url.searchParams.set("origins", `${origin.lat},${origin.lng}`);
    url.searchParams.set("destinations", `${destination.lat},${destination.lng}`);
    url.searchParams.set("mode", "driving");
    url.searchParams.set("departure_time", Math.floor(departureTime.getTime() / 1000).toString());
    url.searchParams.set("traffic_model", "best_guess");
    url.searchParams.set("key", GOOGLE_MAPS_API_KEY);

    const response = await fetch(url.toString());
    const data = await response.json();

    if (data.status !== "OK" || !data.rows?.[0]?.elements?.[0]) {
      throw new Error(`Distance Matrix API error: ${data.status}`);
    }

    const element = data.rows[0].elements[0];
    if (element.status !== "OK") {
      throw new Error(`Route element error: ${element.status}`);
    }

    const result: RouteResult = {
      durationSeconds: element.duration.value,
      durationInTrafficSeconds: element.duration_in_traffic?.value || element.duration.value,
      distanceMeters: element.distance.value,
    };

    // Log for analytics
    await logRouteSnapshot(
      origin,
      destination,
      result.distanceMeters,
      result.durationSeconds,
      result.durationInTrafficSeconds,
      departureTime
    );

    return result;
  } catch (err) {
    console.error("Error calling Distance Matrix API:", err);
    // Fallback estimate
    const distKm = haversineDistance(origin, destination);
    const durationSec = Math.round((distKm / 25) * 3600); // Conservative 25 km/h
    return {
      durationSeconds: durationSec,
      durationInTrafficSeconds: durationSec,
      distanceMeters: Math.round(distKm * 1000),
    };
  }
}

/**
 * Get full route with polyline using Google Directions API
 */
export async function getRouteWithPolyline(
  origin: LatLng,
  destination: LatLng,
  waypoints: LatLng[],
  departureTime: Date
): Promise<RouteResult & { polyline: string }> {
  if (!GOOGLE_MAPS_API_KEY) {
    return {
      durationSeconds: 600,
      durationInTrafficSeconds: 600,
      distanceMeters: 5000,
      polyline: "",
    };
  }

  try {
    const url = new URL("https://maps.googleapis.com/maps/api/directions/json");
    url.searchParams.set("origin", `${origin.lat},${origin.lng}`);
    url.searchParams.set("destination", `${destination.lat},${destination.lng}`);
    url.searchParams.set("mode", "driving");
    url.searchParams.set("departure_time", Math.floor(departureTime.getTime() / 1000).toString());
    url.searchParams.set("traffic_model", "best_guess");
    url.searchParams.set("key", GOOGLE_MAPS_API_KEY);

    if (waypoints.length > 0) {
      const waypointsStr = waypoints.map((wp) => `${wp.lat},${wp.lng}`).join("|");
      url.searchParams.set("waypoints", `optimize:true|${waypointsStr}`);
    }

    const response = await fetch(url.toString());
    const data = await response.json();

    if (data.status !== "OK" || !data.routes?.[0]) {
      throw new Error(`Directions API error: ${data.status}`);
    }

    const route = data.routes[0];
    let totalDuration = 0;
    let totalDurationInTraffic = 0;
    let totalDistance = 0;

    for (const leg of route.legs) {
      totalDuration += leg.duration.value;
      totalDurationInTraffic += leg.duration_in_traffic?.value || leg.duration.value;
      totalDistance += leg.distance.value;
    }

    return {
      durationSeconds: totalDuration,
      durationInTrafficSeconds: totalDurationInTraffic,
      distanceMeters: totalDistance,
      polyline: route.overview_polyline?.points || "",
    };
  } catch (err) {
    console.error("Error calling Directions API:", err);
    return {
      durationSeconds: 600,
      durationInTrafficSeconds: 600,
      distanceMeters: 5000,
      polyline: "",
    };
  }
}

/**
 * Check if a new rider can be added to a time window
 * Enforces max detour constraint (default 120 seconds)
 */
export async function canAddRiderToWindow(input: {
  serviceDate: string;
  timeWindowId: number;
  pickupLat: number;
  pickupLng: number;
  pickupAddress?: string;
}): Promise<CanAddResult> {
  const { serviceDate, timeWindowId, pickupLat, pickupLng } = input;
  const newPickup: LatLng = { lat: pickupLat, lng: pickupLng };

  // 1. Get time window and zone info
  const windowResult = await pool.query(
    `SELECT tw.*, sz.max_detour_seconds, sz.max_riders_per_trip, 
            sz.campus_lat, sz.campus_lng, sz.max_anchor_distance_meters
     FROM time_windows tw
     JOIN service_zones sz ON tw.service_zone_id = sz.id
     WHERE tw.id = $1 AND tw.is_active = true`,
    [timeWindowId]
  );

  if (windowResult.rows.length === 0) {
    return { accepted: false, reason: "WINDOW_NOT_FOUND" };
  }

  const window = windowResult.rows[0];
  const maxDetour = window.max_detour_seconds || 120;
  const maxRiders = Math.min(window.max_riders, window.max_riders_per_trip || 4);
  const campus: LatLng = { lat: window.campus_lat, lng: window.campus_lng };

  // 2. Get current assignments for this window/date
  const assignmentsResult = await pool.query(
    `SELECT wa.*, u.name as rider_name
     FROM window_assignments wa
     LEFT JOIN users u ON wa.user_id = u.id
     WHERE wa.time_window_id = $1 
       AND wa.service_date = $2 
       AND wa.status = 'CONFIRMED'
     ORDER BY wa.id`,
    [timeWindowId, serviceDate]
  );

  const currentAssignments: WindowAssignment[] = assignmentsResult.rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    pickupLat: r.pickup_lat,
    pickupLng: r.pickup_lng,
    pickupAddress: r.pickup_address,
    estimatedPickupTime: r.estimated_pickup_time,
  }));

  // 3. Check capacity
  if (currentAssignments.length >= maxRiders) {
    return { accepted: false, reason: "WINDOW_FULL" };
  }

  // 4. Build departure time from window's start_pickup_time
  const [hours, minutes] = window.start_pickup_time.split(":").map(Number);
  const [year, month, day] = serviceDate.split("-").map(Number);
  const departureTime = new Date(year, month - 1, day, hours, minutes, 0);

  // 5. If first rider, just check basic route to campus
  if (currentAssignments.length === 0) {
    const routeResult = await getTrafficAwareDuration(newPickup, campus, departureTime);

    // Calculate estimated times
    const pickupTime = new Date(departureTime);
    const arrivalTime = new Date(pickupTime.getTime() + routeResult.durationInTrafficSeconds * 1000);

    // Check if we can meet the target time
    const [targetHours, targetMinutes] = window.campus_target_time.split(":").map(Number);
    const targetTime = new Date(year, month - 1, day, targetHours, targetMinutes, 0);

    if (arrivalTime > targetTime) {
      return { accepted: false, reason: "CANNOT_MEET_TARGET_TIME" };
    }

    return {
      accepted: true,
      bestInsertionIndex: 0,
      extraSeconds: 0,
      newTotalDurationSeconds: routeResult.durationInTrafficSeconds,
      estimatedPickupTime: pickupTime.toISOString(),
      estimatedArrivalTime: arrivalTime.toISOString(),
    };
  }

  // 6. For subsequent riders, check anchor distance and detour
  const anchorAssignment = currentAssignments[0];
  const anchorLocation: LatLng = { lat: anchorAssignment.pickupLat, lng: anchorAssignment.pickupLng };

  // Check distance from anchor (if configured)
  if (window.max_anchor_distance_meters) {
    const distFromAnchor = haversineDistance(newPickup, anchorLocation) * 1000; // to meters
    if (distFromAnchor > window.max_anchor_distance_meters) {
      return { accepted: false, reason: "TOO_FAR_FROM_ANCHOR" };
    }
  }

  // 7. Calculate current route duration
  const existingPickups = currentAssignments.map((a) => ({ lat: a.pickupLat, lng: a.pickupLng }));
  const currentRoute = await getRouteWithPolyline(existingPickups[0], campus, existingPickups.slice(1), departureTime);

  // 8. Calculate new route with the additional pickup
  const allPickups = [...existingPickups, newPickup];
  const newRoute = await getRouteWithPolyline(allPickups[0], campus, allPickups.slice(1), departureTime);

  const extraSeconds = newRoute.durationInTrafficSeconds - currentRoute.durationInTrafficSeconds;

  // 9. Check detour limit
  if (extraSeconds > maxDetour) {
    return {
      accepted: false,
      reason: "DETOUR_TOO_LARGE",
      extraSeconds,
    };
  }

  // 10. Check if we can still meet target time
  const arrivalTime = new Date(departureTime.getTime() + newRoute.durationInTrafficSeconds * 1000);
  const [targetHours, targetMinutes] = window.campus_target_time.split(":").map(Number);
  const targetTime = new Date(year, month - 1, day, targetHours, targetMinutes, 0);

  if (arrivalTime > targetTime) {
    return { accepted: false, reason: "CANNOT_MEET_TARGET_TIME" };
  }

  // Calculate estimated pickup time for this rider (simplified - last stop before campus)
  const pickupsBeforeNew = existingPickups.length;
  const avgPickupInterval = newRoute.durationInTrafficSeconds / (allPickups.length + 1);
  const estimatedPickupTime = new Date(departureTime.getTime() + avgPickupInterval * pickupsBeforeNew * 1000);

  return {
    accepted: true,
    bestInsertionIndex: currentAssignments.length,
    extraSeconds,
    newTotalDurationSeconds: newRoute.durationInTrafficSeconds,
    estimatedPickupTime: estimatedPickupTime.toISOString(),
    estimatedArrivalTime: arrivalTime.toISOString(),
  };
}

/**
 * Confirm a rider's assignment to a time window
 */
export async function confirmWindowAssignment(input: {
  userId: number;
  serviceDate: string;
  timeWindowId: number;
  pickupLat: number;
  pickupLng: number;
  pickupAddress?: string;
}): Promise<{ assignment: any; estimatedPickupTime: string; estimatedArrivalTime: string }> {
  const { userId, serviceDate, timeWindowId, pickupLat, pickupLng, pickupAddress } = input;

  // First verify the rider can still be added
  const canAdd = await canAddRiderToWindow({
    serviceDate,
    timeWindowId,
    pickupLat,
    pickupLng,
    pickupAddress,
  });

  if (!canAdd.accepted) {
    throw new Error(canAdd.reason || "Cannot add rider to this window");
  }

  // Create the assignment
  const result = await pool.query(
    `INSERT INTO window_assignments 
     (user_id, time_window_id, service_date, pickup_lat, pickup_lng, pickup_address, 
      status, estimated_pickup_time, estimated_arrival_time)
     VALUES ($1, $2, $3, $4, $5, $6, 'CONFIRMED', $7, $8)
     RETURNING *`,
    [
      userId,
      timeWindowId,
      serviceDate,
      pickupLat,
      pickupLng,
      pickupAddress || null,
      canAdd.estimatedPickupTime,
      canAdd.estimatedArrivalTime,
    ]
  );

  // Update or create route plan
  await updateRoutePlan(timeWindowId, serviceDate);

  return {
    assignment: result.rows[0],
    estimatedPickupTime: canAdd.estimatedPickupTime!,
    estimatedArrivalTime: canAdd.estimatedArrivalTime!,
  };
}

/**
 * Update route plan for a time window after assignment changes
 */
async function updateRoutePlan(timeWindowId: number, serviceDate: string): Promise<void> {
  // Get window info
  const windowResult = await pool.query(
    `SELECT tw.*, sz.campus_lat, sz.campus_lng
     FROM time_windows tw
     JOIN service_zones sz ON tw.service_zone_id = sz.id
     WHERE tw.id = $1`,
    [timeWindowId]
  );

  if (windowResult.rows.length === 0) return;

  const window = windowResult.rows[0];
  const campus: LatLng = { lat: window.campus_lat, lng: window.campus_lng };

  // Get all confirmed assignments
  const assignmentsResult = await pool.query(
    `SELECT id, pickup_lat, pickup_lng
     FROM window_assignments
     WHERE time_window_id = $1 AND service_date = $2 AND status = 'CONFIRMED'
     ORDER BY id`,
    [timeWindowId, serviceDate]
  );

  if (assignmentsResult.rows.length === 0) {
    // Delete existing route plan if no assignments
    await pool.query(
      `DELETE FROM route_plans WHERE time_window_id = $1 AND service_date = $2`,
      [timeWindowId, serviceDate]
    );
    return;
  }

  // Build departure time
  const [hours, minutes] = window.start_pickup_time.split(":").map(Number);
  const [year, month, day] = serviceDate.split("-").map(Number);
  const departureTime = new Date(year, month - 1, day, hours, minutes, 0);

  // Calculate route
  const pickups = assignmentsResult.rows.map((r: any) => ({ lat: r.pickup_lat, lng: r.pickup_lng }));
  const route = await getRouteWithPolyline(pickups[0], campus, pickups.slice(1), departureTime);

  const assignmentIds = assignmentsResult.rows.map((r: any) => r.id);

  // Upsert route plan
  await pool.query(
    `INSERT INTO route_plans 
     (time_window_id, service_date, planned_departure_time, ordered_assignment_ids,
      google_route_polyline, google_base_duration_seconds, google_total_distance_meters)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (time_window_id, service_date) 
     DO UPDATE SET 
       planned_departure_time = EXCLUDED.planned_departure_time,
       ordered_assignment_ids = EXCLUDED.ordered_assignment_ids,
       google_route_polyline = EXCLUDED.google_route_polyline,
       google_base_duration_seconds = EXCLUDED.google_base_duration_seconds,
       google_total_distance_meters = EXCLUDED.google_total_distance_meters,
       updated_at = NOW()`,
    [
      timeWindowId,
      serviceDate,
      departureTime.toISOString(),
      assignmentIds,
      route.polyline,
      route.durationInTrafficSeconds,
      route.distanceMeters,
    ]
  );
}

/**
 * Haversine distance between two lat/lng points in kilometers
 */
function haversineDistance(p1: LatLng, p2: LatLng): number {
  const R = 6371; // Earth's radius in km
  const dLat = toRad(p2.lat - p1.lat);
  const dLng = toRad(p2.lng - p1.lng);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(p1.lat)) * Math.cos(toRad(p2.lat)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRad(deg: number): number {
  return deg * (Math.PI / 180);
}

