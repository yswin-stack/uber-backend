/**
 * Service Zones Admin API
 * CRUD operations for service zones and time windows
 */

import { Router, Request, Response } from "express";
import { pool } from "../db/pool";

export const serviceZonesRouter = Router();

// Middleware to check admin role
const requireAdmin = (req: Request, res: Response, next: () => void) => {
  const role = req.headers["x-role"];
  if (role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
};

/**
 * GET /admin/service-zones
 * List all service zones
 */
serviceZonesRouter.get("/", requireAdmin, async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(`
      SELECT 
        sz.id,
        sz.name,
        sz.polygon,
        sz.center_lat as "centerLat",
        sz.center_lng as "centerLng",
        sz.is_active as "isActive",
        sz.max_detour_seconds as "maxDetourSeconds",
        sz.max_riders_per_trip as "maxRidersPerTrip",
        sz.max_anchor_distance_meters as "maxAnchorDistanceMeters",
        sz.campus_lat as "campusLat",
        sz.campus_lng as "campusLng",
        sz.campus_name as "campusName",
        (SELECT COUNT(*) FROM time_windows tw WHERE tw.service_zone_id = sz.id) as "timeWindowCount"
      FROM service_zones sz
      ORDER BY sz.name
    `);

    return res.json({ zones: result.rows });
  } catch (err) {
    console.error("Error fetching service zones:", err);
    return res.status(500).json({ error: "Failed to fetch service zones" });
  }
});

/**
 * GET /admin/service-zones/:id
 * Get a single service zone with its time windows
 */
serviceZonesRouter.get("/:id", requireAdmin, async (req: Request, res: Response) => {
  const zoneId = parseInt(req.params.id, 10);
  if (isNaN(zoneId)) {
    return res.status(400).json({ error: "Invalid zone ID" });
  }

  try {
    const zoneResult = await pool.query(
      `SELECT 
        id, name, polygon,
        center_lat as "centerLat",
        center_lng as "centerLng",
        is_active as "isActive",
        max_detour_seconds as "maxDetourSeconds",
        max_riders_per_trip as "maxRidersPerTrip",
        max_anchor_distance_meters as "maxAnchorDistanceMeters",
        campus_lat as "campusLat",
        campus_lng as "campusLng",
        campus_name as "campusName"
      FROM service_zones WHERE id = $1`,
      [zoneId]
    );

    if (zoneResult.rows.length === 0) {
      return res.status(404).json({ error: "Zone not found" });
    }

    const windowsResult = await pool.query(
      `SELECT 
        id,
        window_type as "windowType",
        label,
        campus_target_time as "campusTargetTime",
        start_pickup_time as "startPickupTime",
        max_riders as "maxRiders",
        is_active as "isActive"
      FROM time_windows 
      WHERE service_zone_id = $1
      ORDER BY campus_target_time`,
      [zoneId]
    );

    return res.json({
      zone: {
        ...zoneResult.rows[0],
        timeWindows: windowsResult.rows,
      },
    });
  } catch (err) {
    console.error("Error fetching service zone:", err);
    return res.status(500).json({ error: "Failed to fetch service zone" });
  }
});

/**
 * POST /admin/service-zones
 * Create a new service zone
 */
