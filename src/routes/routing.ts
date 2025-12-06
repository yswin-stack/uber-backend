/**
 * Routing API endpoints
 * Handles service area checks, time window availability, and ride booking
 */

import { Router, Request, Response } from "express";
import { pool } from "../db/pool";
import { canAddRiderToWindow, confirmWindowAssignment } from "../lib/routingEngine";

export const routingRouter = Router();

/**
 * Simple point-in-polygon check using ray casting algorithm
 * No external dependencies needed
 */
function isPointInPolygonCoords(point: { lng: number; lat: number }, coordinates: number[][][]): boolean {
  if (!coordinates || !coordinates[0]) return false;

  const ring = coordinates[0]; // Outer ring
  let inside = false;
  const x = point.lng;
  const y = point.lat;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];

    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }

  return inside;
}

/**
 * GET /routing/service-zones
 * Get active service zones (public - no auth required)
 * Used for displaying zone on maps
 */
routingRouter.get("/service-zones", async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(`
      SELECT 
        id,
        name,
        polygon,
        center_lat as "centerLat",
        center_lng as "centerLng",
        campus_lat as "campusLat",
        campus_lng as "campusLng",
        campus_name as "campusName"
      FROM service_zones 
      WHERE is_active = true
      ORDER BY name
    `);

    return res.json({ zones: result.rows });
  } catch (err) {
    console.error("Error fetching service zones:", err);
    return res.status(500).json({ error: "Failed to fetch service zones" });
  }
});

/**
 * GET /routing/active-time-windows
 * Get active time windows for scheduling (public - requires userId for zone matching)
 */
routingRouter.get("/active-time-windows", async (req: Request, res: Response) => {
  const userId = req.headers["x-user-id"];
  
  try {
    // If userId provided, get user's zone and filter windows
    let zoneFilter = "";
    let params: any[] = [];
    
    if (userId) {
      const userResult = await pool.query(
        `SELECT address_zone_id, default_pickup_lat, default_pickup_lng FROM users WHERE id = $1`,
        [userId]
      );
      
      if (userResult.rows[0]?.address_zone_id) {
        zoneFilter = "AND sz.id = $1";
        params = [userResult.rows[0].address_zone_id];
      }
    }
    
    const result = await pool.query(`
      SELECT 
        tw.id,
        tw.service_zone_id as "zoneId",
        sz.name as "zoneName",
        tw.window_type as "type",
        tw.label,
        tw.campus_target_time as "campusTargetTime",
        tw.start_pickup_time as "startPickupTime",
        tw.max_riders as "maxRiders"
      FROM time_windows tw
      JOIN service_zones sz ON tw.service_zone_id = sz.id
      WHERE tw.is_active = true AND sz.is_active = true ${zoneFilter}
      ORDER BY tw.window_type, tw.campus_target_time
    `, params);

    // Separate into morning (arrival) and evening (departure)
    const morningWindows = result.rows.filter((w: any) => w.type === 'MORNING');
    const eveningWindows = result.rows.filter((w: any) => w.type === 'EVENING');

    return res.json({
      morningWindows,
      eveningWindows,
      allWindows: result.rows,
    });
  } catch (err) {
    console.error("Error fetching time windows:", err);
    return res.status(500).json({ error: "Failed to fetch time windows" });
  }
});

/**
function isPointInPolygon(point: { lng: number; lat: number }, polygon: number[][][]): boolean {
  if (!polygon || !polygon[0]) return false;

  const ring = polygon[0]; // Outer ring
  let inside = false;
  const x = point.lng;
  const y = point.lat;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];

    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }

  return inside;
}

/**
 * POST /routing/check-service-area
 * Check if a location is within an active service zone
 */
routingRouter.post("/check-service-area", async (req: Request, res: Response) => {
  const { lat, lng, address } = req.body;

  if (typeof lat !== "number" || typeof lng !== "number") {
    return res.status(400).json({ error: "lat and lng are required" });
  }

  try {
    // Get all active zones
    const zonesResult = await pool.query(
      `SELECT id, name, polygon, campus_name as "campusName"
       FROM service_zones 
       WHERE is_active = true`
    );

    const matchingZones = [];

    for (const zone of zonesResult.rows) {
      if (zone.polygon && zone.polygon.coordinates) {
        try {
          if (isPointInPolygon({ lng, lat }, zone.polygon.coordinates)) {
            matchingZones.push({
              id: zone.id,
              name: zone.name,
              campusName: zone.campusName,
            });
          }
        } catch (e) {
          console.error(`Invalid polygon for zone ${zone.id}:`, e);
        }
      }
    }

    if (matchingZones.length > 0) {
      return res.json({
        inServiceArea: true,
        lat,
        lng,
        zones: matchingZones,
      });
    }

    // Log unserved request for expansion analytics
    if (address) {
      try {
        await pool.query(
          `INSERT INTO unserved_requests (entered_address, lat, lng, desired_time_type, reason)
           VALUES ($1, $2, $3, 'MORNING', 'OUT_OF_ZONE')`,
          [address, lat, lng]
        );
      } catch (e) {
        console.error("Failed to log unserved request:", e);
      }
    }

    return res.json({
      inServiceArea: false,
      lat,
      lng,
      message: "This location is outside our current service areas",
    });
  } catch (err) {
    console.error("Error checking service area:", err);
    return res.status(500).json({ error: "Failed to check service area" });
  }
});

/**
 * GET /routing/available-windows
 * Get available time windows for a location and date
 */
