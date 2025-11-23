import { Router, Request, Response } from "express";
import { pool } from "../db/pool";
import { computeDistanceKm } from "../utils/distance";

const ridesRouter = Router();

// Service zone: around University of Manitoba
const CAMPUS_CENTER = { lat: 49.8075, lng: -97.1325 };
const CORE_RADIUS_KM = 6; // normal rides
const GROCERY_RADIUS_KM = 10; // grocery rides

const MAX_RIDES_PER_HOUR = 4;           // capacity rule
const OVERLAP_BUFFER_MINUTES = 30;      // ±30 min per user

function getUserIdFromHeader(req: Request): number | null {
  const header = req.header("x-user-id");
  if (!header) return null;
  const id = parseInt(header, 10);
  return Number.isNaN(id) ? null : id;
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

function diffMinutes(a: Date, b: Date): number {
  return (a.getTime() - b.getTime()) / 60_000;
}

function getMonthStart(now: Date = new Date()): string {
  const d = new Date(now);
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * GET /rides
 * Return all rides for the logged-in user.
 */
ridesRouter.get("/", async (req: Request, res: Response) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) {
    return res.status(401).json({ error: "Missing or invalid x-user-id header." });
  }

  try {
    const result = await pool.query(
      `
      SELECT *
      FROM rides
      WHERE user_id = $1
      ORDER BY pickup_time ASC NULLS LAST, created_at DESC
      `,
      [userId]
    );

    return res.json({ rides: result.rows });
  } catch (err) {
    console.error("Error in GET /rides:", err);
    return res.status(500).json({ error: "Failed to fetch rides" });
  }
});

/**
 * GET /rides/:id
 */
