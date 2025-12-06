/**
 * Routing Engine - Google Maps Integration
 * 
 * This module provides traffic-aware routing calculations using Google Maps APIs.
 * All detour calculations use departure_time to get accurate traffic conditions
 * for the specific time of day the trip will occur.
 * 
 * Key concepts:
 * - departure_time: Used in all Google API calls to get traffic-aware durations
 * - Detour limit: max_detour_seconds (default 120 = 2 minutes) at that specific hour
 * - Anchor rider: First confirmed rider sets the base route; others must fit within detour limits
 */

import fetch from 'node-fetch';
import { pool } from '../db/pool';

// ============================================================================
// Types
// ============================================================================

export interface LatLng {
  lat: number;
  lng: number;
}

export interface RouteResult {
  durationSeconds: number;
  durationInTrafficSeconds?: number;
  distanceMeters: number;
  polyline?: string;
}

export interface CanAddRiderResult {
  accepted: boolean;
  bestInsertionIndex?: number;
  extraSeconds?: number;
  newTotalDurationSeconds?: number;
  estimatedPickupTime?: string;
  estimatedArrivalTime?: string;
  reason?: string;
  alternativeWindows?: AlternativeWindow[];
}

export interface AlternativeWindow {
  timeWindowId: number;
  label: string;
  availableSeats: number;
  estimatedPickupTime: string;
  estimatedArrivalTime: string;
}

export interface ServiceZone {
  id: number;
  name: string;
  polygon: any;
  centerLat: number;
  centerLng: number;
  isActive: boolean;
  maxDetourSeconds: number;
  maxRidersPerTrip: number;
  maxAnchorDistanceMeters: number | null;
  campusLat: number;
  campusLng: number;
  campusName: string;
}

export interface TimeWindow {
  id: number;
  serviceZoneId: number;
  windowType: 'MORNING' | 'EVENING';
  label: string;
  campusTargetTime: string;
  startPickupTime: string;
  maxRiders: number;
  isActive: boolean;
}

export interface WindowAssignment {
  id: number;
  userId: number;
  timeWindowId: number;
  serviceDate: string;
  pickupLat: number;
  pickupLng: number;
  pickupAddress?: string;
  status: 'CONFIRMED' | 'WAITLISTED' | 'REJECTED' | 'CANCELLED';
  estimatedPickupTime?: string;
  estimatedArrivalTime?: string;
}

export interface RoutePlan {
  id: number;
  serviceDate: string;
  timeWindowId: number;
  plannedDepartureTime: string;
  orderedAssignmentIds: number[];
  googleRoutePolyline?: string;
  googleBaseDurationSeconds?: number;
  googleTotalDistanceMeters?: number;
  anchorAssignmentId?: number;
}

// ============================================================================
// Google Maps API Configuration
// ============================================================================

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || '';

if (!GOOGLE_MAPS_API_KEY) {
  console.warn('[RoutingEngine] GOOGLE_MAPS_API_KEY is not set. Routing features will not work.');
}

// ============================================================================
// Core Google Maps API Functions
// ============================================================================

/**
 * Get directions between two points using Google Directions API.
 * Always uses departure_time for traffic-aware routing.
 * 
 * @param origin Starting point
 * @param destination Ending point
 * @param departureTime When the trip starts (for traffic calculation)
 * @param waypoints Optional intermediate stops
 */