serviceZonesRouter.post("/", requireAdmin, async (req: Request, res: Response) => {
  const {
    name,
    polygon,
    centerLat,
    centerLng,
    isActive,
    maxDetourSeconds,
    maxRidersPerTrip,
    maxAnchorDistanceMeters,
    campusLat,
    campusLng,
    campusName,
  } = req.body;

  if (!name) {
    return res.status(400).json({ error: "Name is required" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO service_zones 
       (name, polygon, center_lat, center_lng, is_active, max_detour_seconds, 
        max_riders_per_trip, max_anchor_distance_meters, campus_lat, campus_lng, campus_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        name,
        polygon || null,
        centerLat || null,
        centerLng || null,
        isActive !== false,
        maxDetourSeconds || 120,
        maxRidersPerTrip || 4,
        maxAnchorDistanceMeters || null,
        campusLat || 49.8075,
        campusLng || -97.1365,
        campusName || "University of Manitoba",
      ]
    );

    return res.status(201).json({ id: result.rows[0].id });
  } catch (err) {
    console.error("Error creating service zone:", err);
    return res.status(500).json({ error: "Failed to create service zone" });
  }
});

/**
 * PUT /admin/service-zones/:id
 * Update a service zone
 */
serviceZonesRouter.put("/:id", requireAdmin, async (req: Request, res: Response) => {
  const zoneId = parseInt(req.params.id, 10);
  if (isNaN(zoneId)) {
    return res.status(400).json({ error: "Invalid zone ID" });
  }

  const updates: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  const fields = [
    { key: "name", column: "name" },
    { key: "polygon", column: "polygon" },
    { key: "centerLat", column: "center_lat" },
    { key: "centerLng", column: "center_lng" },
    { key: "isActive", column: "is_active" },
    { key: "maxDetourSeconds", column: "max_detour_seconds" },
    { key: "maxRidersPerTrip", column: "max_riders_per_trip" },
    { key: "maxAnchorDistanceMeters", column: "max_anchor_distance_meters" },
    { key: "campusLat", column: "campus_lat" },
    { key: "campusLng", column: "campus_lng" },
    { key: "campusName", column: "campus_name" },
  ];

  for (const field of fields) {
    if (req.body[field.key] !== undefined) {
      updates.push(`${field.column} = $${paramIndex++}`);
      values.push(req.body[field.key]);
    }
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: "No fields to update" });
  }

  values.push(zoneId);

  try {
    const result = await pool.query(
      `UPDATE service_zones SET ${updates.join(", ")}, updated_at = NOW() WHERE id = $${paramIndex}`,
      values
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Zone not found" });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("Error updating service zone:", err);
    return res.status(500).json({ error: "Failed to update service zone" });
  }
});

/**
 * DELETE /admin/service-zones/:id
 * Delete a service zone
 */
serviceZonesRouter.delete("/:id", requireAdmin, async (req: Request, res: Response) => {
  const zoneId = parseInt(req.params.id, 10);
  if (isNaN(zoneId)) {
    return res.status(400).json({ error: "Invalid zone ID" });
  }

  try {
    const result = await pool.query(`DELETE FROM service_zones WHERE id = $1`, [zoneId]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Zone not found" });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("Error deleting service zone:", err);
    return res.status(500).json({ error: "Failed to delete service zone" });
  }
});

/**
 * POST /admin/service-zones/:zoneId/time-windows
 * Create a time window for a zone
 */
serviceZonesRouter.post("/:zoneId/time-windows", requireAdmin, async (req: Request, res: Response) => {
  const zoneId = parseInt(req.params.zoneId, 10);
  if (isNaN(zoneId)) {
    return res.status(400).json({ error: "Invalid zone ID" });
  }

  const { windowType, label, campusTargetTime, startPickupTime, maxRiders, isActive } = req.body;

  if (!windowType || !label || !campusTargetTime || !startPickupTime) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO time_windows 
       (service_zone_id, window_type, label, campus_target_time, start_pickup_time, max_riders, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [zoneId, windowType, label, campusTargetTime, startPickupTime, maxRiders || 4, isActive !== false]
    );

    return res.status(201).json({ id: result.rows[0].id });
  } catch (err) {
    console.error("Error creating time window:", err);
    return res.status(500).json({ error: "Failed to create time window" });
  }
});

/**
 * PUT /admin/service-zones/time-windows/:id
 * Update a time window
 */
serviceZonesRouter.put("/time-windows/:id", requireAdmin, async (req: Request, res: Response) => {
  const windowId = parseInt(req.params.id, 10);
  if (isNaN(windowId)) {
    return res.status(400).json({ error: "Invalid window ID" });
  }

  const updates: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  const fields = [
    { key: "windowType", column: "window_type" },
    { key: "label", column: "label" },
    { key: "campusTargetTime", column: "campus_target_time" },
    { key: "startPickupTime", column: "start_pickup_time" },
    { key: "maxRiders", column: "max_riders" },
    { key: "isActive", column: "is_active" },
  ];

  for (const field of fields) {
    if (req.body[field.key] !== undefined) {
      updates.push(`${field.column} = $${paramIndex++}`);
      values.push(req.body[field.key]);
    }
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: "No fields to update" });
  }

  values.push(windowId);

  try {
    const result = await pool.query(
      `UPDATE time_windows SET ${updates.join(", ")}, updated_at = NOW() WHERE id = $${paramIndex}`,
      values
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Window not found" });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("Error updating time window:", err);
    return res.status(500).json({ error: "Failed to update time window" });
  }
});

