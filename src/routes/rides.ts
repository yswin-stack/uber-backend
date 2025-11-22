import { Router } from "express";
import { pool } from "../db/pool";

export const ridesRouter = Router();

type RideRow = {
  id: number;
  user_id: number;
  pickup_location: string;
  dropoff_location: string;
  pickup_time: string | null;
  status: string;
};

/**
 * Helper: read userId from x-user-id header
 */
function getUserIdFromHeader(req: any): number | null {
  const header = req.header("x-user-id");
  if (!header) return null;
  const n = Number(header);
  if (!n || Number.isNaN(n)) return null;
  return n;
}

/**
 * POST /rides
 * Create a new ride for the logged-in user.
 *
 * Expects JSON body with at least:
 *  - pickupLocation OR pickup_address
 *  - dropoffLocation OR dropoff_address
 *  - pickupTime (ISO string)  (optional, can be null for ASAP)
 *
 * Header:
 *  - x-user-id: user id from auth
 */
ridesRouter.post("/", async (req, res) => {
  try {
    const userId = getUserIdFromHeader(req);
    if (!userId) {
      return res.status(401).json({ error: "Missing or invalid x-user-id header." });
    }

    const body = req.body || {};

    const pickupLocation: string =
      body.pickupLocation ||
      body.pickup_address ||
      body.pickup_location ||
      "";
    const dropoffLocation: string =
      body.dropoffLocation ||
      body.dropoff_address ||
      body.dropoff_location ||
      "";
    const pickupTimeIso: string | null =
      body.pickupTime || body.pickup_time || null;

    if (!pickupLocation || !dropoffLocation) {
      return res.status(400).json({
        error: "Missing required fields: pickup and dropoff address.",
      });
    }

    const insert = await pool.query<RideRow>(
      `
      INSERT INTO rides (user_id, pickup_location, dropoff_location, pickup_time, status)
      VALUES ($1, $2, $3, $4, 'pending')
      RETURNING id, user_id, pickup_location, dropoff_location, pickup_time, status
    `,
      [userId, pickupLocation, dropoffLocation, pickupTimeIso]
    );

    const ride = insert.rows[0];

    return res.status(201).json({
      ride,
    });
  } catch (err) {
    console.error("Error in POST /rides:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /rides/user
 * Returns up to 100 rides for the logged-in user as JSON.
 *
 * Header:
 *  - x-user-id
 */
ridesRouter.get("/user", async (req, res) => {
  try {
    const userId = getUserIdFromHeader(req);
    if (!userId) {
      return res.status(401).json({ error: "Missing or invalid x-user-id header." });
    }

    const result = await pool.query<RideRow>(
      `
      SELECT
        id,
        user_id,
        pickup_location,
        dropoff_location,
        pickup_time,
        status
      FROM rides
      WHERE user_id = $1
      ORDER BY pickup_time NULLS LAST, id DESC
      LIMIT 100
    `,
      [userId]
    );

    return res.json({ rides: result.rows });
  } catch (err) {
    console.error("Error in GET /rides/user:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /rides/:id
 * Fetch a single ride by id.
 */
ridesRouter.get("/:id", async (req, res) => {
  try {
    const idNum = Number(req.params.id);
    if (!idNum || Number.isNaN(idNum)) {
      return res.status(400).json({ error: "Invalid ride id." });
    }

    const result = await pool.query<RideRow>(
      `
      SELECT
        id,
        user_id,
        pickup_location,
        dropoff_location,
        pickup_time,
        status
      FROM rides
      WHERE id = $1
      LIMIT 1
    `,
      [idNum]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Ride not found." });
    }

    return res.json({ ride: result.rows[0] });
  } catch (err) {
    console.error("Error in GET /rides/:id:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /rides/:id/status
 * Simple status endpoint (used by admin/driver UI to poll)
 */
ridesRouter.get("/:id/status", async (req, res) => {
  try {
    const idNum = Number(req.params.id);
    if (!idNum || Number.isNaN(idNum)) {
      return res.status(400).json({ error: "Invalid ride id." });
    }

    const result = await pool.query<{ status: string }>(
      `
      SELECT status
      FROM rides
      WHERE id = $1
      LIMIT 1
    `,
      [idNum]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Ride not found." });
    }

    return res.json({ status: result.rows[0].status });
  } catch (err) {
    console.error("Error in GET /rides/:id/status:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * PATCH /rides/:id/status
 * Update ride status (e.g. driver_en_route, arrived, in_progress, completed)
 * Body: { status: string }
 */
ridesRouter.patch("/:id/status", async (req, res) => {
  try {
    const idNum = Number(req.params.id);
    if (!idNum || Number.isNaN(idNum)) {
      return res.status(400).json({ error: "Invalid ride id." });
    }

    const { status } = req.body as { status?: string };
    if (!status || typeof status !== "string") {
      return res.status(400).json({ error: "Missing or invalid status." });
    }

    const allowedStatuses = [
      "pending",
      "confirmed",
      "driver_en_route",
      "arrived",
      "in_progress",
      "completed",
      "cancelled",
    ];

    if (!allowedStatuses.includes(status)) {
      return res
        .status(400)
        .json({ error: "Invalid status value.", allowedStatuses });
    }

    const update = await pool.query<RideRow>(
      `
      UPDATE rides
      SET status = $1
      WHERE id = $2
      RETURNING id, user_id, pickup_location, dropoff_location, pickup_time, status
    `,
      [status, idNum]
    );

    if (update.rows.length === 0) {
      return res.status(404).json({ error: "Ride not found." });
    }

    return res.json({ ride: update.rows[0] });
  } catch (err) {
    console.error("Error in PATCH /rides/:id/status:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});
