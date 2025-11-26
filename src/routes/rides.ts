import { Router, Request, Response } from "express";
import { pool } from "../db/pool";
import { computeDistanceKm } from "../utils/distance";
import { sendRideStatusNotification } from "../services/notifications";
import { getAiConfig } from "../services/aiConfig";
import { estimateTravelMinutesKm } from "../services/predictiveEngine";
import { ok, fail } from "../lib/apiResponse";
import { requireAuth } from "../middleware/auth";
import { isInPeakWindow } from "../lib/peak";
import { getActiveSubscription } from "../services/subscriptionService";
import type { RideStatus } from "../shared/types";

import {
  canTransition,
  logRideEvent,
  type RideActorType,
} from "../services/rideStatus";
import { logEvent } from "../services/analytics";

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
 *  - now secured via JWT (requireAuth) and req.user.id
 */
ridesRouter.get("/", requireAuth, async (req: Request, res: Response) => {
  const authUser = req.user;
  if (!authUser) {
    return res
      .status(401)
      .json(fail("AUTH_REQUIRED", "Please log in to view your rides."));
  }

  const userId = authUser.id;

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

    return res.json(ok(result.rows));
  } catch (err) {
    console.error("Error in GET /rides:", err);
    return res
      .status(500)
      .json(fail("RIDES_LIST_FAILED", "Failed to list rides."));
  }
});

/**
 * GET /rides/:id
 */
ridesRouter.get("/:id", requireAuth, async (req: Request, res: Response) => {
  const authUser = req.user;
  if (!authUser) {
    return res
      .status(401)
      .json(fail("AUTH_REQUIRED", "Please log in to view this ride."));
  }

  const userId = authUser.id;
  const rideId = parseInt(req.params.id, 10);

  if (Number.isNaN(rideId)) {
    return res.status(400).json(fail("INVALID_RIDE_ID", "Invalid ride id."));
  }

  try {
    const result = await pool.query(
      `SELECT * FROM rides WHERE id = $1 AND user_id = $2`,
      [rideId, userId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json(fail("RIDE_NOT_FOUND", "Ride not found."));
    }
    // Keep success shape similar to V1: { ride: ... }
    return res.json({ ride: result.rows[0] });
  } catch (err) {
    console.error("Error in GET /rides/:id:", err);
    return res
      .status(500)
      .json(fail("RIDE_FETCH_FAILED", "Failed to fetch ride."));
  }
});

/**
 * POST /rides
 *
 * Core "arrive-by" booking endpoint.
 */
ridesRouter.post("/", requireAuth, async (req: Request, res: Response) => {
  const authUser = req.user;
  if (!authUser) {
    return res
      .status(401)
      .json({ error: "Please log in before booking a ride." });
  }

  const userId = authUser.id;

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

  const aiConfig = getAiConfig();
  const travelEstimate = estimateTravelMinutesKm(legKm, { when: arriveBy });
  const travelMinutes = travelEstimate.travel_minutes;

  const ARRIVE_EARLY_MIN = aiConfig.arrive_early_minutes;
  const PICKUP_WINDOW_HALF_SPAN_MIN = Math.round(
    aiConfig.pickup_window_size / 2
  );
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
  // 3.5) Peak window enforcement (Premium-only access)
  //
  try {
    const inPeak = isInPeakWindow(pickupTimeObj);
    if (inPeak) {
      const active = await getActiveSubscription(userId);
      const hasPeakAccess = !!(active && active.plan.peak_access);

      if (!hasPeakAccess) {
        return res.status(400).json({
          error:
            "This time is reserved for Premium riders. Choose a different time or upgrade your plan.",
        });
      }
    }
  } catch (err) {
    console.error("Peak check error:", err);
    return res.status(500).json({
      error:
        "Failed to validate your plan for this time. Please try again or choose a different time.",
    });
  }

  //
  // 4) Capacity rule: max X rides per hour (from AI config, default 4)
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
        return res.status(400).json({
          error: "You have no standard ride credits left this month.",
        });
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
    //    New rides are immediately considered "scheduled" if they pass all validations.
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
        notes,
        status
      )
      VALUES (
        $1, $2, $3,
        $4, $5, $6, $7,
        $8, $9, $10, $11, $12, $13,
        $14, $15,
        'scheduled'
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
    // 8) Deduct the appropriate credit (simple: deduct on creation)
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

    // Analytics: ride_created
    try {
      await logEvent("ride_created", {
        rideId: ride.id,
        userId,
        type: isGrocery ? "grocery" : "standard",
        pickup_time: ride.pickup_time,
        arrival_target_time: ride.arrival_target_time,
      });
    } catch (logErr) {
      console.warn("[analytics] Failed to log ride_created:", logErr);
    }

    // Keep response shape identical to V1 so frontend continues to work
    return res.status(201).json({
      ride,
      travel_minutes: travelMinutes,
      pickup_window_start: pickupWindowStart.toISOString(),
      pickup_window_end: pickupWindowEnd.toISOString(),
      arrival_window_start: arrivalWindowStart.toISOString(),
      arrival_window_end: arrivalWindowEnd.toISOString(),
    });
  } catch (err: any) {
    console.error("Error in POST /rides:", err);

    const message =
      (err && err.message) ||
      (typeof err === "string" ? err : null) ||
      "Failed to create ride.";

    return res.status(500).json(fail("RIDE_CREATE_FAILED", message));
  }
});

/**
 * POST /rides/:id/status
 *
 * Body: { newStatus: RideStatus }
 *
 * Used by driver/admin to move a ride through:
 *  pending -> driver_en_route -> arrived -> in_progress -> completed
 * and to cancel as driver/admin.
 */
