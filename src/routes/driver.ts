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
  const result = await pool.query(
    `
    SELECT role
    FROM users
    WHERE id = $1
    `,
    [userId]
  );

  if (result.rowCount === 0) {
    throw new Error("user_not_found");
  }

  const role = result.rows[0].role;
  if (role !== "driver" && role !== "admin") {
    throw new Error("forbidden");
  }

  return role;
}

/**
 * Convert Date → YYYY-MM-DD (UTC)
 */
function toUtcDateString(d: Date): string {
  const copy = new Date(d.getTime());
  copy.setUTCHours(0, 0, 0, 0);
  return copy.toISOString().slice(0, 10);
}

/**
 * GET /driver/rides/today
 * Driver daily plan (for now: single driver; future-ready for multi-driver).
 */
driverRouter.get("/rides/today", async (req: Request, res: Response) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) {
    return res
      .status(401)
      .json({ error: "Missing or invalid x-user-id header." });
  }

  try {
    await ensureDriverOrAdmin(userId);
  } catch (err: any) {
    if (err.message === "user_not_found") {
      return res.status(404).json({ error: "User not found." });
    }
    if (err.message === "forbidden") {
      return res
        .status(403)
        .json({ error: "Only drivers/admins can view this." });
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
        r.id,
        r.user_id,
        r.driver_id,
        r.pickup_location,
        r.dropoff_location,
        r.pickup_time,
        r.pickup_window_start,
        r.pickup_window_end,
        r.arrival_window_start,
        r.arrival_window_end,
        r.status,
        r.ride_type,
        r.notes,
        u.name AS rider_name,
        u.phone AS rider_phone
      FROM rides r
      JOIN users u ON u.id = r.user_id
      WHERE r.pickup_time >= $1
        AND r.pickup_time < $2
        AND r.status NOT IN (
          'cancelled',
          'cancelled_by_user',
          'cancelled_by_admin',
          'no_show'
        )
      ORDER BY r.pickup_time ASC
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
 * GET /driver/rides/requests
 *
 * For (future) on-demand style rides: show rides that are still pending and
 * not yet taken by a driver.
 */
driverRouter.get(
  "/rides/requests",
  async (req: Request, res: Response) => {
    const userId = getUserIdFromHeader(req);
    if (!userId) {
      return res
        .status(401)
        .json({ error: "Missing or invalid x-user-id header." });
    }

    try {
      await ensureDriverOrAdmin(userId);
    } catch (err: any) {
      if (err.message === "user_not_found") {
        return res.status(404).json({ error: "User not found." });
      }
      if (err.message === "forbidden") {
        return res
          .status(403)
          .json({ error: "Only drivers/admins can view this." });
      }
      console.error("Error in /driver/rides/requests auth:", err);
      return res.status(500).json({ error: "Internal error." });
    }

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
          ride_type,
          notes
        FROM rides
        WHERE status = 'pending'
        ORDER BY pickup_time ASC
        `
      );

      return res.json({
        ok: true,
        rides: result.rows,
      });
    } catch (err) {
      console.error("Error in GET /driver/rides/requests:", err);
      return res
        .status(500)
        .json({ error: "Failed to load driver ride requests." });
    }
  }
);

/**
 * POST /driver/rides/:id/status
 * Body: { status: "driver_en_route" | "arrived" | "in_progress" | "completed" | "no_show" }
 *
 * - arrived   → sets arrived_at
 * - in_progress → sets in_progress_at,
 * - completed → sets completed_at
 * - no_show  → sets no_show_at
 *
 * Also handles simple wait-time + late compensation logic.
 */
driverRouter.post(
  "/rides/:id/status",
  async (req: Request, res: Response) => {
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

    const newStatus: DriverStatus | undefined = req.body?.status;
    if (
      !newStatus ||
      !["driver_en_route", "arrived", "in_progress", "completed", "no_show"].includes(
        newStatus
      )
    ) {
      return res.status(400).json({ error: "Invalid or missing status." });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      // Load ride with FOR UPDATE
      const rideRes = await client.query(
        `
        SELECT
          r.*,
          u.phone AS rider_phone
        FROM rides r
        JOIN users u ON u.id = r.user_id
        WHERE r.id = $1
        FOR UPDATE
        `,
        [rideId]
      );

      if (rideRes.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Ride not found." });
      }

      const ride = rideRes.rows[0] as any;

      // Basic allowed transition check
      const currentStatus: DriverStatus | "pending" | "scheduled" =
        ride.status ?? "pending";

      const allowedNext = ALLOWED_NEXT_STATUSES[currentStatus as DriverStatus];
      if (!allowedNext || !allowedNext.includes(newStatus)) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: `Cannot transition from ${currentStatus} to ${newStatus}.`,
        });
      }

      const now = new Date();

      let arrivedAt = ride.arrived_at
        ? new Date(ride.arrived_at)
        : null;
      let inProgressAt = ride.in_progress_at
        ? new Date(ride.in_progress_at)
        : null;
      let completedAt = ride.completed_at
        ? new Date(ride.completed_at)
        : null;
      let noShowAt = ride.no_show_at
        ? new Date(ride.no_show_at)
        : null;

      if (newStatus === "driver_en_route") {
        // Nothing special for now; just status transition
      } else if (newStatus === "arrived") {
        arrivedAt = now;
      } else if (newStatus === "in_progress") {
        if (!arrivedAt) {
          arrivedAt = now;
        }
        inProgressAt = now;
      } else if (newStatus === "completed") {
        if (!inProgressAt) {
          inProgressAt = now;
        }
        completedAt = now;
      } else if (newStatus === "no_show") {
        noShowAt = now;
      }

      // Wait time billing logic when transitioning from arrived → in_progress|no_show
      let waitMinutes = ride.wait_minutes ?? 0;
      let waitChargeCents = ride.wait_charge_cents ?? 0;

      if (arrivedAt && newStatus === "in_progress") {
        const diffMs = now.getTime() - arrivedAt.getTime();
        const diffMin = Math.max(0, Math.round(diffMs / 60_000));
        if (diffMin > FREE_WAIT_MINUTES) {
          const billable = diffMin - FREE_WAIT_MINUTES;
          waitMinutes = diffMin;
          waitChargeCents = billable * WAIT_PRICE_PER_MIN_CENTS;
        }
      }

      // Persist updates
      const updateRes = await client.query(
        `
        UPDATE rides
        SET
          status = $1,
          arrived_at = COALESCE($2, arrived_at),
          in_progress_at = COALESCE($3, in_progress_at),
          completed_at = COALESCE($4, completed_at),
          no_show_at = COALESCE($5, no_show_at),
          wait_minutes = $6,
          wait_charge_cents = $7
        WHERE id = $8
        RETURNING *
        `,
        [
          newStatus,
          arrivedAt ? arrivedAt.toISOString() : null,
          inProgressAt ? inProgressAt.toISOString() : null,
          completedAt ? completedAt.toISOString() : null,
          noShowAt ? noShowAt.toISOString() : null,
          waitMinutes,
          waitChargeCents,
          rideId,
        ]
      );

      const updatedRideRow = updateRes.rows[0];

      await client.query("COMMIT");

      // Notification hook
      try {
        await sendRideStatusNotification(
          ride.user_id,
          ride.id,
          newStatus,
          ride.pickup_time
        );
      } catch (notifyErr) {
        console.warn(
          "Failed to send ride status notification for ride %s:",
          rideId,
          notifyErr
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
