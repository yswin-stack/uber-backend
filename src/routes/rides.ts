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


// VERY simplified subscription & credits checks for demo.
// Assumes there is ONE active subscription and unlimited credits.
// You can extend this logic later.
async function validateSubscriptionAndCredits(_userId: number, _rideType: string) {
  // TEMP: allow all bookings while you're testing.
  // Later you can implement real subscription + credits logic here.
  return { ok: true };
}


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
      is_fixed,   // boolean
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
        .status(subValidation.code || 400)
        .json({ error: subValidation.message });
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