export async function getDirections(
  origin: LatLng,
  destination: LatLng,
  departureTime: Date,
  waypoints?: LatLng[]
): Promise<RouteResult | null> {
  if (!GOOGLE_MAPS_API_KEY) {
    console.error('[RoutingEngine] Cannot get directions: API key not set');
    return null;
  }

  try {
    // Build waypoints string
    let waypointsStr = '';
    if (waypoints && waypoints.length > 0) {
      const wpCoords = waypoints.map(wp => `${wp.lat},${wp.lng}`).join('|');
      waypointsStr = `&waypoints=optimize:false|${wpCoords}`;
    }

    // Convert departure time to Unix timestamp
    const departureTimestamp = Math.floor(departureTime.getTime() / 1000);

    const url = `https://maps.googleapis.com/maps/api/directions/json?` +
      `origin=${origin.lat},${origin.lng}` +
      `&destination=${destination.lat},${destination.lng}` +
      waypointsStr +
      `&departure_time=${departureTimestamp}` +
      `&traffic_model=best_guess` +
      `&key=${GOOGLE_MAPS_API_KEY}`;

    const response = await fetch(url);
    const data = await response.json() as any;

    if (data.status !== 'OK' || !data.routes || data.routes.length === 0) {
      console.error('[RoutingEngine] Directions API error:', data.status, data.error_message);
      return null;
    }

    const route = data.routes[0];
    
    // Sum up all leg durations and distances
    let totalDuration = 0;
    let totalDurationInTraffic = 0;
    let totalDistance = 0;

    for (const leg of route.legs) {
      totalDuration += leg.duration?.value || 0;
      totalDurationInTraffic += leg.duration_in_traffic?.value || leg.duration?.value || 0;
      totalDistance += leg.distance?.value || 0;
    }

    return {
      durationSeconds: totalDuration,
      durationInTrafficSeconds: totalDurationInTraffic,
      distanceMeters: totalDistance,
      polyline: route.overview_polyline?.points,
    };
  } catch (error) {
    console.error('[RoutingEngine] Error calling Directions API:', error);
    return null;
  }
}

/**
 * Get travel time between multiple points using Distance Matrix API.
 * Uses departure_time for traffic-aware durations.
 * 
 * @param origins Array of origin points
 * @param destinations Array of destination points
 * @param departureTime When the trip starts (for traffic calculation)
 */
export async function getDistanceMatrix(
  origins: LatLng[],
  destinations: LatLng[],
  departureTime: Date
): Promise<{ durationSeconds: number; distanceMeters: number }[][] | null> {
  if (!GOOGLE_MAPS_API_KEY) {
    console.error('[RoutingEngine] Cannot get distance matrix: API key not set');
    return null;
  }

  try {
    const originsStr = origins.map(o => `${o.lat},${o.lng}`).join('|');
    const destStr = destinations.map(d => `${d.lat},${d.lng}`).join('|');
    const departureTimestamp = Math.floor(departureTime.getTime() / 1000);

    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?` +
      `origins=${encodeURIComponent(originsStr)}` +
      `&destinations=${encodeURIComponent(destStr)}` +
      `&departure_time=${departureTimestamp}` +
      `&traffic_model=best_guess` +
      `&key=${GOOGLE_MAPS_API_KEY}`;

    const response = await fetch(url);
    const data = await response.json() as any;

    if (data.status !== 'OK') {
      console.error('[RoutingEngine] Distance Matrix API error:', data.status, data.error_message);
      return null;
    }

    const results: { durationSeconds: number; distanceMeters: number }[][] = [];

    for (const row of data.rows) {
      const rowResults: { durationSeconds: number; distanceMeters: number }[] = [];
      for (const element of row.elements) {
        if (element.status !== 'OK') {
          rowResults.push({ durationSeconds: Infinity, distanceMeters: Infinity });
        } else {
          // Prefer duration_in_traffic when available
          const duration = element.duration_in_traffic?.value || element.duration?.value || Infinity;
          rowResults.push({
            durationSeconds: duration,
            distanceMeters: element.distance?.value || Infinity,
          });
        }
      }
      results.push(rowResults);
    }

    return results;
  } catch (error) {
    console.error('[RoutingEngine] Error calling Distance Matrix API:', error);
    return null;
  }
}

/**
 * Geocode an address to get lat/lng coordinates.
 */
export async function geocodeAddress(address: string): Promise<LatLng | null> {
  if (!GOOGLE_MAPS_API_KEY) {
    console.error('[RoutingEngine] Cannot geocode: API key not set');
    return null;
  }

  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?` +
      `address=${encodeURIComponent(address)}` +
      `&key=${GOOGLE_MAPS_API_KEY}`;

    const response = await fetch(url);
    const data = await response.json() as any;

    if (data.status !== 'OK' || !data.results || data.results.length === 0) {
      console.error('[RoutingEngine] Geocoding error:', data.status);
      return null;
    }

    const location = data.results[0].geometry.location;
    return {
      lat: location.lat,
      lng: location.lng,
    };
  } catch (error) {
    console.error('[RoutingEngine] Error geocoding:', error);
    return null;
  }
}

// ============================================================================
// Service Zone Functions
// ============================================================================

