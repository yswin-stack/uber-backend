import { Router, Request, Response } from "express";
import { pool } from "../db/pool";
import { sendRideStatusNotification } from "../services/notifications";

const driverRouter = Router();

type DriverStatus =
  | "driver_en_route"
  | "arrived"
  | "in_progress"
  | "completed"
  | "no_show";

const ALLOWED_NEXT_STATUSES: Record<string, DriverStatus[]> = {
  confirmed: ["driver_en_route", "arrived"],
  driver_en_route: ["arrived"],
  arrived: ["in_progress", "no_show"],
  in_progress: ["completed"],
};

const FREE_WAIT_MINUTES = 2; // free wait
const WAIT_PRICE_PER_MIN_CENTS = 100; // $1.00 per minute after free

function getUserIdFromHeader(req: Request): number | null {
  const h = req.header("x-user-id");
  if (!h) return null;
  const id = parseInt(h, 10);
  return Number.isNaN(id) ? null : id;
}

async function ensureDriverOrAdmin(userId: number): Promise<"driver" | "admin"> {
  const res = await pool.query(
    `SELECT role FROM users WHERE id = $1`,
    [userId]
  );

  if (res.rowCount === 0) {
    throw new Error("user_not_found");
  }

  const role: string = res.rows[0].role || "subscriber";
  if (role !== "driver" && role !== "admin") {
    throw new Error("forbidden");
  }

  return role as "driver" | "admin";
}

function getMonthStart(date: Date): string {
  const d = new Date(date);
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function minutesBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / 60_000;
}

/**
 * GET /driver/rides/today
 * Driver daily plan (for now: single driver; future-ready for multi-driver).
 */
driverRouter.get("/rides/today", async (req: Request, res: Response) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) {
    return res.status(401).json({ error: "Missing or invalid x-user-id header." });
  }

  try {
    await ensureDriverOrAdmin(userId);
  } catch (err: any) {
    if (err.message === "user_not_found") {
      return res.status(404).json({ error: "User not found." });
    }
    if (err.message === "forbidden") {
      return res.status(403).json({ error: "Only drivers/admins can view this." });
    }
    console.error("Error in /driver/rides/today auth:", err);
    return res.status(500).json({ error: "Internal error." });
  }

  const now = new Date();
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

  try {
    const result = await pool.query(
      `
      SELECT
        id,
        user_id,
        driver_id,
        pickup_location,
        dropoff_location,
        pickup_time,
        pickup_window_start,
        pickup_window_end,
        arrival_window_start,
        arrival_window_end,
        status,
        ride_type
      FROM rides
      WHERE pickup_time >= $1
        AND pickup_time < $2
        AND status NOT IN ('cancelled', 'cancelled_by_user', 'cancelled_by_admin', 'no_show')
      ORDER BY pickup_time ASC
      `,
      [dayStart.toISOString(), dayEnd.toISOString()]
    );

    return res.json({
      ok: true,
      rides: result.rows,
    });
  } catch (err) {
    console.error("Error in GET /driver/rides/today:", err);
    return res.status(500).json({ error: "Failed to load driver rides." });
  }
});

/**
 * POST /driver/rides/:id/status
 * Body: { status: "driver_en_route" | "arrived" | "in_progress" | "completed" | "no_show" }
 *
 * - arrived   → sets arrived_at
 * - in_progress → sets in_progress_at, wait_minutes, wait_charge_cents
 * - completed → sets completed_at, late_minutes, compensation_type, auto full refund at ≥10 min late
 */
