import { Router, Request, Response } from "express";
import { pool } from "../db/pool";
import { computeDistanceKm } from "../utils/distance";
import { sendRideStatusNotification } from "../services/notifications";
import { getAiConfig } from "../services/aiConfig";
import { estimateTravelMinutesKm } from "../services/predictiveEngine";

const ridesRouter = Router();

// Service zone: around University of Manitoba
const CAMPUS_CENTER = { lat: 49.8075, lng: -97.1325 };
const CORE_RADIUS_KM = 6; // normal rides
const GROCERY_RADIUS_KM = 10; // grocery rides

function getUserIdFromHeader(req: Request): number | null {
  const header = req.header("x-user-id");
  if (!header) return null;
  const id = parseInt(header, 10);
  return Number.isNaN(id) ? null : id;
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

/**
 * GET /rides
 *  - list rides for the logged-in user (recent history + upcoming)
 */
ridesRouter.get("/", async (req: Request, res: Response) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) {
    return res
      .status(401)
      .json({ error: "Missing or invalid x-user-id header." });
  }

  try {
    const result = await pool.query(
      `
      SELECT *
      FROM rides
      WHERE user_id = $1
      ORDER BY pickup_time DESC
      LIMIT 50
      `,
      [userId]
    );

    return res.json({ rides: result.rows });
  } catch (err) {
    console.error("Error in GET /rides:", err);
    return res.status(500).json({ error: "Failed to list rides." });
  }
});

/**
 * GET /rides/:id
 */
ridesRouter.get("/:id", async (req: Request, res: Response) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) {
    return res
      .status(401)
      .json({ error: "Missing or invalid x-user-id header." });
  }

  const rideId = parseInt(req.params.id, 10);
  if (Number.isNaN(rideId)) {
    return res.status(400).json({ error: "Invalid ride id." });
  }

  try {
    const result = await pool.query(
      `SELECT * FROM rides WHERE id = $1 AND user_id = $2`,
      [rideId, userId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Ride not found." });
    }
    return res.json({ ride: result.rows[0] });
  } catch (err) {
    console.error("Error in GET /rides/:id:", err);
    return res.status(500).json({ error: "Failed to fetch ride." });
  }
});

/**
 * POST /rides
 *
 * Core "arrive-by" booking endpoint.
 */