ridesRouter.get("/:id", async (req: Request, res: Response) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) {
    return res.status(401).json({ error: "Missing or invalid x-user-id header." });
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
 * This is the core "arrive-by" booking endpoint.
 * It:
 *  - Validates service radius (6km / 10km grocery)
 *  - Converts arrive_by → pickup_time + pickup/arrival windows
 *  - Enforces max 4 rides/hour (single driver)
 *  - Enforces ±30 min no-overlap per user
 *  - Deducts the right credit (standard/grocery)
 */
ridesRouter.post("/", async (req: Request, res: Response) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) {
    return res.status(401).json({ error: "Missing or invalid x-user-id header." });
  }

  // Support both old and new frontend shapes
  const {
    pickup_location,
    dropoff_location,
    pickup_address,
    dropoff_address,
    pickup_lat,
    pickup_lng,
    dropoff_lat,
    dropoff_lng,
    arrive_by,
    pickup_time, // older UI used this as "pickup at"
    ride_type,
    is_grocery,
    notes,
  } = req.body || {};

  const pickupLabel: string | undefined = pickup_location || pickup_address;
  const dropLabel: string | undefined = dropoff_location || dropoff_address;

  if (!pickupLabel || !dropLabel) {
    return res
      .status(400)
      .json({ error: "Pickup and drop-off locations are required." });
  }

  if (
    pickup_lat == null ||
    pickup_lng == null ||
    dropoff_lat == null ||
    dropoff_lng == null
  ) {
    return res.status(400).json({
      error:
        "Pickup and drop-off coordinates are required (please confirm both pins on the map).",
    });
  }

  const isGrocery: boolean =
    Boolean(is_grocery) || (typeof ride_type === "string" && ride_type === "grocery");

  //
  // 1) Service radius / zone check
  //
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
    return res.status(400).json({ error: "Invalid coordinates for distance check." });
  }

  //
  // 2) Parse arrive-by time
  //    For now, if frontend hasn't switched to arrive_by yet, we treat
  //    pickup_time as arrive_by (will be updated on the frontend side later).
  //
  const arriveRaw: string | undefined = arrive_by || pickup_time;
  if (!arriveRaw) {
    return res.status(400).json({
      error: "Missing arrive_by time. Please select when you need to arrive.",
    });
  }

  const arriveBy = new Date(arriveRaw);
  if (Number.isNaN(arriveBy.getTime())) {
    return res.status(400).json({ error: "Invalid arrive_by timestamp." });
  }

  const now = new Date();
  if (arriveBy.getTime() <= now.getTime()) {
    return res
      .status(400)
      .json({ error: "Arrival time must be in the future." });
  }

  //
  // 3) Estimate travel time between pickup & dropoff
  //
  const legKm = computeDistanceKm(
    Number(pickup_lat),
    Number(pickup_lng),
    Number(dropoff_lat),
    Number(dropoff_lng)
  );

  // Simple baseline, later AI will refine this with weather/traffic
  const SPEED_KMH = 25; // ~city driving
  const baseMinutes = Math.max(6, (legKm / SPEED_KMH) * 60); // at least 6 minutes
  const travelMinutes = Math.ceil(baseMinutes);

  const ARRIVE_EARLY_MIN = 5; // promise: aim to arrive 5 min early
  const PICKUP_WINDOW_HALF_SPAN_MIN = 5; // ±5 min
  const ARRIVAL_WINDOW_HALF_SPAN_MIN = 5; // ±5 min

  // We want to arrive ~5 min before requested arrival
  const pickupTime = addMinutes(arriveBy, -(travelMinutes + ARRIVE_EARLY_MIN));

  const pickupWindowStart = addMinutes(pickupTime, -PICKUP_WINDOW_HALF_SPAN_MIN);
  const pickupWindowEnd = addMinutes(pickupTime, PICKUP_WINDOW_HALF_SPAN_MIN);
  const arrivalWindowStart = addMinutes(arriveBy, -ARRIVAL_WINDOW_HALF_SPAN_MIN);
  const arrivalWindowEnd = addMinutes(arriveBy, ARRIVAL_WINDOW_HALF_SPAN_MIN);

  //
  // 4) Capacity rule: max 4 rides per hour (single driver)
  //
  const hourStart = new Date(pickupTime);
  hourStart.setMinutes(0, 0, 0);
  const hourEnd = new Date(hourStart);
  hourEnd.setHours(hourEnd.getHours() + 1);

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
    if (count >= MAX_RIDES_PER_HOUR) {
      return res.status(400).json({
        error:
          "That time window is fully booked. Please choose a slightly different time.",
      });
    }
  } catch (err) {
    console.error("Capacity check error:", err);
    return res.status(500).json({ error: "Failed to check schedule capacity." });
  }

  //
  // 5) Overlap rule: no rides within ±30 minutes for the same user
  //
  const overlapStart = addMinutes(pickupTime, -OVERLAP_BUFFER_MINUTES);
  const overlapEnd = addMinutes(pickupTime, OVERLAP_BUFFER_MINUTES);

  try {
    const overlapResult = await pool.query(
      `
      SELECT 1
      FROM rides
      WHERE user_id = $1
        AND pickup_time IS NOT NULL
        AND pickup_time >= $2
        AND pickup_time <= $3
        AND status NOT IN ('cancelled', 'cancelled_by_user', 'cancelled_by_admin', 'no_show')
      LIMIT 1
      `,
      [userId, overlapStart.toISOString(), overlapEnd.toISOString()]
    );

    if (overlapResult.rowCount > 0) {
      return res.status(400).json({
        error:
          "You already have a ride close to that time. Rides must be at least 30 minutes apart.",
      });
    }
  } catch (err) {
    console.error("Overlap check error:", err);
    return res.status(500).json({ error: "Failed to check overlapping rides." });
  }

  //
  // 6) Ensure monthly credits row & verify available credit
  //
  const monthStart = getMonthStart(now);

  try {
    // Ensure row exists (upsert)
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
          .json({ error: "No standard ride credits left this month." });
      }
    } else {
      if (credits.grocery_used >= credits.grocery_total) {
        return res
          .status(400)
          .json({ error: "No grocery ride credits left this month." });
      }
    }

    //
    // 7) Insert the ride with computed windows
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
        ride_type,
        status,
        notes
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'confirmed',$15
      )
      RETURNING *
      `,
      [
        userId,
        pickupLabel,
        dropLabel,
        pickup_lat,
        pickup_lng,
        dropoff_lat,
        dropoff_lng,
        pickupTime.toISOString(),
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

    return res.status(201).json({ ride });
  } catch (err) {
    console.error("Error creating ride:", err);
    return res.status(500).json({ error: "Failed to create ride." });
  }
});

/**
 * POST /rides/:id/cancel
 * Rider cancels; must be ≥15 minutes before pickup_time.
 */
ridesRouter.post("/:id/cancel", async (req: Request, res: Response) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) {
    return res.status(401).json({ error: "Missing or invalid x-user-id header." });
  }

  const rideId = parseInt(req.params.id, 10);
  if (Number.isNaN(rideId)) {
    return res.status(400).json({ error: "Invalid ride id." });
  }

  try {
    const result = await pool.query(
      `
      SELECT id, pickup_time, status
      FROM rides
      WHERE id = $1 AND user_id = $2
      `,
      [rideId, userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Ride not found." });
    }

    const ride = result.rows[0];

    if (!ride.pickup_time) {
      return res
        .status(400)
        .json({ error: "Ride does not yet have a pickup time set." });
    }

    const now = new Date();
    const pickupTime = new Date(ride.pickup_time);
    const minutesUntilPickup = diffMinutes(pickupTime, now);

    if (minutesUntilPickup < 15) {
      return res.status(400).json({
        error: "Rides can only be cancelled up to 15 minutes before pickup.",
      });
    }

    await pool.query(
      `
      UPDATE rides
      SET status = 'cancelled_by_user',
          cancelled_at = NOW()
      WHERE id = $1
      `,
      [rideId]
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("Error cancelling ride:", err);
    return res.status(500).json({ error: "Failed to cancel ride." });
  }
});

export { ridesRouter };
export default ridesRouter;

