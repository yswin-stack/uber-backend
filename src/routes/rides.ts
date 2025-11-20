import { Router, Response } from "express";
import { pool } from "../db/pool";
import { AuthRequest } from "../middlewares/auth";

export const ridesRouter = Router();

// Simple helper to check overlapping rides within ±30 minutes
async function hasOverlappingRide(userId: number, pickupTime: Date): Promise<boolean> {
  const thirtyMinMs = 30 * 60 * 1000;
  const from = new Date(pickupTime.getTime() - thirtyMinMs);
  const to = new Date(pickupTime.getTime() + thirtyMinMs);

  const result = await pool.query(
    `
    SELECT 1
    FROM rides
    WHERE user_id = $1
      AND pickup_time BETWEEN $2 AND $3
      AND status NOT IN ('cancelled', 'completed')
    LIMIT 1
    `,
    [userId, from.toISOString(), to.toISOString()]
  );

  return (result.rowCount ?? 0) > 0;
}

// TEMP: allow all bookings while you're testing.
// Later you can implement real subscription + credits logic here.
async function validateSubscriptionAndCredits(_userId: number, _rideType: string) {
  return { ok: true };
}

/**
 * POST /rides
 * Create a new ride booking.
 */
ridesRouter.post("/", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const {
      pickup_location,
      dropoff_location,
      pickup_time,
      ride_type, // 'standard' | 'grocery'
      is_fixed, // boolean
    } = req.body || {};

    if (!pickup_location || !dropoff_location || !pickup_time || !ride_type) {
      return res.status(400).json({ error: "Missing required fields." });
    }

    const pickupTime = new Date(pickup_time);
    if (Number.isNaN(pickupTime.getTime())) {
      return res.status(400).json({ error: "Invalid pickup_time." });
    }

    // Fixed rides must be created at least 1 day before pickup
    if (is_fixed) {
      const now = new Date();
      const diffMs = pickupTime.getTime() - now.getTime();
      const oneDayMs = 24 * 60 * 60 * 1000;
      if (diffMs < oneDayMs) {
        return res.status(400).json({
          error: "Fixed rides must be booked at least 1 day in advance.",
        });
      }
    }

    // Mock radius check (within 5km of university) - always true for now
    const isWithinRadius = true;
    if (!isWithinRadius) {
      return res.status(400).json({
        error: "Pickup and dropoff must be within the service area.",
      });
    }

    // Overlapping ride check
    const overlap = await hasOverlappingRide(userId, pickupTime);
    if (overlap) {
      return res.status(409).json({
        error: "You already have a ride scheduled around this time.",
      });
    }

    // Subscription and credits
    const subValidation = await validateSubscriptionAndCredits(userId, ride_type);
    if (!subValidation.ok) {
      return res
        .status(400)
        .json({ error: "Subscription or credits are not valid for this ride." });
    }

    // Create ride
    const result = await pool.query(
      `
      INSERT INTO rides (
        user_id,
        pickup_location,
        dropoff_location,
        pickup_time,
        ride_type,
        is_fixed,
        status,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'pending', now())
      RETURNING *
      `,
      [
        userId,
        pickup_location,
        dropoff_location,
        pickupTime.toISOString(),
        ride_type,
        !!is_fixed,
      ]
    );

    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("Error in POST /rides", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /rides/admin
 * Admin view: returns all rides ordered by pickup_time.
 */
ridesRouter.get("/admin", async (_req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(
      `
      SELECT
        id,
        user_id,
        pickup_location,
        dropoff_location,
        pickup_time,
        ride_type,
        is_fixed,
        status,
        created_at
      FROM rides
      ORDER BY pickup_time ASC;
      `
    );

    return res.json(result.rows);
  } catch (err) {
    console.error("Error in GET /rides/admin", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Allowed ride statuses
const ALLOWED_STATUSES = [
  "pending",
  "driver_en_route",
  "arrived",
  "in_progress",
  "completed",
  "cancelled",
] as const;
type RideStatus = (typeof ALLOWED_STATUSES)[number];

/**
 * PATCH /rides/:id/status
 * Admin: update the status of a ride (e.g. confirm, completed, cancelled).
 */
ridesRouter.patch("/:id/status", async (req: AuthRequest, res: Response) => {
  try {
    const rideId = Number(req.params.id);
    const { status } = req.body as { status?: string };

    if (!rideId || Number.isNaN(rideId)) {
      return res.status(400).json({ error: "Invalid ride id." });
    }

    if (!status || !ALLOWED_STATUSES.includes(status as RideStatus)) {
      return res.status(400).json({ error: "Invalid or missing status." });
    }

    const result = await pool.query(
      `
      UPDATE rides
      SET status = $1
      WHERE id = $2
      RETURNING
        id,
        user_id,
        pickup_location,
        dropoff_location,
        pickup_time,
        ride_type,
        is_fixed,
        status,
        created_at
      `,
      [status, rideId]
    );

    if ((result.rowCount ?? 0) === 0) {
      return res.status(404).json({ error: "Ride not found." });
    }

    // Later we can emit a Socket.IO event here to notify tracking screens.
    // e.g. io.to(\`ride:${rideId}\`).emit("ride_status_update", { rideId, status });

    return res.json(result.rows[0]);
  } catch (err) {
    console.error("Error in PATCH /rides/:id/status", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