routingRouter.get("/available-windows", async (req: Request, res: Response) => {
  const lat = parseFloat(req.query.lat as string);
  const lng = parseFloat(req.query.lng as string);
  const date = req.query.date as string;

  if (isNaN(lat) || isNaN(lng) || !date) {
    return res.status(400).json({ error: "lat, lng, and date are required" });
  }

  try {
    // Find matching zones
    const zonesResult = await pool.query(
      `SELECT id, name, polygon
       FROM service_zones 
       WHERE is_active = true`
    );

    let matchingZoneId: number | null = null;
    let matchingZoneName: string | null = null;

    for (const zone of zonesResult.rows) {
      if (zone.polygon && zone.polygon.coordinates) {
        try {
          if (isPointInPolygon({ lng, lat }, zone.polygon.coordinates)) {
            matchingZoneId = zone.id;
            matchingZoneName = zone.name;
            break;
          }
        } catch (e) {
          console.error(`Invalid polygon for zone ${zone.id}:`, e);
        }
      }
    }

    if (!matchingZoneId) {
      return res.json({
        inServiceArea: false,
        message: "Location is outside service areas",
      });
    }

    // Get time windows for the zone
    const windowsResult = await pool.query(
      `SELECT tw.id, tw.window_type as "type", tw.label, 
              tw.campus_target_time as "campusTargetTime",
              tw.start_pickup_time as "startPickupTime",
              tw.max_riders as "maxRiders"
       FROM time_windows tw
       WHERE tw.service_zone_id = $1 AND tw.is_active = true
       ORDER BY tw.campus_target_time`,
      [matchingZoneId]
    );

    // Get current assignment counts for each window
    const windows = [];
    for (const window of windowsResult.rows) {
      const countResult = await pool.query(
        `SELECT COUNT(*) as count
         FROM window_assignments
         WHERE time_window_id = $1 AND service_date = $2 AND status = 'CONFIRMED'`,
        [window.id, date]
      );

      const confirmedCount = parseInt(countResult.rows[0].count, 10);
      const availableSeats = window.maxRiders - confirmedCount;

      windows.push({
        id: window.id,
        zoneId: matchingZoneId,
        zoneName: matchingZoneName,
        type: window.type,
        label: window.label,
        campusTargetTime: window.campusTargetTime,
        startPickupTime: window.startPickupTime,
        maxRiders: window.maxRiders,
        confirmedCount,
        availableSeats,
        isFull: availableSeats <= 0,
        currentRiderCount: confirmedCount,
      });
    }

    return res.json({
      inServiceArea: true,
      zones: [{ id: matchingZoneId, name: matchingZoneName }],
      windows,
    });
  } catch (err) {
    console.error("Error getting available windows:", err);
    return res.status(500).json({ error: "Failed to get available windows" });
  }
});

/**
 * POST /routing/can-add-to-window
 * Check if a rider can be added to a specific time window
 */
routingRouter.post("/can-add-to-window", async (req: Request, res: Response) => {
  const { serviceDate, timeWindowId, pickupLat, pickupLng, pickupAddress } = req.body;

  if (!serviceDate || !timeWindowId || typeof pickupLat !== "number" || typeof pickupLng !== "number") {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    const result = await canAddRiderToWindow({
      serviceDate,
      timeWindowId,
      pickupLat,
      pickupLng,
      pickupAddress,
    });

    return res.json(result);
  } catch (err) {
    console.error("Error checking window availability:", err);
    return res.status(500).json({ error: "Failed to check window availability" });
  }
});

/**
 * POST /routing/confirm-window
 * Confirm a rider's booking for a time window
 */
routingRouter.post("/confirm-window", async (req: Request, res: Response) => {
  const userId = req.headers["x-user-id"];
  if (!userId) {
    return res.status(401).json({ error: "Authentication required" });
  }

  const { serviceDate, timeWindowId, pickupLat, pickupLng, pickupAddress } = req.body;

  if (!serviceDate || !timeWindowId || typeof pickupLat !== "number" || typeof pickupLng !== "number") {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    const result = await confirmWindowAssignment({
      userId: parseInt(userId as string, 10),
      serviceDate,
      timeWindowId,
      pickupLat,
      pickupLng,
      pickupAddress,
    });

    return res.json(result);
  } catch (err: any) {
    console.error("Error confirming window:", err);
    return res.status(400).json({ error: err.message || "Failed to confirm booking" });
  }
});

/**
 * POST /routing/join-waitlist
 * Add a user to the waitlist for an unserved area
 */
routingRouter.post("/join-waitlist", async (req: Request, res: Response) => {
  const userId = req.headers["x-user-id"];
  const { address, lat, lng, desiredTimeType } = req.body;

  if (typeof lat !== "number" || typeof lng !== "number") {
    return res.status(400).json({ error: "lat and lng are required" });
  }

  try {
    await pool.query(
      `INSERT INTO unserved_requests 
       (user_id, entered_address, lat, lng, desired_time_type, reason, waitlist_opt_in)
       VALUES ($1, $2, $3, $4, $5, 'OUT_OF_ZONE', true)`,
      [userId ? parseInt(userId as string, 10) : null, address || "", lat, lng, desiredTimeType || "MORNING"]
    );

    return res.json({ success: true, message: "Added to waitlist" });
  } catch (err) {
    console.error("Error joining waitlist:", err);
    return res.status(500).json({ error: "Failed to join waitlist" });
  }
});

export default routingRouter;