/**
 * Check if a point is inside a service zone polygon.
 * Uses ray casting algorithm.
 */
export function isPointInPolygon(point: LatLng, polygon: any): boolean {
  try {
    // Handle GeoJSON format
    let coordinates: number[][];
    if (polygon.type === 'Polygon' && polygon.coordinates) {
      coordinates = polygon.coordinates[0]; // First ring of polygon
    } else if (Array.isArray(polygon)) {
      coordinates = polygon;
    } else {
      return false;
    }

    // Ray casting algorithm
    let inside = false;
    const x = point.lng;
    const y = point.lat;

    for (let i = 0, j = coordinates.length - 1; i < coordinates.length; j = i++) {
      const xi = coordinates[i][0]; // lng
      const yi = coordinates[i][1]; // lat
      const xj = coordinates[j][0];
      const yj = coordinates[j][1];

      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }

    return inside;
  } catch (error) {
    console.error('[RoutingEngine] Error checking point in polygon:', error);
    return false;
  }
}

/**
 * Find all active service zones that contain a given point.
 */
export async function findServiceZonesForPoint(point: LatLng): Promise<ServiceZone[]> {
  const result = await pool.query(`
    SELECT 
      id,
      name,
      polygon,
      center_lat as "centerLat",
      center_lng as "centerLng",
      is_active as "isActive",
      max_detour_seconds as "maxDetourSeconds",
      max_riders_per_trip as "maxRidersPerTrip",
      max_anchor_distance_meters as "maxAnchorDistanceMeters",
      campus_lat as "campusLat",
      campus_lng as "campusLng",
      campus_name as "campusName"
    FROM service_zones
    WHERE is_active = TRUE
  `);

  const zones: ServiceZone[] = [];
  for (const row of result.rows) {
    if (isPointInPolygon(point, row.polygon)) {
      zones.push(row);
    }
  }

  return zones;
}

/**
 * Get all active time windows for a service zone.
 */
export async function getTimeWindowsForZone(
  serviceZoneId: number,
  windowType?: 'MORNING' | 'EVENING'
): Promise<TimeWindow[]> {
  let query = `
    SELECT 
      id,
      service_zone_id as "serviceZoneId",
      window_type as "windowType",
      label,
      campus_target_time as "campusTargetTime",
      start_pickup_time as "startPickupTime",
      max_riders as "maxRiders",
      is_active as "isActive"
    FROM time_windows
    WHERE service_zone_id = $1 AND is_active = TRUE
  `;
  
  const params: any[] = [serviceZoneId];
  
  if (windowType) {
    query += ` AND window_type = $2`;
    params.push(windowType);
  }
  
  query += ` ORDER BY campus_target_time ASC`;

  const result = await pool.query(query, params);
  return result.rows;
}

/**
 * Get confirmed rider count for a time window on a specific date.
 */
export async function getConfirmedRiderCount(
  timeWindowId: number,
  serviceDate: string
): Promise<number> {
  const result = await pool.query(`
    SELECT COUNT(*) as count
    FROM window_assignments
    WHERE time_window_id = $1 
      AND service_date = $2 
      AND status = 'CONFIRMED'
  `, [timeWindowId, serviceDate]);

  return parseInt(result.rows[0].count, 10);
}

// ============================================================================
// Route Plan Management
// ============================================================================

/**
 * Get or create a route plan for a specific date and time window.
 * Calculates the planned departure time based on window configuration.
 */
