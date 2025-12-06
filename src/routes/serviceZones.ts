/**
 * Service Zones Admin API
 * 
 * Provides admin endpoints for:
 * - Managing service zones (CRUD)
 * - Managing time windows
 * - Viewing unserved requests and expansion clusters
 * - Daily operational views
 */

import { Router, Request, Response } from 'express';
import { pool } from '../db/pool';
import { ok, fail } from '../lib/apiResponse';
import { requireAuth, requireRole } from '../middleware/auth';

const serviceZonesRouter = Router();

// ============================================================================
// Helper Functions
// ============================================================================

function ensureAdmin(req: Request, res: Response): number | null {
  const header = req.header('x-user-id');
  const role = req.header('x-role');

  if (!header || !role || role !== 'admin') {
    res.status(403).json({ error: 'Admin access required.' });
    return null;
  }

  const id = parseInt(header, 10);
  if (Number.isNaN(id)) {
    res.status(401).json({ error: 'Invalid x-user-id header.' });
    return null;
  }

  return id;
}

// ============================================================================
// Service Zone Management
// ============================================================================

/**
 * GET /admin/service-zones
 * 
 * List all service zones.
 */
serviceZonesRouter.get('/', async (req: Request, res: Response) => {
  if (!ensureAdmin(req, res)) return;

  try {
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
        campus_name as "campusName",
        created_at as "createdAt",
        updated_at as "updatedAt"
      FROM service_zones
      ORDER BY name ASC
    `);

    // Get time window counts for each zone
    for (const zone of result.rows) {
      const windowsCount = await pool.query(`
        SELECT COUNT(*) as count FROM time_windows WHERE service_zone_id = $1
      `, [zone.id]);
      zone.timeWindowCount = parseInt(windowsCount.rows[0].count, 10);
    }

    return res.json(ok({ zones: result.rows }));

  } catch (error) {
    console.error('Error in GET /admin/service-zones:', error);
    return res.status(500).json(fail('INTERNAL_ERROR', 'Failed to load service zones.'));
  }
});

/**
 * GET /admin/service-zones/:id
 * 
 * Get a single service zone with its time windows.
 */
serviceZonesRouter.get('/:id', async (req: Request, res: Response) => {
  if (!ensureAdmin(req, res)) return;

  try {
    const zoneId = parseInt(req.params.id, 10);
    if (Number.isNaN(zoneId)) {
      return res.status(400).json(fail('INVALID_ID', 'Invalid zone ID.'));
    }

    const zoneResult = await pool.query(`
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
        campus_name as "campusName",
        created_at as "createdAt",
        updated_at as "updatedAt"
      FROM service_zones
      WHERE id = $1
    `, [zoneId]);

    if (zoneResult.rows.length === 0) {
      return res.status(404).json(fail('NOT_FOUND', 'Service zone not found.'));
    }

    const zone = zoneResult.rows[0];

    // Get time windows
    const windowsResult = await pool.query(`
      SELECT 
        id,
        window_type as "windowType",
        label,
        campus_target_time as "campusTargetTime",
        start_pickup_time as "startPickupTime",
        max_riders as "maxRiders",
        is_active as "isActive",
        created_at as "createdAt"
      FROM time_windows
      WHERE service_zone_id = $1
      ORDER BY window_type ASC, campus_target_time ASC
    `, [zoneId]);

    zone.timeWindows = windowsResult.rows;

    // Get pickup points
    const pickupPointsResult = await pool.query(`
      SELECT 
        id,
        name,
        lat,
        lng,
        is_virtual_stop as "isVirtualStop",
        is_active as "isActive"
      FROM pickup_points
      WHERE service_zone_id = $1
      ORDER BY name ASC
    `, [zoneId]);

    zone.pickupPoints = pickupPointsResult.rows;

    return res.json(ok({ zone }));

  } catch (error) {
    console.error('Error in GET /admin/service-zones/:id:', error);
    return res.status(500).json(fail('INTERNAL_ERROR', 'Failed to load service zone.'));
  }
});

/**
 * POST /admin/service-zones
 * 
 * Create a new service zone.
 * 
 * Body:
 * {
 *   name: string,
 *   polygon: GeoJSON,
 *   centerLat: number,
 *   centerLng: number,
 *   campusLat?: number,
 *   campusLng?: number,
 *   campusName?: string,
 *   maxDetourSeconds?: number,
 *   maxRidersPerTrip?: number,
 *   maxAnchorDistanceMeters?: number
 * }
 */
serviceZonesRouter.post('/', async (req: Request, res: Response) => {
  if (!ensureAdmin(req, res)) return;

  try {
    const {
      name,
      polygon,
      centerLat,
      centerLng,
      campusLat,
      campusLng,
      campusName,
      maxDetourSeconds,
      maxRidersPerTrip,
      maxAnchorDistanceMeters,
    } = req.body;

    if (!name || !polygon || centerLat === undefined || centerLng === undefined) {
      return res.status(400).json(fail(
        'MISSING_FIELDS',
        'name, polygon, centerLat, and centerLng are required.'
      ));
    }

    const result = await pool.query(`
      INSERT INTO service_zones (
        name, polygon, center_lat, center_lng,
        campus_lat, campus_lng, campus_name,
        max_detour_seconds, max_riders_per_trip, max_anchor_distance_meters
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id
    `, [
      name,
      JSON.stringify(polygon),
      centerLat,
      centerLng,
      campusLat || 49.8075,
      campusLng || -97.1365,
      campusName || 'University of Manitoba',
      maxDetourSeconds || 120,
      maxRidersPerTrip || 2,
      maxAnchorDistanceMeters,
    ]);

    return res.json(ok({ id: result.rows[0].id }));

  } catch (error) {
    console.error('Error in POST /admin/service-zones:', error);
    return res.status(500).json(fail('INTERNAL_ERROR', 'Failed to create service zone.'));
  }
});

/**
 * PUT /admin/service-zones/:id
 * 
 * Update a service zone.
 */
serviceZonesRouter.put('/:id', async (req: Request, res: Response) => {
  if (!ensureAdmin(req, res)) return;

  try {
    const zoneId = parseInt(req.params.id, 10);
    if (Number.isNaN(zoneId)) {
      return res.status(400).json(fail('INVALID_ID', 'Invalid zone ID.'));
    }

    const {
      name,
      polygon,
      centerLat,
      centerLng,
      campusLat,
      campusLng,
      campusName,
      maxDetourSeconds,
      maxRidersPerTrip,
      maxAnchorDistanceMeters,
      isActive,
    } = req.body;

    await pool.query(`
      UPDATE service_zones
      SET
        name = COALESCE($1, name),
        polygon = COALESCE($2, polygon),
        center_lat = COALESCE($3, center_lat),
        center_lng = COALESCE($4, center_lng),
        campus_lat = COALESCE($5, campus_lat),
        campus_lng = COALESCE($6, campus_lng),
        campus_name = COALESCE($7, campus_name),
        max_detour_seconds = COALESCE($8, max_detour_seconds),
        max_riders_per_trip = COALESCE($9, max_riders_per_trip),
        max_anchor_distance_meters = $10,
        is_active = COALESCE($11, is_active),
        updated_at = NOW()
      WHERE id = $12
    `, [
      name,
      polygon ? JSON.stringify(polygon) : null,
      centerLat,
      centerLng,
      campusLat,
      campusLng,
      campusName,
      maxDetourSeconds,
      maxRidersPerTrip,
      maxAnchorDistanceMeters,
      isActive,
      zoneId,
    ]);

    return res.json(ok({ updated: true }));

  } catch (error) {
    console.error('Error in PUT /admin/service-zones/:id:', error);
    return res.status(500).json(fail('INTERNAL_ERROR', 'Failed to update service zone.'));
  }
});

/**
 * DELETE /admin/service-zones/:id
 * 
 * Delete a service zone (soft delete by setting is_active = false).
 */
serviceZonesRouter.delete('/:id', async (req: Request, res: Response) => {
  if (!ensureAdmin(req, res)) return;

  try {
    const zoneId = parseInt(req.params.id, 10);
    if (Number.isNaN(zoneId)) {
      return res.status(400).json(fail('INVALID_ID', 'Invalid zone ID.'));
    }

    // Soft delete
    await pool.query(`
      UPDATE service_zones SET is_active = FALSE, updated_at = NOW() WHERE id = $1
    `, [zoneId]);

    return res.json(ok({ deleted: true }));

  } catch (error) {
    console.error('Error in DELETE /admin/service-zones/:id:', error);
    return res.status(500).json(fail('INTERNAL_ERROR', 'Failed to delete service zone.'));
  }
});

// ============================================================================
// Time Window Management
// ============================================================================

/**
 * POST /admin/service-zones/:zoneId/time-windows
 * 
 * Create a new time window for a service zone.
 */
serviceZonesRouter.post('/:zoneId/time-windows', async (req: Request, res: Response) => {
  if (!ensureAdmin(req, res)) return;

  try {
    const zoneId = parseInt(req.params.zoneId, 10);
    if (Number.isNaN(zoneId)) {
      return res.status(400).json(fail('INVALID_ID', 'Invalid zone ID.'));
    }

    const { windowType, label, campusTargetTime, startPickupTime, maxRiders } = req.body;

    if (!windowType || !label || !campusTargetTime || !startPickupTime) {
      return res.status(400).json(fail(
        'MISSING_FIELDS',
        'windowType, label, campusTargetTime, and startPickupTime are required.'
      ));
    }

    const result = await pool.query(`
      INSERT INTO time_windows (
        service_zone_id, window_type, label,
        campus_target_time, start_pickup_time, max_riders
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id
    `, [zoneId, windowType, label, campusTargetTime, startPickupTime, maxRiders || 4]);

    return res.json(ok({ id: result.rows[0].id }));

  } catch (error) {
    console.error('Error in POST /admin/service-zones/:zoneId/time-windows:', error);
    return res.status(500).json(fail('INTERNAL_ERROR', 'Failed to create time window.'));
  }
});

/**
 * PUT /admin/service-zones/time-windows/:id
 * 
 * Update a time window.
 */
serviceZonesRouter.put('/time-windows/:id', async (req: Request, res: Response) => {
  if (!ensureAdmin(req, res)) return;

  try {
    const windowId = parseInt(req.params.id, 10);
    if (Number.isNaN(windowId)) {
      return res.status(400).json(fail('INVALID_ID', 'Invalid window ID.'));
    }

    const { label, campusTargetTime, startPickupTime, maxRiders, isActive } = req.body;

    await pool.query(`
      UPDATE time_windows
      SET
        label = COALESCE($1, label),
        campus_target_time = COALESCE($2, campus_target_time),
        start_pickup_time = COALESCE($3, start_pickup_time),
        max_riders = COALESCE($4, max_riders),
        is_active = COALESCE($5, is_active),
        updated_at = NOW()
      WHERE id = $6
    `, [label, campusTargetTime, startPickupTime, maxRiders, isActive, windowId]);

    return res.json(ok({ updated: true }));

  } catch (error) {
    console.error('Error in PUT /admin/service-zones/time-windows/:id:', error);
    return res.status(500).json(fail('INTERNAL_ERROR', 'Failed to update time window.'));
  }
});

/**
 * DELETE /admin/service-zones/time-windows/:id
 * 
 * Delete a time window (soft delete).
 */
serviceZonesRouter.delete('/time-windows/:id', async (req: Request, res: Response) => {
  if (!ensureAdmin(req, res)) return;

  try {
    const windowId = parseInt(req.params.id, 10);
    if (Number.isNaN(windowId)) {
      return res.status(400).json(fail('INVALID_ID', 'Invalid window ID.'));
    }

    await pool.query(`
      UPDATE time_windows SET is_active = FALSE, updated_at = NOW() WHERE id = $1
    `, [windowId]);

    return res.json(ok({ deleted: true }));

  } catch (error) {
    console.error('Error in DELETE /admin/service-zones/time-windows/:id:', error);
    return res.status(500).json(fail('INTERNAL_ERROR', 'Failed to delete time window.'));
  }
});

// ============================================================================
// Unserved Requests / Expansion
// ============================================================================

/**
 * GET /admin/service-zones/unserved-requests
 * 
 * Get all unserved requests for expansion planning.
 */
serviceZonesRouter.get('/unserved-requests', async (req: Request, res: Response) => {
  if (!ensureAdmin(req, res)) return;

  try {
    const result = await pool.query(`
      SELECT 
        ur.id,
        ur.user_id as "userId",
        ur.entered_address as "address",
        ur.lat,
        ur.lng,
        ur.desired_time_type as "desiredTimeType",
        ur.desired_time as "desiredTime",
        ur.reason,
        ur.reason_details as "reasonDetails",
        ur.waitlist_opt_in as "waitlistOptIn",
        ur.created_at as "createdAt",
        u.name as "userName",
        u.phone as "userPhone"
      FROM unserved_requests ur
      LEFT JOIN users u ON ur.user_id = u.id
      ORDER BY ur.created_at DESC
      LIMIT 500
    `);

    return res.json(ok({ requests: result.rows }));

  } catch (error) {
    console.error('Error in GET /admin/service-zones/unserved-requests:', error);
    return res.status(500).json(fail('INTERNAL_ERROR', 'Failed to load unserved requests.'));
  }
});

/**
 * GET /admin/service-zones/unserved-clusters
 * 
 * Get clustered unserved requests for expansion planning.
 */
serviceZonesRouter.get('/unserved-clusters', async (req: Request, res: Response) => {
  if (!ensureAdmin(req, res)) return;

  try {
    // Simple clustering by rounding lat/lng to ~500m grid
    const result = await pool.query(`
      SELECT 
        ROUND(lat::numeric, 2) as "clusterLat",
        ROUND(lng::numeric, 2) as "clusterLng",
        COUNT(*) as "requestCount",
        COUNT(DISTINCT user_id) as "uniqueUsers",
        array_agg(DISTINCT desired_time_type) as "desiredTimeTypes"
      FROM unserved_requests
      WHERE waitlist_opt_in = TRUE
      GROUP BY ROUND(lat::numeric, 2), ROUND(lng::numeric, 2)
      HAVING COUNT(*) >= 3
      ORDER BY COUNT(*) DESC
    `);

    return res.json(ok({ clusters: result.rows }));

  } catch (error) {
    console.error('Error in GET /admin/service-zones/unserved-clusters:', error);
    return res.status(500).json(fail('INTERNAL_ERROR', 'Failed to load unserved clusters.'));
  }
});

// ============================================================================
// Daily Operations View
// ============================================================================

/**
 * GET /admin/service-zones/daily-operations/:date
 * 
 * Get the operational view for a specific date.
 */
serviceZonesRouter.get('/daily-operations/:date', async (req: Request, res: Response) => {
  if (!ensureAdmin(req, res)) return;

  try {
    const serviceDate = req.params.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate)) {
      return res.status(400).json(fail('INVALID_DATE', 'Date must be in YYYY-MM-DD format.'));
    }

    // Get all active zones
    const zones = await pool.query(`
      SELECT id, name FROM service_zones WHERE is_active = TRUE ORDER BY name
    `);

    const operations: any[] = [];

    for (const zone of zones.rows) {
      // Get time windows and their assignments for this date
      const windows = await pool.query(`
        SELECT 
          tw.id,
          tw.window_type as "windowType",
          tw.label,
          tw.campus_target_time as "campusTargetTime",
          tw.max_riders as "maxRiders"
        FROM time_windows tw
        WHERE tw.service_zone_id = $1 AND tw.is_active = TRUE
        ORDER BY tw.campus_target_time
      `, [zone.id]);

      const windowOps: any[] = [];

      for (const window of windows.rows) {
        // Get assignments
        const assignments = await pool.query(`
          SELECT 
            wa.id,
            wa.user_id as "userId",
            wa.pickup_address as "pickupAddress",
            wa.status,
            u.name as "riderName",
            u.phone as "riderPhone"
          FROM window_assignments wa
          JOIN users u ON wa.user_id = u.id
          WHERE wa.time_window_id = $1 AND wa.service_date = $2
          ORDER BY wa.created_at
        `, [window.id, serviceDate]);

        // Get route plan
        const routePlan = await pool.query(`
          SELECT 
            planned_departure_time as "plannedDepartureTime",
            google_base_duration_seconds as "durationSeconds",
            google_route_polyline as "polyline"
          FROM route_plans
          WHERE time_window_id = $1 AND service_date = $2
        `, [window.id, serviceDate]);

        windowOps.push({
          ...window,
          confirmedCount: assignments.rows.filter(a => a.status === 'CONFIRMED').length,
          assignments: assignments.rows,
          routePlan: routePlan.rows[0] || null,
        });
      }

      operations.push({
        zoneId: zone.id,
        zoneName: zone.name,
        windows: windowOps,
      });
    }

    return res.json(ok({ date: serviceDate, operations }));

  } catch (error) {
    console.error('Error in GET /admin/service-zones/daily-operations:', error);
    return res.status(500).json(fail('INTERNAL_ERROR', 'Failed to load daily operations.'));
  }
});

export { serviceZonesRouter };
export default serviceZonesRouter;

