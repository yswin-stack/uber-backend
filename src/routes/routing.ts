/**
 * Routing API Endpoints
 * 
 * Provides endpoints for:
 * - Checking if a rider can be added to a time window
 * - Getting available time windows for a location
 * - Managing service zones
 * - Handling unserved requests
 */

import { Router, Request, Response } from 'express';
import { pool } from '../db/pool';
import { ok, fail } from '../lib/apiResponse';
import {
  canAddRiderToWindow,
  createWindowAssignment,
  cancelWindowAssignment,
  findServiceZonesForPoint,
  getTimeWindowsForZone,
  getConfirmedRiderCount,
  getOrCreateRoutePlan,
  geocodeAddress,
  isPointInPolygon,
} from '../lib/routingEngine';

const routingRouter = Router();

// ============================================================================
// Helper Functions
// ============================================================================

function getUserIdFromHeader(req: Request): number | null {
  const h = req.header('x-user-id');
  if (!h) return null;
  const id = parseInt(h, 10);
  if (Number.isNaN(id)) return null;
  return id;
}

// ============================================================================
// Check if Rider Can Be Added to Window
// ============================================================================

/**
 * POST /routing/can-add-to-window
 * 
 * Check if a rider can be added to a specific time window.
 * Uses traffic-aware routing to verify detour constraints.
 * 
 * Body:
 * {
 *   serviceDate: "YYYY-MM-DD",
 *   timeWindowId: number,
 *   pickupLat: number,
 *   pickupLng: number,
 *   pickupAddress?: string
 * }
 */
routingRouter.post('/can-add-to-window', async (req: Request, res: Response) => {
  try {
    const userId = getUserIdFromHeader(req);
    if (!userId) {
      return res.status(401).json(fail('UNAUTHORIZED', 'Missing or invalid x-user-id header.'));
    }

    const { serviceDate, timeWindowId, pickupLat, pickupLng, pickupAddress } = req.body;

    // Validate required fields
    if (!serviceDate || !timeWindowId || pickupLat === undefined || pickupLng === undefined) {
      return res.status(400).json(fail(
        'MISSING_FIELDS',
        'serviceDate, timeWindowId, pickupLat, and pickupLng are required.'
      ));
    }

    // Validate date format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate)) {
      return res.status(400).json(fail('INVALID_DATE', 'serviceDate must be in YYYY-MM-DD format.'));
    }

    // Call the routing engine
    const result = await canAddRiderToWindow({
      serviceDate,
      timeWindowId: Number(timeWindowId),
      pickupLat: Number(pickupLat),
      pickupLng: Number(pickupLng),
      pickupAddress,
    });

    return res.json(ok(result));

  } catch (error) {
    console.error('Error in POST /routing/can-add-to-window:', error);
    return res.status(500).json(fail('INTERNAL_ERROR', 'Failed to check window availability.'));
  }
});

// ============================================================================
// Confirm Window Assignment
// ============================================================================

/**
 * POST /routing/confirm-window
 * 
 * Confirm a rider's assignment to a time window.
 * Creates the assignment and updates the route plan.
 * 
 * Body:
 * {
 *   serviceDate: "YYYY-MM-DD",
 *   timeWindowId: number,
 *   pickupLat: number,
 *   pickupLng: number,
 *   pickupAddress?: string
 * }
 */
routingRouter.post('/confirm-window', async (req: Request, res: Response) => {
  try {
    const userId = getUserIdFromHeader(req);
    if (!userId) {
      return res.status(401).json(fail('UNAUTHORIZED', 'Missing or invalid x-user-id header.'));
    }

    const { serviceDate, timeWindowId, pickupLat, pickupLng, pickupAddress } = req.body;

    // Validate required fields
    if (!serviceDate || !timeWindowId || pickupLat === undefined || pickupLng === undefined) {
      return res.status(400).json(fail(
        'MISSING_FIELDS',
        'serviceDate, timeWindowId, pickupLat, and pickupLng are required.'
      ));
    }

    // First check if the rider can be added
    const checkResult = await canAddRiderToWindow({
      serviceDate,
      timeWindowId: Number(timeWindowId),
      pickupLat: Number(pickupLat),
      pickupLng: Number(pickupLng),
      pickupAddress,
    });

    if (!checkResult.accepted) {
      return res.status(400).json(fail(
        checkResult.reason || 'CANNOT_ADD_RIDER',
        `Cannot add rider to this window: ${checkResult.reason}`,
      ));
    }

    // Create the assignment
    const assignment = await createWindowAssignment({
      userId,
      timeWindowId: Number(timeWindowId),
      serviceDate,
      pickupLat: Number(pickupLat),
      pickupLng: Number(pickupLng),
      pickupAddress,
      insertionIndex: checkResult.bestInsertionIndex || 0,
    });

    return res.json(ok({
      assignment,
      estimatedPickupTime: checkResult.estimatedPickupTime,
      estimatedArrivalTime: checkResult.estimatedArrivalTime,
    }));

  } catch (error: any) {
    console.error('Error in POST /routing/confirm-window:', error);
    
    // Check for unique constraint violation (already assigned)
    if (error.code === '23505') {
      return res.status(400).json(fail(
        'ALREADY_ASSIGNED',
        'You are already assigned to this time window for this date.'
      ));
    }
    
    return res.status(500).json(fail('INTERNAL_ERROR', 'Failed to confirm window assignment.'));
  }
});

