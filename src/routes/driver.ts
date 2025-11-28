import { Router, Request, Response } from "express";
import { pool } from "../db/pool";
import {
  sendRideStatusNotification,
  type RideStatusNotificationEvent,
} from "../services/notifications";
import { logEvent } from "../services/analytics";

const driverRouter = Router();

type DriverStatus =
  | "driver_en_route"
  | "arrived"
  | "in_progress"
  | "completed"
  | "no_show";

const ALLOWED_NEXT_STATUSES: Record<string, DriverStatus[]> = {
  confirmed: ["driver_en_route", "arrived"],
  driver_en_route: ["arrived", "in_progress"],
  arrived: ["in_progress", "no_show"],
  in_progress: ["completed"],
};

const FREE_WAIT_MINUTES = 2;
const WAIT_PRICE_PER_MIN_CENTS = 100;

function getUserIdFromHeader(req: Request): number | null {
  const h = req.header("x-user-id");
  if (!h) return null;
  const id = parseInt(h, 10);
  return Number.isNaN(id) ? null : id;
}

async function ensureDriverOrAdmin(
  userId: number
): Promise<"driver" | "admin"> {
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
 * POST /driver/start-day
 * Marks the driver as online for today and records last_online timestamp.
 */
driverRouter.post("/start-day", async (req: Request, res: Response) => {
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
      return res.status(403).json({
        error: "Only drivers/admins can perform this action.",
      });
    }
    console.error("Error in /driver/start-day auth:", err);
    return res.status(500).json({ error: "Internal error." });
  }

  try {
    const result = await pool.query(
      `
      UPDATE users
      SET
        driver_is_online = TRUE,
        driver_last_online_at = now()
      WHERE id = $1
      RETURNING id, driver_is_online, driver_last_online_at
      `,
      [userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "User not found." });
    }

    return res.json({
      ok: true,
      driver: result.rows[0],
    });
  } catch (err) {
    console.error("Error in POST /driver/start-day:", err);
    return res
      .status(500)
      .json({ error: "Failed to start driver day." });
  }
});

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
 * Pending ride requests for driver (for now: all pending; later per-driver).
 */
driverRouter.get("/rides/requests", async (req: Request, res: Response) => {
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
      .json({ error: "Failed to load ride requests." });
  }
});

/**
 * POST /driver/rides/:id/accept
 * Accept a pending ride request (assign driver_id).
 */
driverRouter.post(
  "/rides/:id/accept",
  async (req: Request, res: Response) => {
    const userId = getUserIdFromHeader(req);
    if (!userId) {
      return res
        .status(401)
        .json({ error: "Missing or invalid x-user-id header." });
    }

    const rideId = Number(req.params.id);
    if (!rideId || Number.isNaN(rideId)) {
      return res.status(400).json({ error: "Invalid ride ID." });
    }

    const client = await pool.connect();

    try {
      await ensureDriverOrAdmin(userId);

      await client.query("BEGIN");

      const rideRes = await client.query(
        `
        SELECT id, status, driver_id
        FROM rides
        WHERE id = $1
        FOR UPDATE
        `,
        [rideId]
      );

      if (!rideRes.rowCount) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Ride not found." });
      }

      const ride = rideRes.rows[0] as {
        id: number;
        status: string;
        driver_id: number | null;
      };

      if (ride.status !== "pending") {
        await client.query("ROLLBACK");
        return res
          .status(400)
          .json({ error: "Ride is no longer available to accept." });
      }

      await client.query(
        `
        UPDATE rides
        SET
          driver_id = $1,
          status = 'confirmed'
        WHERE id = $2
        `,
        [userId, rideId]
      );

      await client.query("COMMIT");

      await logEvent("driver_accepted_ride", {
        driver_id: userId,
        ride_id: rideId,
      });

      return res.json({ ok: true });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("Error in POST /driver/rides/:id/accept:", err);
      return res
        .status(500)
        .json({ error: "Failed to accept ride." });
    } finally {
      client.release();
    }
  }
);

/**
 * POST /driver/rides/:id/status
 * Body: { status: "driver_en_route" | "arrived" | "in_progress" | "completed" | "no_show" }
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

    const rideId = Number(req.params.id);
    const { status } = req.body as { status?: DriverStatus };

    if (!rideId || Number.isNaN(rideId)) {
      return res.status(400).json({ error: "Invalid ride ID." });
    }

    if (!status) {
      return res.status(400).json({ error: "Missing status in body." });
    }

    const client = await pool.connect();

    try {
      await ensureDriverOrAdmin(userId);

      await client.query("BEGIN");

      const rideRes = await client.query(
        `
        SELECT
          id,
          user_id,
          driver_id,
          pickup_time,
          status,
          arrived_at,
          in_progress_at,
          completed_at,
          no_show_at,
          wait_price_cents
        FROM rides
        WHERE id = $1
        FOR UPDATE
        `,
        [rideId]
      );

      if (!rideRes.rowCount) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Ride not found." });
      }

      const ride = rideRes.rows[0] as {
        id: number;
        user_id: number;
        driver_id: number | null;
        pickup_time: string;
        status: string;
        arrived_at: string | null;
        in_progress_at: string | null;
        completed_at: string | null;
        no_show_at: string | null;
        wait_price_cents: number | null;
      };

      if (!ALLOWED_NEXT_STATUSES[ride.status]?.includes(status)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Invalid status transition." });
      }

      const now = new Date();
      let waitPriceCents = ride.wait_price_cents ?? 0;

      if (status === "arrived") {
        const pickupTime = new Date(ride.pickup_time);
        const diffMs = now.getTime() - pickupTime.getTime();
        const diffMinutes = Math.max(0, diffMs / 60000);
        const extraMinutes = Math.max(0, diffMinutes - FREE_WAIT_MINUTES);
        waitPriceCents += Math.round(
          extraMinutes * WAIT_PRICE_PER_MIN_CENTS
        );
      }

      let arrivedAt = ride.arrived_at;
      let inProgressAt = ride.in_progress_at;
      let completedAt = ride.completed_at;
      let noShowAt = ride.no_show_at;

      if (status === "arrived") {
        arrivedAt = now.toISOString();
      } else if (status === "in_progress") {
        inProgressAt = now.toISOString();
      } else if (status === "completed") {
        completedAt = now.toISOString();
      } else if (status === "no_show") {
        noShowAt = now.toISOString();
      }

      const updateRes = await client.query(
        `
        UPDATE rides
        SET
          status = $1,
          arrived_at = $2,
          in_progress_at = $3,
          completed_at = $4,
          no_show_at = $5,
          wait_price_cents = $6
        WHERE id = $7
        RETURNING *
        `,
        [
          status,
          arrivedAt,
          inProgressAt,
          completedAt,
          noShowAt,
          waitPriceCents,
          rideId,
        ]
      );

      const updatedRide = updateRes.rows[0];

      await client.query("COMMIT");

      await sendRideStatusNotification(
        ride.user_id,
        rideId,
        status as RideStatusNotificationEvent,
        ride.pickup_time
      );

      await logEvent("driver_updated_ride_status", {
        driver_id: userId,
        ride_id: rideId,
        status,
      });

      return res.json({
        ok: true,
        ride: updatedRide,
      });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("Error in POST /driver/rides/:id/status:", err);
      return res
        .status(500)
        .json({ error: "Failed to update ride status." });
    } finally {
      client.release();
    }
  }
);

export default driverRouter;
