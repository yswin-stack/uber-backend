import { Router } from "express";
import { pool } from "../db/pool";
import { authMiddleware } from "../middleware/auth";
import { computeDistanceKm } from "../utils/distance";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";

dayjs.extend(utc);

export const ridesRouter = Router();

/**
 * GET /rides
 * Return all rides for the logged-in user
 */
ridesRouter.get("/", authMiddleware, async (req: any, res) => {
  const userId = req.user.id;

  try {
    const result = await pool.query(
      `SELECT * FROM rides 
       WHERE user_id = $1 
       ORDER BY pickup_time ASC`,
      [userId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error("GET /rides error:", error);
    res.status(500).json({ error: "Failed to fetch rides" });
  }
});

/**
 * GET /rides/:id
 */
ridesRouter.get("/:id", authMiddleware, async (req: any, res) => {
  const userId = req.user.id;
  const rideId = Number(req.params.id);

  try {
    const result = await pool.query(
      `SELECT * FROM rides WHERE id=$1 AND user_id=$2`,
      [rideId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Ride not found" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("GET /rides/:id error:", error);
    res.status(500).json({ error: "Failed to fetch ride" });
  }
});

/**
 * POST /rides
 * Creates a ride after validating:
 * - distance within 6 km radius (10 km for grocery)
 * - user has enough credits
 * - pickup_time >= now
 */
ridesRouter.post("/", authMiddleware, async (req: any, res) => {
  const userId = req.user.id;
  const {
    pickup_location,
    dropoff_location,
    pickup_lat,
    pickup_lng,
    drop_lat,
    drop_lng,
    arrive_by,
    is_grocery = false
  } = req.body;

  try {
    //
    // 1. Validate distance (6 km default, 10 km if grocery)
    //
    const campusCenter = {
      lat: 49.8075,
      lng: -97.1325,
    };

    const pickupDistance = computeDistanceKm(
      campusCenter.lat,
      campusCenter.lng,
      pickup_lat,
      pickup_lng
    );

    const allowed = is_grocery ? 10.0 : 6.0;
    if (pickupDistance > allowed) {
      return res.status(400).json({
        error: `Pickup outside allowed radius. Max ${allowed} km.`,
      });
    }

    //
    // 2. Ensure user has credits
    //
    const monthStart = dayjs.utc().startOf("month").format("YYYY-MM-DD");

    const creditResult = await pool.query(
      `
      SELECT * FROM ride_credits_monthly
      WHERE user_id=$1 AND month_start=$2
      `,
      [userId, monthStart]
    );

    let credits = creditResult.rows[0];

    if (!credits) {
      // Insert default 40+4
      const insert = await pool.query(
        `
        INSERT INTO ride_credits_monthly (
          user_id, month_start, standard_total, standard_used, grocery_total, grocery_used
        ) VALUES ($1, $2, 40, 0, 4, 0)
        RETURNING *
        `,
        [userId, monthStart]
      );
      credits = insert.rows[0];
    }

    // Check credit availability
    if (!is_grocery) {
      if (credits.standard_used >= credits.standard_total) {
        return res.status(400).json({ error: "No standard ride credits left." });
      }
    } else {
      if (credits.grocery_used >= credits.grocery_total) {
        return res.status(400).json({ error: "No grocery credits left." });
      }
    }

    //
    // 3. Insert the ride (simple version — scheduling algorithm comes in step 3/10+)
    //
    const parsedPickupTime = dayjs(arrive_by).utc();

    if (!parsedPickupTime.isValid()) {
      return res.status(400).json({ error: "Invalid arrive_by timestamp." });
    }

    const rideInsert = await pool.query(
      `
      INSERT INTO rides (
        user_id,
        pickup_location,
        dropoff_location,
        pickup_lat,
        pickup_lng,
        pickup_time,
        ride_type,
        status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,'confirmed')
      RETURNING *
      `,
      [
        userId,
        pickup_location,
        dropoff_location,
        pickup_lat,
        pickup_lng,
        parsedPickupTime.toISOString(),
        is_grocery ? "grocery" : "standard"
      ]
    );

    const ride = rideInsert.rows[0];

    //
    // 4. Deduct credit
    //
    if (is_grocery) {
      await pool.query(
        `
        UPDATE ride_credits_monthly
        SET grocery_used = grocery_used + 1
        WHERE id=$1
        `,
        [credits.id]
      );
    } else {
      await pool.query(
        `
        UPDATE ride_credits_monthly
        SET standard_used = standard_used + 1
        WHERE id=$1
        `,
        [credits.id]
      );
    }

    return res.json(ride);
  } catch (error) {
    console.error("POST /rides error:", error);
    res.status(500).json({ error: "Failed to create ride" });
  }
});

/**
 * POST /rides/:id/cancel
 */
ridesRouter.post("/:id/cancel", authMiddleware, async (req: any, res) => {
  const userId = req.user.id;
  const rideId = Number(req.params.id);

  try {
    const result = await pool.query(
      `SELECT * FROM rides WHERE id=$1 AND user_id=$2`,
      [rideId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Ride not found" });
    }

    const ride = result.rows[0];

    // If pickup is within 15 minutes, deny cancellation.
    const now = dayjs.utc();
    const rideTime = dayjs.utc(ride.pickup_time);

    if (rideTime.diff(now, "minute") < 15) {
      return res.status(400).json({
        error: "Cannot cancel within 15 minutes of pickup time.",
      });
    }

    // Mark ride cancelled
    await pool.query(
      `UPDATE rides SET status='cancelled_by_user', cancelled_at=NOW() WHERE id=$1`,
      [rideId]
    );

    return res.json({ success: true });
  } catch (error) {
    console.error("POST /rides/:id/cancel error:", error);
    res.status(500).json({ error: "Failed to cancel ride" });
  }
});
