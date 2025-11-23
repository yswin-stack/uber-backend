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

/**
 * GET /driver/rides/today
 * Driver daily plan (for now: all rides today; future-ready for multi-driver).
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
        SELECT id, user_id, status, pickup_time
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
        pickup_time: string | null;
      };

      const allowedNext = ALLOWED_NEXT_STATUSES[ride.status] || [];
      if (!allowedNext.includes(newStatus)) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: `Cannot change status from '${ride.status}' to '${newStatus}'.`,
        });
      }

      const nowIso = new Date().toISOString();

      // Basic timestamp handling – richer wait/late logic comes in step 5.
      let extraSet = "";
      const params: any[] = [newStatus, userId, nowIso, rideId];

      if (newStatus === "completed") {
        extraSet = ", completed_at = $3";
      } else if (newStatus === "arrived") {
        extraSet = ", /* arrived_at placeholder */ ";
      } else if (newStatus === "in_progress") {
        extraSet = ", /* in_progress_at placeholder */ ";
      }

      const updateSql = `
        UPDATE rides
        SET status = $1,
            driver_id = COALESCE(driver_id, $2)
            ${extraSet}
        WHERE id = $4
        RETURNING *
      `;

      const updatedRes = await client.query(updateSql, params);
      const updatedRide = updatedRes.rows[0];

      await client.query("COMMIT");

      // Trigger SMS notifications for key statuses
      const smsStatuses: DriverStatus[] = [
        "driver_en_route",
        "arrived",
        "in_progress",
        "completed",
      ];

      if (smsStatuses.includes(newStatus)) {
        const pickupIso = ride.pickup_time || updatedRide.pickup_time || null;
        await sendRideStatusNotification(
          ride.user_id,
          ride.id,
          newStatus as any,
          pickupIso
        );
      }

      return res.json({
        ok: true,
        ride: updatedRide,
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