export async function getOrCreateRoutePlan(
  serviceDate: string,
  timeWindowId: number
): Promise<RoutePlan> {
  // Check if route plan exists
  const existing = await pool.query(`
    SELECT 
      id,
      service_date as "serviceDate",
      time_window_id as "timeWindowId",
      planned_departure_time as "plannedDepartureTime",
      ordered_assignment_ids as "orderedAssignmentIds",
      google_route_polyline as "googleRoutePolyline",
      google_base_duration_seconds as "googleBaseDurationSeconds",
      google_total_distance_meters as "googleTotalDistanceMeters",
      anchor_assignment_id as "anchorAssignmentId"
    FROM route_plans
    WHERE service_date = $1 AND time_window_id = $2
  `, [serviceDate, timeWindowId]);

  if (existing.rows.length > 0) {
    return existing.rows[0];
  }

  // Get time window details
  const windowResult = await pool.query(`
    SELECT start_pickup_time as "startPickupTime"
    FROM time_windows
    WHERE id = $1
  `, [timeWindowId]);

  if (windowResult.rows.length === 0) {
    throw new Error(`Time window ${timeWindowId} not found`);
  }

  // Calculate planned departure time by combining service date and start pickup time
  const startPickupTime = windowResult.rows[0].startPickupTime;
  const plannedDepartureTime = `${serviceDate}T${startPickupTime}`;

  // Create new route plan
  const insertResult = await pool.query(`
    INSERT INTO route_plans (service_date, time_window_id, planned_departure_time, ordered_assignment_ids)
    VALUES ($1, $2, $3, $4)
    RETURNING 
      id,
      service_date as "serviceDate",
      time_window_id as "timeWindowId",
      planned_departure_time as "plannedDepartureTime",
      ordered_assignment_ids as "orderedAssignmentIds",
      google_route_polyline as "googleRoutePolyline",
      google_base_duration_seconds as "googleBaseDurationSeconds",
      google_total_distance_meters as "googleTotalDistanceMeters",
      anchor_assignment_id as "anchorAssignmentId"
  `, [serviceDate, timeWindowId, plannedDepartureTime, []]);

  return insertResult.rows[0];
}

/**
 * Update route plan with new assignment and recalculated route.
 */
export async function updateRoutePlan(
  routePlanId: number,
  orderedAssignmentIds: number[],
  routeData: RouteResult,
  anchorAssignmentId?: number
): Promise<void> {
  await pool.query(`
    UPDATE route_plans
    SET 
      ordered_assignment_ids = $1,
      google_route_polyline = $2,
      google_base_duration_seconds = $3,
      google_total_distance_meters = $4,
      anchor_assignment_id = COALESCE($5, anchor_assignment_id),
      updated_at = NOW()
    WHERE id = $6
  `, [
    orderedAssignmentIds,
    routeData.polyline,
    routeData.durationInTrafficSeconds || routeData.durationSeconds,
    routeData.distanceMeters,
    anchorAssignmentId,
    routePlanId,
  ]);
}

// ============================================================================
// Detour Calculation - Core Algorithm
// ============================================================================

/**
 * Calculate the extra time added by inserting a new stop between two points.
 * Uses traffic-aware durations from Google at the specified departure time.
 * 
 * @param fromPoint Current stop
 * @param newStop New pickup point to insert
 * @param toPoint Next stop
 * @param directDuration Current direct duration from fromPoint to toPoint
 * @param departureTime When the trip departs (for traffic calculation)
 */
export async function calculateDetour(
  fromPoint: LatLng,
  newStop: LatLng,
  toPoint: LatLng,
  directDuration: number,
  departureTime: Date
): Promise<{ extraSeconds: number; totalWithStop: number } | null> {
  // Get distance matrix for: fromPoint -> newStop, newStop -> toPoint
  const matrix = await getDistanceMatrix(
    [fromPoint, newStop],
    [newStop, toPoint],
    departureTime
  );

  if (!matrix) {
    return null;
  }

  // fromPoint -> newStop is matrix[0][0]
  // newStop -> toPoint is matrix[1][1]
  const toNewStop = matrix[0][0].durationSeconds;
  const fromNewStop = matrix[1][1].durationSeconds;
  const totalWithStop = toNewStop + fromNewStop;
  const extraSeconds = totalWithStop - directDuration;

  return {
    extraSeconds,
    totalWithStop,
  };
}

/**
 * Find the best insertion point for a new rider in an existing route.
 * Returns the insertion index and extra time, or null if no valid insertion exists.
 * 
 * @param routePlan Current route plan
 * @param newPickup New rider's pickup location
 * @param campus Campus/destination location
 * @param maxDetourSeconds Maximum allowed detour (default 120 = 2 minutes)
 * @param departureTime When the trip departs
 */