/**
 * GET /admin/service-zones/daily-operations/:date
 * Get daily operations view with assignments and route plans
 */
serviceZonesRouter.get("/daily-operations/:date", requireAdmin, async (req: Request, res: Response) => {
  const date = req.params.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: "Invalid date format" });
  }

  try {
    // Get all zones with their windows
    const zonesResult = await pool.query(`
      SELECT id, name FROM service_zones WHERE is_active = true ORDER BY name
    `);

    const operations = [];

    for (const zone of zonesResult.rows) {
      const windowsResult = await pool.query(
        `SELECT 
          tw.id,
          tw.window_type as "windowType",
          tw.label,
          tw.campus_target_time as "campusTargetTime",
          tw.max_riders as "maxRiders"
        FROM time_windows tw
        WHERE tw.service_zone_id = $1 AND tw.is_active = true
        ORDER BY tw.campus_target_time`,
        [zone.id]
      );

      const windows = [];

      for (const window of windowsResult.rows) {
        // Get assignments
        const assignmentsResult = await pool.query(
          `SELECT 
            wa.id,
            wa.user_id as "userId",
            wa.pickup_address as "pickupAddress",
            wa.status,
            u.name as "riderName",
            u.phone as "riderPhone"
          FROM window_assignments wa
          LEFT JOIN users u ON wa.user_id = u.id
          WHERE wa.time_window_id = $1 AND wa.service_date = $2 AND wa.status = 'CONFIRMED'
          ORDER BY wa.id`,
          [window.id, date]
        );

        // Get route plan
        const routePlanResult = await pool.query(
          `SELECT 
            planned_departure_time as "plannedDepartureTime",
            google_base_duration_seconds as "durationSeconds",
            google_route_polyline as "polyline"
          FROM route_plans
          WHERE time_window_id = $1 AND service_date = $2`,
          [window.id, date]
        );

        windows.push({
          ...window,
          confirmedCount: assignmentsResult.rows.length,
          assignments: assignmentsResult.rows,
          routePlan: routePlanResult.rows[0] || null,
        });
      }

      if (windows.length > 0) {
        operations.push({
          zoneId: zone.id,
          zoneName: zone.name,
          windows,
        });
      }
    }

    return res.json({ date, operations });
  } catch (err) {
    console.error("Error getting daily operations:", err);
    return res.status(500).json({ error: "Failed to get daily operations" });
  }
});

/**
 * GET /admin/service-zones/unserved-clusters
 * Get clusters of unserved requests for expansion planning
 */
serviceZonesRouter.get("/unserved-clusters", requireAdmin, async (_req: Request, res: Response) => {
  try {
    // Simple clustering by rounding lat/lng to 2 decimal places (~1km grid)
    const result = await pool.query(`
      SELECT 
        ROUND(lat::numeric, 2) as "clusterLat",
        ROUND(lng::numeric, 2) as "clusterLng",
        COUNT(*) as "requestCount",
        COUNT(DISTINCT user_id) as "uniqueUsers",
        array_agg(DISTINCT desired_time_type) as "desiredTimeTypes"
      FROM unserved_requests
      WHERE created_at > NOW() - INTERVAL '30 days'
      GROUP BY ROUND(lat::numeric, 2), ROUND(lng::numeric, 2)
      HAVING COUNT(*) >= 3
      ORDER BY COUNT(*) DESC
    `);

    return res.json({ clusters: result.rows });
  } catch (err) {
    console.error("Error getting unserved clusters:", err);
    return res.status(500).json({ error: "Failed to get unserved clusters" });
  }
});

export default serviceZonesRouter;