ridesRouter.post("/", async (req: Request, res: Response) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) {
    return res
      .status(401)
      .json({ error: "Missing or invalid x-user-id header." });
  }

  const {
    pickup_address,
    pickup_lat,
    pickup_lng,
    dropoff_address,
    dropoff_lat,
    dropoff_lng,
    is_grocery,
    arrive_by,
    pickup_time, // fallback from older UI
    notes,
  } = req.body;

  const isGrocery = Boolean(is_grocery);

  //
  // 1) Validate service zone
  //
  if (
    typeof pickup_lat !== "number" ||
    typeof pickup_lng !== "number" ||
    typeof dropoff_lat !== "number" ||
    typeof dropoff_lng !== "number"
  ) {
    return res.status(400).json({
      error:
        "Missing or invalid coordinates for pickup/drop-off. Coordinates are required.",
    });
  }

  try {
    const pickupDistance = computeDistanceKm(
      CAMPUS_CENTER.lat,
      CAMPUS_CENTER.lng,
      Number(pickup_lat),
      Number(pickup_lng)
    );
    const dropDistance = computeDistanceKm(
      CAMPUS_CENTER.lat,
      CAMPUS_CENTER.lng,
      Number(dropoff_lat),
      Number(dropoff_lng)
    );

    const allowedRadius = isGrocery ? GROCERY_RADIUS_KM : CORE_RADIUS_KM;

    if (pickupDistance > allowedRadius || dropDistance > allowedRadius) {
      return res.status(400).json({
        error: `Ride is outside allowed radius. Max ${allowedRadius} km from campus for this ride type.`,
      });
    }
  } catch (err) {
    console.error("Distance check failed:", err);
    return res
      .status(400)
      .json({ error: "Invalid coordinates for distance check." });
  }

  //
  // 2) Parse arrive-by time (fallback: pickup_time from old UI)
  //
  const arriveRaw: string | undefined = arrive_by || pickup_time;
  if (!arriveRaw) {
    return res.status(400).json({
      error: "Missing arrive_by time. Please select when you need to arrive.",
    });
  }

  const arriveBy = new Date(arriveRaw);
  if (Number.isNaN(arriveBy.getTime())) {
    return res.status(400).json({ error: "Invalid arrive_by time." });
  }

  const now = new Date();
  if (arriveBy.getTime() <= now.getTime()) {
    return res
      .status(400)
      .json({ error: "Arrival time must be in the future." });
  }

  //
  // 3) Estimate travel time between pickup & dropoff (AI-aware)
  //
  const legKm = computeDistanceKm(
    Number(pickup_lat),
    Number(pickup_lng),
    Number(dropoff_lat),
    Number(dropoff_lng)
  );

  // Load AI configuration & predictive travel estimate
  const aiConfig = getAiConfig();
  const travelEstimate = estimateTravelMinutesKm(legKm, { when: arriveBy });
  const travelMinutes = travelEstimate.travel_minutes;

  const ARRIVE_EARLY_MIN = aiConfig.arrive_early_minutes;
  const PICKUP_WINDOW_HALF_SPAN_MIN = Math.round(
    aiConfig.pickup_window_size / 2
  ); // minutes
  const ARRIVAL_WINDOW_HALF_SPAN_MIN = Math.round(
    aiConfig.arrival_window_size / 2
  );

  const pickupTimeObj = addMinutes(
    arriveBy,
    -(travelMinutes + ARRIVE_EARLY_MIN)
  );

  const pickupWindowStart = addMinutes(
    pickupTimeObj,
    -PICKUP_WINDOW_HALF_SPAN_MIN
  );
  const pickupWindowEnd = addMinutes(
    pickupTimeObj,
    PICKUP_WINDOW_HALF_SPAN_MIN
  );
  const arrivalWindowStart = addMinutes(
    arriveBy,
    -ARRIVAL_WINDOW_HALF_SPAN_MIN
  );
  const arrivalWindowEnd = addMinutes(
    arriveBy,
    ARRIVAL_WINDOW_HALF_SPAN_MIN
  );

  //
  // 4) Capacity rule: max 4 rides per hour (configurable)
  //
  const hourStart = new Date(pickupTimeObj);
  hourStart.setMinutes(0, 0, 0);
  const hourEnd = new Date(hourStart);
  hourEnd.setHours(hourEnd.getHours() + 1);

  const maxRidesPerHour = aiConfig.max_rides_per_hour || 4;

  try {
    const capResult = await pool.query(
      `
      SELECT COUNT(*) AS count
      FROM rides
      WHERE pickup_time >= $1
        AND pickup_time < $2
        AND status NOT IN ('cancelled', 'cancelled_by_user', 'cancelled_by_admin', 'no_show')
      `,
      [hourStart.toISOString(), hourEnd.toISOString()]
    );

    const count = parseInt(capResult.rows[0]?.count ?? "0", 10);
    if (count >= maxRidesPerHour) {
      return res.status(400).json({
        error:
          "That time window is fully booked. Please choose a slightly different time.",
      });
    }
  } catch (err) {
    console.error("Capacity check error:", err);
    return res
      .status(500)
      .json({ error: "Failed to check schedule capacity." });
  }

  //
  // 5) Overlap rule: no rides within ±30 minutes for the same user
  //
  const overlapBufferMinutes = aiConfig.overlap_buffer_minutes || 30;
  const overlapStart = addMinutes(pickupTimeObj, -overlapBufferMinutes);
  const overlapEnd = addMinutes(pickupTimeObj, overlapBufferMinutes);

  try {
    const overlapResult = await pool.query(
      `
      SELECT 1
      FROM rides
      WHERE user_id = $1
        AND pickup_time >= $2
        AND pickup_time <= $3
        AND status NOT IN ('cancelled', 'cancelled_by_user', 'cancelled_by_admin', 'no_show')
      LIMIT 1
      `,
      [userId, overlapStart.toISOString(), overlapEnd.toISOString()]
    );

    if ((overlapResult.rowCount ?? 0) > 0) {
      return res.status(400).json({
        error:
          "You already have a ride near that time. We avoid overlapping rides within ±30 minutes.",
      });
    }
  } catch (err) {
    console.error("Overlap check error:", err);
    return res
      .status(500)
      .json({ error: "Failed to check overlapping rides." });
  }

  //
  // 6) Validate & load subscription + credits
  //
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  );

  try {
    const subResult = await pool.query(
      `
      SELECT id, status
      FROM subscriptions
      WHERE user_id = $1
        AND current_period_start <= $2
        AND current_period_end > $2
      `,
      [userId, now.toISOString()]
    );

    if (subResult.rowCount === 0) {
      return res.status(400).json({
        error:
          "No active subscription found. Please subscribe before booking rides.",
      });
    }

    const subscription = subResult.rows[0];
    if (subscription.status !== "active") {
      return res.status(400).json({
        error: "Your subscription is not active. Please contact support.",
      });
    }

    // Ensure monthly credits row exists
    await pool.query(
      `
      INSERT INTO ride_credits_monthly (user_id, month_start)
      VALUES ($1, $2)
      ON CONFLICT (user_id, month_start) DO NOTHING
      `,
      [userId, monthStart]
    );

    const creditResult = await pool.query(
      `
      SELECT id, standard_total, standard_used, grocery_total, grocery_used
      FROM ride_credits_monthly
      WHERE user_id = $1 AND month_start = $2
      `,
      [userId, monthStart]
    );

    if (creditResult.rowCount === 0) {
      return res
        .status(500)
        .json({ error: "Failed to load or create monthly credits." });
    }

    const credits = creditResult.rows[0];

    if (!isGrocery) {
      if (credits.standard_used >= credits.standard_total) {
        return res
          .status(400)
          .json({ error: "You have no standard ride credits left this month." });
      }
    } else {
      if (credits.grocery_used >= credits.grocery_total) {
        return res
          .status(400)
          .json({ error: "You have no grocery ride credits left this month." });
      }
    }

    //
    // 7) Insert ride
    //
    const insertResult = await pool.query(
      `
      INSERT INTO rides (
        user_id,
        pickup_location,
        dropoff_location,
        pickup_lat,
        pickup_lng,
        drop_lat,
        drop_lng,
        pickup_time,
        arrival_target_time,
        pickup_window_start,
        pickup_window_end,
        arrival_window_start,
        arrival_window_end,
        type,
        notes
      )
      VALUES (
        $1, $2, $3,
        $4, $5, $6, $7,
        $8, $9, $10, $11, $12, $13,
        $14, $15
      )
      RETURNING *
      `,
      [
        userId,
        pickup_address,
        dropoff_address,
        Number(pickup_lat),
        Number(pickup_lng),
        Number(dropoff_lat),
        Number(dropoff_lng),
        pickupTimeObj.toISOString(),
        arriveBy.toISOString(),
        pickupWindowStart.toISOString(),
        pickupWindowEnd.toISOString(),
        arrivalWindowStart.toISOString(),
        arrivalWindowEnd.toISOString(),
        isGrocery ? "grocery" : "standard",
        notes ?? null,
      ]
    );

    const ride = insertResult.rows[0];

    //
    // 8) Deduct the appropriate credit
    //
    if (!isGrocery) {
      await pool.query(
        `
        UPDATE ride_credits_monthly
        SET standard_used = standard_used + 1
        WHERE id = $1
        `,
        [credits.id]
      );
    } else {
      await pool.query(
        `
        UPDATE ride_credits_monthly
        SET grocery_used = grocery_used + 1
        WHERE id = $1
        `,
        [credits.id]
      );
    }

    //
    // 9) Optional: send confirmation SMS
    //
    try {
      await sendRideStatusNotification(
        userId,
        ride.id,
        "booking_confirmed",
        ride.pickup_time
      );
    } catch (notifyErr) {
      console.warn("Failed to send booking confirmation SMS:", notifyErr);
    }

    return res.status(201).json({
      ride,
      travel_minutes: travelMinutes,
      pickup_window_start: pickupWindowStart.toISOString(),
      pickup_window_end: pickupWindowEnd.toISOString(),
      arrival_window_start: arrivalWindowStart.toISOString(),
      arrival_window_end: arrivalWindowEnd.toISOString(),
    });
  } catch (err) {
    console.error("Error in POST /rides:", err);
    return res.status(500).json({ error: "Failed to create ride." });
  }
});