export async function findBestInsertion(
  routePlan: RoutePlan,
  newPickup: LatLng,
  campus: LatLng,
  maxDetourSeconds: number,
  departureTime: Date
): Promise<{ insertionIndex: number; extraSeconds: number; newTotalSeconds: number } | null> {
  const assignmentIds = routePlan.orderedAssignmentIds;
  
  // If no existing assignments, this is the first rider (anchor)
  if (assignmentIds.length === 0) {
    // Calculate direct route from pickup to campus
    const directRoute = await getDirections(newPickup, campus, departureTime);
    if (!directRoute) {
      return null;
    }
    
    return {
      insertionIndex: 0,
      extraSeconds: 0,
      newTotalSeconds: directRoute.durationInTrafficSeconds || directRoute.durationSeconds,
    };
  }

  // Load existing assignments to get their pickup locations
  const assignmentsResult = await pool.query(`
    SELECT id, pickup_lat as "pickupLat", pickup_lng as "pickupLng"
    FROM window_assignments
    WHERE id = ANY($1)
    ORDER BY array_position($1, id)
  `, [assignmentIds]);

  const stops: LatLng[] = assignmentsResult.rows.map(row => ({
    lat: row.pickupLat,
    lng: row.pickupLng,
  }));
  stops.push(campus); // Add campus as final destination

  let bestInsertion: { insertionIndex: number; extraSeconds: number; newTotalSeconds: number } | null = null;

  // Try inserting at each position
  for (let i = 0; i <= stops.length - 1; i++) {
    const fromPoint = i === 0 ? stops[0] : stops[i - 1];
    const toPoint = stops[i];

    // We need the current direct duration between fromPoint and toPoint
    // For simplicity, fetch it via distance matrix
    const directMatrix = await getDistanceMatrix([fromPoint], [toPoint], departureTime);
    if (!directMatrix) continue;
    
    const directDuration = directMatrix[0][0].durationSeconds;

    // Calculate detour for inserting newPickup between fromPoint and toPoint
    const detour = await calculateDetour(fromPoint, newPickup, toPoint, directDuration, departureTime);
    if (!detour) continue;

    // Check if this detour is within limits
    if (detour.extraSeconds <= maxDetourSeconds) {
      const newTotal = (routePlan.googleBaseDurationSeconds || 0) + detour.extraSeconds;
      
      if (!bestInsertion || detour.extraSeconds < bestInsertion.extraSeconds) {
        bestInsertion = {
          insertionIndex: i,
          extraSeconds: detour.extraSeconds,
          newTotalSeconds: newTotal,
        };
      }
    }
  }

  return bestInsertion;
}

// ============================================================================
// Main Entry Point: Can Add Rider to Window?
// ============================================================================

/**
 * Check if a new rider can be added to a time window.
 * Uses traffic-aware durations for the planned departure time.
 * 
 * This is the main function called by the API endpoint.
 * 
 * @param serviceDate Date of the ride (YYYY-MM-DD)
 * @param timeWindowId Target time window
 * @param pickupLat Rider's pickup latitude
 * @param pickupLng Rider's pickup longitude
 * @param pickupAddress Optional address for the pickup
 */