// ============================================================================
// Cancel Window Assignment
// ============================================================================

/**
 * POST /routing/cancel-assignment/:assignmentId
 * 
 * Cancel a window assignment.
 */
routingRouter.post('/cancel-assignment/:assignmentId', async (req: Request, res: Response) => {
  try {
    const userId = getUserIdFromHeader(req);
    if (!userId) {
      return res.status(401).json(fail('UNAUTHORIZED', 'Missing or invalid x-user-id header.'));
    }

    const assignmentId = parseInt(req.params.assignmentId, 10);
    if (Number.isNaN(assignmentId)) {
      return res.status(400).json(fail('INVALID_ASSIGNMENT_ID', 'Invalid assignment ID.'));
    }

    // Verify the assignment belongs to this user
    const check = await pool.query(`
      SELECT user_id FROM window_assignments WHERE id = $1
    `, [assignmentId]);

    if (check.rows.length === 0) {
      return res.status(404).json(fail('NOT_FOUND', 'Assignment not found.'));
    }

    if (check.rows[0].user_id !== userId) {
      return res.status(403).json(fail('FORBIDDEN', 'You can only cancel your own assignments.'));
    }

    await cancelWindowAssignment(assignmentId);

    return res.json(ok({ cancelled: true }));

  } catch (error) {
    console.error('Error in POST /routing/cancel-assignment:', error);
    return res.status(500).json(fail('INTERNAL_ERROR', 'Failed to cancel assignment.'));
  }
});

// ============================================================================
// Get Available Windows for Location
// ============================================================================

/**
 * GET /routing/available-windows
 * 
 * Get available time windows for a given pickup location.
 * 
 * Query params:
 * - lat: Pickup latitude
 * - lng: Pickup longitude
 * - date: Service date (YYYY-MM-DD)
 * - type?: "MORNING" | "EVENING" (optional filter)
 */
routingRouter.get('/available-windows', async (req: Request, res: Response) => {
  try {
    const { lat, lng, date, type } = req.query;

    if (!lat || !lng || !date) {
      return res.status(400).json(fail('MISSING_FIELDS', 'lat, lng, and date are required.'));
    }

    const pickupLat = parseFloat(lat as string);
    const pickupLng = parseFloat(lng as string);
    const serviceDate = date as string;
    const windowType = type as 'MORNING' | 'EVENING' | undefined;

    if (Number.isNaN(pickupLat) || Number.isNaN(pickupLng)) {
      return res.status(400).json(fail('INVALID_COORDINATES', 'Invalid lat/lng values.'));
    }

    // Find service zones for this location
    const zones = await findServiceZonesForPoint({ lat: pickupLat, lng: pickupLng });

    if (zones.length === 0) {
      return res.json(ok({
        inServiceArea: false,
        message: "We don't serve this area yet.",
        windows: [],
      }));
    }

    // Get time windows for all matching zones
    const allWindows: any[] = [];

    for (const zone of zones) {
      const windows = await getTimeWindowsForZone(zone.id, windowType);
      
      for (const window of windows) {
        const confirmedCount = await getConfirmedRiderCount(window.id, serviceDate);
        const availableSeats = window.maxRiders - confirmedCount;

        // Get route plan for timing info
        const routePlan = await getOrCreateRoutePlan(serviceDate, window.id);

        allWindows.push({
          id: window.id,
          zoneId: zone.id,
          zoneName: zone.name,
          type: window.windowType,
          label: window.label,
          campusTargetTime: window.campusTargetTime,
          startPickupTime: window.startPickupTime,
          maxRiders: window.maxRiders,
          confirmedCount,
          availableSeats,
          isFull: availableSeats <= 0,
          plannedDepartureTime: routePlan.plannedDepartureTime,
          currentRiderCount: routePlan.orderedAssignmentIds.length,
        });
      }
    }

    // Sort by target time
    allWindows.sort((a, b) => a.campusTargetTime.localeCompare(b.campusTargetTime));

    return res.json(ok({
      inServiceArea: true,
      zones: zones.map(z => ({ id: z.id, name: z.name })),
      windows: allWindows,
    }));

  } catch (error) {
    console.error('Error in GET /routing/available-windows:', error);
    return res.status(500).json(fail('INTERNAL_ERROR', 'Failed to get available windows.'));
  }
});