ridesRouter.post(
  "/:id/status",
  requireAuth,
  async (req: Request, res: Response) => {
    const authUser = req.user!;
    const rideId = parseInt(req.params.id, 10);

    if (Number.isNaN(rideId)) {
      return res
        .status(400)
        .json(fail("INVALID_RIDE_ID", "Invalid ride id."));
    }

    const { newStatus } = req.body as { newStatus?: RideStatus };

    if (!newStatus) {
      return res
        .status(400)
        .json(
          fail("NEW_STATUS_REQUIRED", "newStatus field is required.")
        );
    }

    // Only driver/admin may call this endpoint (riders use /cancel)
    const role = authUser.role;
    if (role !== "driver" && role !== "admin") {
      return res.status(403).json(
        fail(
          "FORBIDDEN",
          "Only driver or admin may update ride status via this endpoint."
        )
      );
    }

    let actorType: RideActorType = "driver";
    if (role === "admin") actorType = "admin";

    try {
      const rideRes = await pool.query(
        `
        SELECT id, user_id, status
        FROM rides
        WHERE id = $1
        `,
        [rideId]
      );

      if (rideRes.rowCount === 0) {
        return res
          .status(404)
          .json(fail("RIDE_NOT_FOUND", "Ride not found."));
      }

      const ride = rideRes.rows[0] as {
        id: number;
        user_id: number;
        status: RideStatus;
      };

      const oldStatus = ride.status;

      // Validate state machine transition
      if (!canTransition(oldStatus, newStatus)) {
        return res.status(400).json(
          fail(
            "INVALID_STATUS_TRANSITION",
            `Cannot transition from ${oldStatus} to ${newStatus}.`
          )
        );
      }

      // Update ride status
      const updateRes = await pool.query(
        `
        UPDATE rides
        SET status = $1
        WHERE id = $2
        RETURNING *
        `,
        [newStatus, rideId]
      );

      const updated = updateRes.rows[0];

      // Log lifecycle event
      await logRideEvent({
        rideId,
        oldStatus,
        newStatus,
        actorType,
        actorId: authUser.id,
      });

      return res.json(ok(updated));
    } catch (err) {
      console.error("Error in POST /rides/:id/status:", err);
      return res
        .status(500)
        .json(
          fail(
            "RIDE_STATUS_UPDATE_FAILED",
            "Failed to update ride status."
          )
        );
    }
  }
);

/**
 * POST /rides/:id/cancel
 *
 *  - Marks ride cancelled_by_user.
 *  - If cancelled at least cancel_refund_cutoff_minutes before pickup, refund 1 credit.
 */
ridesRouter.post(
  "/:id/cancel",
  requireAuth,
  async (req: Request, res: Response) => {
    const authUser = req.user;
    if (!authUser) {
      return res
        .status(401)
        .json({ error: "Please log in before cancelling a ride." });
    }

    const userId = authUser.id;
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
        id: number;
        status: string;
        pickup_time: string | null;
        ride_type: string | null;
      };

      if (
        ride.status === "cancelled" ||
        ride.status === "cancelled_by_user" ||
        ride.status === "cancelled_by_admin"
      ) {
        return res.status(400).json({ error: "Ride is already cancelled." });
      }

      const aiConfig = getAiConfig();
      const cutoffMinutes = aiConfig.cancel_refund_cutoff_minutes || 30;

      let shouldRefund = false;
      if (ride.pickup_time) {
        const pickupDate = new Date(ride.pickup_time);
        if (!Number.isNaN(pickupDate.getTime())) {
          const now = new Date();
          const diffMinutes =
            (pickupDate.getTime() - now.getTime()) / (60 * 1000);
          if (diffMinutes >= cutoffMinutes) {
            shouldRefund = true;
          }
        }
      }

      // Mark ride as cancelled_by_user
      await pool.query(
        `
        UPDATE rides
        SET status = 'cancelled_by_user', cancelled_at = NOW()
        WHERE id = $1
        `,
        [rideId]
      );

      // Log lifecycle event for auditing
      try {
        await logRideEvent({
          rideId,
          oldStatus: ride.status as RideStatus,
          newStatus: "cancelled_by_user",
          actorType: "rider",
          actorId: userId,
        });
      } catch (logErr) {
        console.warn(
          "Failed to log cancellation event for ride %s:",
          rideId,
          logErr
        );
      }

      // Optional: refund credit if cancelling early enough
      if (shouldRefund && ride.ride_type) {
        try {
          const now = new Date();
          const monthStart = new Date(
            Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
          );

          if (ride.ride_type === "grocery") {
            await pool.query(
              `
              UPDATE ride_credits_monthly
              SET grocery_used = GREATEST(grocery_used - 1, 0)
              WHERE user_id = $1 AND month_start = $2
              `,
              [userId, monthStart]
            );
          } else {
            // treat any non-grocery type as standard
            await pool.query(
              `
              UPDATE ride_credits_monthly
              SET standard_used = GREATEST(standard_used - 1, 0)
              WHERE user_id = $1 AND month_start = $2
              `,
              [userId, monthStart]
            );
          }
        } catch (refundErr) {
          console.warn(
            "Failed to refund credit on cancellation (ride_id=%s):",
            rideId,
            refundErr
          );
        }
      }

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

      // Analytics: ride_cancelled (by user)
      try {
        await logEvent("ride_cancelled", {
          rideId,
          userId,
          by: "user",
        });
      } catch (logErr) {
        console.warn(
          "[analytics] Failed to log ride_cancelled (user):",
          logErr
        );
      }

      return res.json({ ok: true });
    } catch (err) {
      console.error("Error cancelling ride:", err);
      return res.status(500).json({ error: "Failed to cancel ride." });
    }
  }
);

export { ridesRouter };
export default ridesRouter;