export async function canAddRiderToWindow(input: {
  serviceDate: string;
  timeWindowId: number;
  pickupLat: number;
  pickupLng: number;
  pickupAddress?: string;
}): Promise<CanAddRiderResult> {
  const { serviceDate, timeWindowId, pickupLat, pickupLng, pickupAddress } = input;
  const newPickup: LatLng = { lat: pickupLat, lng: pickupLng };

  try {
    // 1. Get time window and service zone details
    const windowResult = await pool.query(`
      SELECT 
        tw.id,
        tw.service_zone_id as "serviceZoneId",
        tw.window_type as "windowType",
        tw.label,
        tw.campus_target_time as "campusTargetTime",
        tw.start_pickup_time as "startPickupTime",
        tw.max_riders as "maxRiders",
        sz.max_detour_seconds as "maxDetourSeconds",
        sz.max_riders_per_trip as "maxRidersPerTrip",
        sz.max_anchor_distance_meters as "maxAnchorDistanceMeters",
        sz.campus_lat as "campusLat",
        sz.campus_lng as "campusLng"
      FROM time_windows tw
      JOIN service_zones sz ON tw.service_zone_id = sz.id
      WHERE tw.id = $1 AND tw.is_active = TRUE
    `, [timeWindowId]);

    if (windowResult.rows.length === 0) {
      return {
        accepted: false,
        reason: 'TIME_WINDOW_NOT_FOUND',
      };
    }

    const window = windowResult.rows[0];
    const campus: LatLng = { lat: window.campusLat, lng: window.campusLng };

    // 2. Check capacity
    const confirmedCount = await getConfirmedRiderCount(timeWindowId, serviceDate);
    if (confirmedCount >= window.maxRiders) {
      // Try to find alternative windows
      const alternatives = await findAlternativeWindows(
        window.serviceZoneId,
        window.windowType,
        serviceDate,
        newPickup,
        campus
      );
      
      return {
        accepted: false,
        reason: 'WINDOW_FULL',
        alternativeWindows: alternatives,
      };
    }

    // 3. Get or create route plan
    const routePlan = await getOrCreateRoutePlan(serviceDate, timeWindowId);
    const departureTime = new Date(routePlan.plannedDepartureTime);

    // 4. Check per-trip rider limit
    if (routePlan.orderedAssignmentIds.length >= window.maxRidersPerTrip) {
      return {
        accepted: false,
        reason: 'TRIP_FULL',
      };
    }

    // 5. Check anchor distance if this is not the anchor
    if (routePlan.anchorAssignmentId && window.maxAnchorDistanceMeters) {
      const anchorResult = await pool.query(`
        SELECT pickup_lat, pickup_lng
        FROM window_assignments
        WHERE id = $1
      `, [routePlan.anchorAssignmentId]);

      if (anchorResult.rows.length > 0) {
        const anchor = anchorResult.rows[0];
        const distance = haversineDistance(
          newPickup,
          { lat: anchor.pickup_lat, lng: anchor.pickup_lng }
        );

        if (distance > window.maxAnchorDistanceMeters) {
          return {
            accepted: false,
            reason: 'TOO_FAR_FROM_ANCHOR',
          };
        }
      }
    }

    // 6. Find best insertion point
    const insertion = await findBestInsertion(
      routePlan,
      newPickup,
      campus,
      window.maxDetourSeconds,
      departureTime
    );

    if (!insertion) {
      // Try to find alternative windows
      const alternatives = await findAlternativeWindows(
        window.serviceZoneId,
        window.windowType,
        serviceDate,
        newPickup,
        campus
      );

      return {
        accepted: false,
        reason: 'DETOUR_TOO_LARGE',
        alternativeWindows: alternatives,
      };
    }

    // 7. Verify we can still make the campus target time
    const campusTargetTime = new Date(`${serviceDate}T${window.campusTargetTime}`);
    const estimatedArrivalTime = new Date(departureTime.getTime() + insertion.newTotalSeconds * 1000);

    // Allow 2 minutes buffer before target time
    const bufferMs = 2 * 60 * 1000;
    if (estimatedArrivalTime.getTime() > campusTargetTime.getTime() + bufferMs) {
      return {
        accepted: false,
        reason: 'CANNOT_MEET_TARGET_TIME',
      };
    }

    // 8. Calculate estimated pickup time for this rider
    // This is approximate - in a production system, you'd calculate the exact time
    // based on the insertion position
    const minutesToPickup = Math.floor(insertion.insertionIndex * 5); // ~5 min between stops
    const estimatedPickupTime = new Date(departureTime.getTime() + minutesToPickup * 60 * 1000);

    return {
      accepted: true,
      bestInsertionIndex: insertion.insertionIndex,
      extraSeconds: insertion.extraSeconds,
      newTotalDurationSeconds: insertion.newTotalSeconds,
      estimatedPickupTime: estimatedPickupTime.toISOString(),
      estimatedArrivalTime: estimatedArrivalTime.toISOString(),
    };

  } catch (error) {
    console.error('[RoutingEngine] Error in canAddRiderToWindow:', error);
    return {
      accepted: false,
      reason: 'INTERNAL_ERROR',
    };
  }
}

/**
 * Find alternative time windows when the requested one is not available.
 */