driverRouter.post(
  "/rides/:id/status",
  async (req: Request, res: Response) => {
    const userId = getUserIdFromHeader(req);
    if (!userId) {
      return res.status(401).json({ error: "Missing or invalid x-user-id header." });
    }

    const rideId = parseInt(req.params.id, 10);
    if (Number.isNaN(rideId)) {
      return res.status(400).json({ error: "Invalid ride id." });
    }

    const newStatus: DriverStatus | undefined = req.body?.status;
    if (
      !newStatus ||
      !["driver_en_route", "arrived", "in_progress", "completed", "no_show"].includes(
        newStatus
      )
    ) {
      return res.status(400).json({ error: "Invalid or missing status." });
    }

    try {
      await ensureDriverOrAdmin(userId);
    } catch (err: any) {
      if (err.message === "user_not_found") {
        return res.status(404).json({ error: "User not found." });
      }
      if (err.message === "forbidden") {
        return res.status(403).json({ error: "Only drivers/admins can update status." });
      }
      console.error("Error in /driver/rides/:id/status auth:", err);
      return res.status(500).json({ error: "Internal error." });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const rideRes = await client.query(
        `
        SELECT
          id,
          user_id,
          status,
          ride_type,
          pickup_time,
          arrival_target_time,
          arrived_at,
          in_progress_at,
          wait_minutes,
          wait_charge_cents,
          late_minutes,
          compensation_type,
          compensation_applied
        FROM rides
        WHERE id = $1
        FOR UPDATE
        `,
        [rideId]
      );

      if (rideRes.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Ride not found." });
      }

      const ride = rideRes.rows[0] as {
        id: number;
        user_id: number;
        status: string;
        ride_type: string;
        pickup_time: string | null;
        arrival_target_time: string | null;
        arrived_at: string | null;
        in_progress_at: string | null;
        wait_minutes: number;
        wait_charge_cents: number;
        late_minutes: number;
        compensation_type: string;
        compensation_applied: boolean;
      };

      const allowedNext = ALLOWED_NEXT_STATUSES[ride.status] || [];
      if (!allowedNext.includes(newStatus)) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: `Cannot change status from '${ride.status}' to '${newStatus}'.`,
        });
      }

      let updatedRideRow: any;

      //
      // STATUS HANDLERS
      //
      if (newStatus === "driver_en_route") {
        const updateRes = await client.query(
          `
          UPDATE rides
          SET status = $1,
              driver_id = COALESCE(driver_id, $2)
          WHERE id = $3
          RETURNING *
          `,
          [newStatus, userId, rideId]
        );
        updatedRideRow = updateRes.rows[0];
      } else if (newStatus === "arrived") {
        const nowIso = new Date().toISOString();
        const arrivedIso = ride.arrived_at || nowIso;

        const updateRes = await client.query(
          `
          UPDATE rides
          SET status = $1,
              driver_id = COALESCE(driver_id, $2),
              arrived_at = $3
          WHERE id = $4
          RETURNING *
          `,
          [newStatus, userId, arrivedIso, rideId]
        );
        updatedRideRow = updateRes.rows[0];
      } else if (newStatus === "in_progress") {
        const now = new Date();
        const arrivedAt =
          ride.arrived_at != null ? new Date(ride.arrived_at) : now;

        const waitMinRaw = Math.floor(
          Math.max(0, minutesBetween(arrivedAt, now))
        );
        const chargeMinutes = Math.max(0, waitMinRaw - FREE_WAIT_MINUTES);
        const waitChargeCents = chargeMinutes * WAIT_PRICE_PER_MIN_CENTS;

        const updateRes = await client.query(
          `
          UPDATE rides
          SET status = $1,
              driver_id = COALESCE(driver_id, $2),
              arrived_at = $3,
              in_progress_at = $4,
              wait_minutes = $5,
              wait_charge_cents = $6
          WHERE id = $7
          RETURNING *
          `,
          [
            newStatus,
            userId,
            arrivedAt.toISOString(),
            now.toISOString(),
            waitMinRaw,
            waitChargeCents,
            rideId,
          ]
        );
        updatedRideRow = updateRes.rows[0];
      } else if (newStatus === "completed") {
        const now = new Date();

        // Compute late minutes vs arrival_target_time
        let lateMinutes = 0;
        if (ride.arrival_target_time) {
          const target = new Date(ride.arrival_target_time);
          const diff = Math.floor(minutesBetween(target, now));
          if (diff > 0) {
            lateMinutes = diff;
          }
        }

        let compensationType = ride.compensation_type || "none";
        let compensationApplied = !!ride.compensation_applied;

        // Auto full refund at ≥10 minutes late (once only)
        if (lateMinutes >= 10 && !compensationApplied) {
          compensationType = "full_refund";

          const pickupTime = ride.pickup_time
            ? new Date(ride.pickup_time)
            : now;
          const monthStart = getMonthStart(pickupTime);
          const isGrocery = ride.ride_type === "grocery";

          const field = isGrocery ? "grocery_used" : "standard_used";

          await client.query(
            `
            UPDATE ride_credits_monthly
            SET ${field} = GREATEST(0, ${field} - 1)
            WHERE user_id = $1 AND month_start = $2
            `,
            [ride.user_id, monthStart]
          );

          compensationApplied = true;
        } else if (lateMinutes >= 5 && compensationType === "none") {
          // Mark eligible for 50% off – driver/admin can act on this later
          compensationType = "half_refund";
        }

        const updateRes = await client.query(
          `
          UPDATE rides
          SET status = $1,
              driver_id = COALESCE(driver_id, $2),
              completed_at = $3,
              late_minutes = $4,
              compensation_type = $5,
              compensation_applied = $6
          WHERE id = $7
          RETURNING *
          `,
          [
            newStatus,
            userId,
            now.toISOString(),
            lateMinutes,
            compensationType,
            compensationApplied,
            rideId,
          ]
        );
        updatedRideRow = updateRes.rows[0];
      } else if (newStatus === "no_show") {
        const nowIso = new Date().toISOString();
        const updateRes = await client.query(
          `
          UPDATE rides
          SET status = $1,
              driver_id = COALESCE(driver_id, $2),
              completed_at = $3
          WHERE id = $4
          RETURNING *
          `,
          [newStatus, userId, nowIso, rideId]
        );
        updatedRideRow = updateRes.rows[0];
      }

      await client.query("COMMIT");

      // Trigger SMS notifications for key statuses
      const smsStatuses: DriverStatus[] = [
        "driver_en_route",
        "arrived",
        "in_progress",
        "completed",
      ];

      if (newStatus !== "no_show" && smsStatuses.includes(newStatus)) {
        const pickupIso =
          updatedRideRow?.pickup_time || ride.pickup_time || null;
        await sendRideStatusNotification(
          ride.user_id,
          ride.id,
          newStatus as any,
          pickupIso
        );
      }

      return res.json({
        ok: true,
        ride: updatedRideRow,
      });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("Error in POST /driver/rides/:id/status:", err);
      return res.status(500).json({ error: "Failed to update ride status." });
    } finally {
      client.release();
    }
  }
);

export default driverRouter;