// ============================================================================
// Check Service Area
// ============================================================================

/**
 * POST /routing/check-service-area
 * 
 * Check if an address or coordinates are in a service area.
 * 
 * Body:
 * {
 *   address?: string,
 *   lat?: number,
 *   lng?: number,
 *   desiredTimeType?: "MORNING" | "EVENING"
 * }
 */
routingRouter.post('/check-service-area', async (req: Request, res: Response) => {
  try {
    const userId = getUserIdFromHeader(req);
    const { address, lat, lng, desiredTimeType } = req.body;

    let pickupLat = lat ? parseFloat(lat) : null;
    let pickupLng = lng ? parseFloat(lng) : null;

    // If address provided without coordinates, geocode it
    if (address && (pickupLat === null || pickupLng === null)) {
      const geocoded = await geocodeAddress(address);
      if (geocoded) {
        pickupLat = geocoded.lat;
        pickupLng = geocoded.lng;
      } else {
        return res.status(400).json(fail('GEOCODING_FAILED', 'Could not geocode the address.'));
      }
    }

    if (pickupLat === null || pickupLng === null) {
      return res.status(400).json(fail('MISSING_LOCATION', 'Either address or lat/lng is required.'));
    }

    // Find service zones for this location
    const zones = await findServiceZonesForPoint({ lat: pickupLat, lng: pickupLng });

    if (zones.length === 0) {
      // Log unserved request if user is logged in
      if (userId && address) {
        try {
          await pool.query(`
            INSERT INTO unserved_requests (
              user_id, entered_address, lat, lng,
              desired_time_type, reason, waitlist_opt_in
            )
            VALUES ($1, $2, $3, $4, $5, 'OUT_OF_ZONE', false)
          `, [userId, address, pickupLat, pickupLng, desiredTimeType || 'MORNING']);
        } catch (err) {
          console.error('Error logging unserved request:', err);
        }
      }

      return res.json(ok({
        inServiceArea: false,
        message: "We don't serve this area yet. Join the waitlist to be notified when we expand.",
        lat: pickupLat,
        lng: pickupLng,
      }));
    }

    return res.json(ok({
      inServiceArea: true,
      lat: pickupLat,
      lng: pickupLng,
      zones: zones.map(z => ({
        id: z.id,
        name: z.name,
        campusName: z.campusName,
      })),
    }));

  } catch (error) {
    console.error('Error in POST /routing/check-service-area:', error);
    return res.status(500).json(fail('INTERNAL_ERROR', 'Failed to check service area.'));
  }
});

// ============================================================================
// Join Waitlist (Unserved Request)
// ============================================================================

/**
 * POST /routing/join-waitlist
 * 
 * Add an unserved request to the waitlist.
 * 
 * Body:
 * {
 *   address: string,
 *   lat: number,
 *   lng: number,
 *   desiredTimeType: "MORNING" | "EVENING",
 *   desiredTime?: string (HH:MM)
 * }
 */
routingRouter.post('/join-waitlist', async (req: Request, res: Response) => {
  try {
    const userId = getUserIdFromHeader(req);
    const { address, lat, lng, desiredTimeType, desiredTime } = req.body;

    if (!address || lat === undefined || lng === undefined || !desiredTimeType) {
      return res.status(400).json(fail(
        'MISSING_FIELDS',
        'address, lat, lng, and desiredTimeType are required.'
      ));
    }

    // Determine the reason
    const zones = await findServiceZonesForPoint({ lat: parseFloat(lat), lng: parseFloat(lng) });
    const reason = zones.length === 0 ? 'OUT_OF_ZONE' : 'OTHER';

    await pool.query(`
      INSERT INTO unserved_requests (
        user_id, entered_address, lat, lng,
        desired_time_type, desired_time, reason, waitlist_opt_in
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, true)
    `, [userId, address, lat, lng, desiredTimeType, desiredTime, reason]);

    return res.json(ok({ joined: true }));

  } catch (error) {
    console.error('Error in POST /routing/join-waitlist:', error);
    return res.status(500).json(fail('INTERNAL_ERROR', 'Failed to join waitlist.'));
  }
});

// ============================================================================
// Get User's Assignments
// ============================================================================

/**
 * GET /routing/my-assignments
 * 
 * Get the current user's window assignments.
 * 
 * Query params:
 * - from?: Start date (YYYY-MM-DD), defaults to today
 * - to?: End date (YYYY-MM-DD), defaults to 30 days from now
 */