async function findAlternativeWindows(
  serviceZoneId: number,
  windowType: 'MORNING' | 'EVENING',
  serviceDate: string,
  pickup: LatLng,
  campus: LatLng
): Promise<AlternativeWindow[]> {
  const windows = await getTimeWindowsForZone(serviceZoneId, windowType);
  const alternatives: AlternativeWindow[] = [];

  for (const window of windows) {
    const confirmedCount = await getConfirmedRiderCount(window.id, serviceDate);
    const availableSeats = window.maxRiders - confirmedCount;

    if (availableSeats > 0) {
      const routePlan = await getOrCreateRoutePlan(serviceDate, window.id);
      const departureTime = new Date(routePlan.plannedDepartureTime);
      
      // Estimate pickup and arrival times
      const directRoute = await getDirections(pickup, campus, departureTime);
      if (directRoute) {
        const arrivalTime = new Date(
          departureTime.getTime() + 
          (directRoute.durationInTrafficSeconds || directRoute.durationSeconds) * 1000
        );

        alternatives.push({
          timeWindowId: window.id,
          label: window.label,
          availableSeats,
          estimatedPickupTime: departureTime.toISOString(),
          estimatedArrivalTime: arrivalTime.toISOString(),
        });
      }
    }
  }

  return alternatives.slice(0, 3); // Return top 3 alternatives
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Calculate haversine distance between two points in meters.
 */
export function haversineDistance(p1: LatLng, p2: LatLng): number {
  const R = 6371000; // Earth radius in meters
  const toRad = (deg: number) => deg * Math.PI / 180;

  const dLat = toRad(p2.lat - p1.lat);
  const dLng = toRad(p2.lng - p1.lng);

  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(p1.lat)) * Math.cos(toRad(p2.lat)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Log a route snapshot for future ML/analytics.
 */
export async function logRouteSnapshot(
  origin: LatLng,
  destination: LatLng,
  result: RouteResult,
  timeWindowId?: number,
  serviceDate?: string,
  departureTime?: Date
): Promise<void> {
  try {
    await pool.query(`
      INSERT INTO route_snapshots (
        origin_lat, origin_lng,
        destination_lat, destination_lng,
        distance_meters, duration_seconds, duration_in_traffic_seconds,
        time_window_id, service_date, departure_time
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `, [
      origin.lat,
      origin.lng,
      destination.lat,
      destination.lng,
      result.distanceMeters,
      result.durationSeconds,
      result.durationInTrafficSeconds,
      timeWindowId,
      serviceDate,
      departureTime?.toISOString(),
    ]);
  } catch (error) {
    console.error('[RoutingEngine] Error logging route snapshot:', error);
    // Don't throw - this is just for analytics
  }
}

// ============================================================================
// Assignment Management
// ============================================================================

/**
 * Create a new window assignment and update the route plan.
 */
export async function createWindowAssignment(input: {
  userId: number;
  timeWindowId: number;
  serviceDate: string;
  pickupLat: number;
  pickupLng: number;
  pickupAddress?: string;
  insertionIndex: number;
}): Promise<WindowAssignment> {
  const { userId, timeWindowId, serviceDate, pickupLat, pickupLng, pickupAddress, insertionIndex } = input;

  // Create the assignment
  const result = await pool.query(`
    INSERT INTO window_assignments (
      user_id, time_window_id, service_date,
      pickup_lat, pickup_lng, pickup_address,
      status
    )
    VALUES ($1, $2, $3, $4, $5, $6, 'CONFIRMED')
    RETURNING 
      id,
      user_id as "userId",
      time_window_id as "timeWindowId",
      service_date as "serviceDate",
      pickup_lat as "pickupLat",
      pickup_lng as "pickupLng",
      pickup_address as "pickupAddress",
      status,
      estimated_pickup_time as "estimatedPickupTime",
      estimated_arrival_time as "estimatedArrivalTime"
  `, [userId, timeWindowId, serviceDate, pickupLat, pickupLng, pickupAddress]);

  const assignment = result.rows[0];

  // Update route plan
  const routePlan = await getOrCreateRoutePlan(serviceDate, timeWindowId);
  const newOrderedIds = [...routePlan.orderedAssignmentIds];
  newOrderedIds.splice(insertionIndex, 0, assignment.id);

  // Get service zone and campus for route calculation
  const zoneResult = await pool.query(`
    SELECT 
      sz.campus_lat, sz.campus_lng
    FROM time_windows tw
    JOIN service_zones sz ON tw.service_zone_id = sz.id
    WHERE tw.id = $1
  `, [timeWindowId]);

  const campus: LatLng = {
    lat: zoneResult.rows[0].campus_lat,
    lng: zoneResult.rows[0].campus_lng,
  };

  // Load all pickups in order
  const assignmentsResult = await pool.query(`
    SELECT pickup_lat, pickup_lng
    FROM window_assignments
    WHERE id = ANY($1)
    ORDER BY array_position($1, id)
  `, [newOrderedIds]);

  const waypoints: LatLng[] = assignmentsResult.rows.map(row => ({
    lat: row.pickup_lat,
    lng: row.pickup_lng,
  }));

  // Recalculate route
  const departureTime = new Date(routePlan.plannedDepartureTime);
  const firstPickup = waypoints[0];
  const middleWaypoints = waypoints.slice(1);

  const newRoute = await getDirections(firstPickup, campus, departureTime, middleWaypoints);
  
  if (newRoute) {
    // Set anchor if this is the first assignment
    const anchorId = routePlan.anchorAssignmentId || (newOrderedIds.length === 1 ? assignment.id : undefined);
    
    await updateRoutePlan(routePlan.id, newOrderedIds, newRoute, anchorId);
    
    // Log snapshot
    await logRouteSnapshot(firstPickup, campus, newRoute, timeWindowId, serviceDate, departureTime);
  } else {
    // Just update the ordered IDs even if route calculation failed
    await pool.query(`
      UPDATE route_plans
      SET ordered_assignment_ids = $1, updated_at = NOW()
      WHERE id = $2
    `, [newOrderedIds, routePlan.id]);
  }

  return assignment;
}

/**
 * Cancel a window assignment and update the route plan.
 */
export async function cancelWindowAssignment(assignmentId: number): Promise<void> {
  // Get assignment details
  const result = await pool.query(`
    SELECT time_window_id, service_date
    FROM window_assignments
    WHERE id = $1
  `, [assignmentId]);

  if (result.rows.length === 0) {
    throw new Error('Assignment not found');
  }

  const { time_window_id: timeWindowId, service_date: serviceDate } = result.rows[0];

  // Update assignment status
  await pool.query(`
    UPDATE window_assignments
    SET status = 'CANCELLED', updated_at = NOW()
    WHERE id = $1
  `, [assignmentId]);

  // Update route plan
  const routePlan = await getOrCreateRoutePlan(serviceDate, timeWindowId);
  const newOrderedIds = routePlan.orderedAssignmentIds.filter(id => id !== assignmentId);

  // If this was the anchor, promote the next assignment
  let newAnchorId = routePlan.anchorAssignmentId;
  if (routePlan.anchorAssignmentId === assignmentId) {
    newAnchorId = newOrderedIds.length > 0 ? newOrderedIds[0] : undefined;
  }

  // Recalculate route if there are still assignments
  if (newOrderedIds.length > 0) {
    const zoneResult = await pool.query(`
      SELECT sz.campus_lat, sz.campus_lng
      FROM time_windows tw
      JOIN service_zones sz ON tw.service_zone_id = sz.id
      WHERE tw.id = $1
    `, [timeWindowId]);

    const campus: LatLng = {
      lat: zoneResult.rows[0].campus_lat,
      lng: zoneResult.rows[0].campus_lng,
    };

    const assignmentsResult = await pool.query(`
      SELECT pickup_lat, pickup_lng
      FROM window_assignments
      WHERE id = ANY($1)
      ORDER BY array_position($1, id)
    `, [newOrderedIds]);

    const waypoints: LatLng[] = assignmentsResult.rows.map(row => ({
      lat: row.pickup_lat,
      lng: row.pickup_lng,
    }));

    const departureTime = new Date(routePlan.plannedDepartureTime);
    const firstPickup = waypoints[0];
    const middleWaypoints = waypoints.slice(1);

    const newRoute = await getDirections(firstPickup, campus, departureTime, middleWaypoints);
    
    if (newRoute) {
      await updateRoutePlan(routePlan.id, newOrderedIds, newRoute, newAnchorId);
    }
  } else {
    // Clear the route plan
    await pool.query(`
      UPDATE route_plans
      SET 
        ordered_assignment_ids = $1,
        google_route_polyline = NULL,
        google_base_duration_seconds = NULL,
        anchor_assignment_id = NULL,
        updated_at = NOW()
      WHERE id = $2
    `, [[], routePlan.id]);
  }
}