/**
 * POST /rides/:id/cancel
 */
ridesRouter.post("/:id/cancel", async (req: Request, res: Response) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) {
    return res
      .status(401)
      .json({ error: "Missing or invalid x-user-id header." });
  }

  const rideId = parseInt(req.params.id, 10);
  if (Number.isNaN(rideId)) {
    return res.status(400).json({ error: "Invalid ride id." });
  }

  try {
    const rideResult = await pool.query(
      `
      SELECT *
      FROM rides
      WHERE id = $1 AND user_id = $2
      `,
      [rideId, userId]
    );

    if (rideResult.rowCount === 0) {
      return res.status(404).json({ error: "Ride not found." });
    }

    const ride = rideResult.rows[0] as {
      status: string;
      pickup_time: string | null;
    };

    if (
      ride.status === "cancelled" ||
      ride.status === "cancelled_by_user" ||
      ride.status === "cancelled_by_admin"
    ) {
      return res.status(400).json({ error: "Ride is already cancelled." });
    }

    // TODO: enforce "cancel up to 15 min before pickup" rule
    await pool.query(
      `
      UPDATE rides
      SET status = 'cancelled_by_user', cancelled_at = NOW()
      WHERE id = $1
      `,
      [rideId]
    );

    // Optional: send cancellation SMS
    try {
      await sendRideStatusNotification(
        userId,
        rideId,
        "cancelled_by_user",
        ride.pickup_time
      );
    } catch (notifyErr) {
      console.warn("Failed to send cancellation SMS:", notifyErr);
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("Error cancelling ride:", err);
    return res.status(500).json({ error: "Failed to cancel ride." });
  }
});

export { ridesRouter };
export default ridesRouter;