routingRouter.get('/my-assignments', async (req: Request, res: Response) => {
  try {
    const userId = getUserIdFromHeader(req);
    if (!userId) {
      return res.status(401).json(fail('UNAUTHORIZED', 'Missing or invalid x-user-id header.'));
    }

    const fromDate = (req.query.from as string) || new Date().toISOString().slice(0, 10);
    const toDate = (req.query.to as string) || (() => {
      const d = new Date();
      d.setDate(d.getDate() + 30);
      return d.toISOString().slice(0, 10);
    })();

    const result = await pool.query(`
      SELECT 
        wa.id,
        wa.service_date as "serviceDate",
        wa.pickup_lat as "pickupLat",
        wa.pickup_lng as "pickupLng",
        wa.pickup_address as "pickupAddress",
        wa.status,
        wa.estimated_pickup_time as "estimatedPickupTime",
        wa.estimated_arrival_time as "estimatedArrivalTime",
        tw.id as "timeWindowId",
        tw.label as "timeWindowLabel",
        tw.window_type as "windowType",
        tw.campus_target_time as "campusTargetTime",
        sz.name as "zoneName",
        sz.campus_name as "campusName",
        rp.google_route_polyline as "routePolyline"
      FROM window_assignments wa
      JOIN time_windows tw ON wa.time_window_id = tw.id
      JOIN service_zones sz ON tw.service_zone_id = sz.id
      LEFT JOIN route_plans rp ON rp.time_window_id = tw.id AND rp.service_date = wa.service_date
      WHERE wa.user_id = $1
        AND wa.service_date >= $2
        AND wa.service_date <= $3
        AND wa.status IN ('CONFIRMED', 'WAITLISTED')
      ORDER BY wa.service_date ASC, tw.campus_target_time ASC
    `, [userId, fromDate, toDate]);

    return res.json(ok({ assignments: result.rows }));

  } catch (error) {
    console.error('Error in GET /routing/my-assignments:', error);
    return res.status(500).json(fail('INTERNAL_ERROR', 'Failed to get assignments.'));
  }
});

// ============================================================================
// Get Route Plan Details (for map display)
// ============================================================================

/**
 * GET /routing/route-plan/:timeWindowId/:serviceDate
 * 
 * Get the route plan for a specific time window and date.
 * Includes polyline for map display.
 */
routingRouter.get('/route-plan/:timeWindowId/:serviceDate', async (req: Request, res: Response) => {
  try {
    const timeWindowId = parseInt(req.params.timeWindowId, 10);
    const serviceDate = req.params.serviceDate;

    if (Number.isNaN(timeWindowId) || !/^\d{4}-\d{2}-\d{2}$/.test(serviceDate)) {
      return res.status(400).json(fail('INVALID_PARAMS', 'Invalid timeWindowId or serviceDate.'));
    }

    const result = await pool.query(`
      SELECT 
        rp.id,
        rp.service_date as "serviceDate",
        rp.planned_departure_time as "plannedDepartureTime",
        rp.ordered_assignment_ids as "orderedAssignmentIds",
        rp.google_route_polyline as "polyline",
        rp.google_base_duration_seconds as "durationSeconds",
        rp.google_total_distance_meters as "distanceMeters",
        tw.label as "timeWindowLabel",
        tw.campus_target_time as "campusTargetTime",
        sz.name as "zoneName",
        sz.campus_lat as "campusLat",
        sz.campus_lng as "campusLng",
        sz.campus_name as "campusName"
      FROM route_plans rp
      JOIN time_windows tw ON rp.time_window_id = tw.id
      JOIN service_zones sz ON tw.service_zone_id = sz.id
      WHERE rp.time_window_id = $1 AND rp.service_date = $2
    `, [timeWindowId, serviceDate]);

    if (result.rows.length === 0) {
      return res.status(404).json(fail('NOT_FOUND', 'Route plan not found.'));
    }

    const routePlan = result.rows[0];

    // Get pickup stops in order
    if (routePlan.orderedAssignmentIds && routePlan.orderedAssignmentIds.length > 0) {
      const stopsResult = await pool.query(`
        SELECT 
          id,
          pickup_lat as "lat",
          pickup_lng as "lng",
          pickup_address as "address"
        FROM window_assignments
        WHERE id = ANY($1)
        ORDER BY array_position($1, id)
      `, [routePlan.orderedAssignmentIds]);

      routePlan.stops = stopsResult.rows;
    } else {
      routePlan.stops = [];
    }

    return res.json(ok(routePlan));

  } catch (error) {
    console.error('Error in GET /routing/route-plan:', error);
    return res.status(500).json(fail('INTERNAL_ERROR', 'Failed to get route plan.'));
  }
});

export { routingRouter };
export default routingRouter;

