import express from "express";
import { pool } from "../db/pool";
import { consumeCredit } from "../services/credits";
import { sendRideStatusNotification } from "../services/notifications";

const ridesRouter = express.Router();

// ----------------------
// Types & constants
// ----------------------

type RideStatus =
  | "requested"
  | "confirmed"
  | "driver_en_route"
  | "arrived"
  | "in_progress"
  | "completed"
  | "cancelled";

const SLOT_WINDOW_MINUTES = 15;
const MAX_RIDES_PER_SLOT = 4;

// ----------------------
// Helper functions
// ----------------------

/**
 * Compute slot window start & end for a given pickup_time.
 * Slot size is 15 minutes.
 */
function computeSlotWindow(pickup: Date): { slotStart: Date; slotEnd: Date } {
  const slotStart = new Date(pickup.getTime());
  const minutes = slotStart.getUTCMinutes();
  const floored =
    Math.floor(minutes / SLOT_WINDOW_MINUTES) * SLOT_WINDOW_MINUTES;
  slotStart.setUTCMinutes(floored, 0, 0);

  const slotEnd = new Date(
    slotStart.getTime() + SLOT_WINDOW_MINUTES * 60 * 1000
  );

  return { slotStart, slotEnd };
}

/**
 * Check if the slot for a given pickup time is full.
 * Counts all non-cancelled rides in the same slot.
 */
async function isSlotFull(pickup: Date): Promise<boolean> {
  const { slotStart, slotEnd } = computeSlotWindow(pickup);

  const result = await pool.query(
    `
    SELECT COUNT(*) AS count
    FROM rides
    WHERE pickup_time >= $1
      AND pickup_time < $2
      AND status <> 'cancelled'
  `,
    [slotStart.toISOString(), slotEnd.toISOString()]
  );

  const count = parseInt(result.rows[0]?.count || "0", 10);
  return count >= MAX_RIDES_PER_SLOT;
}

/**
 * Parse userId from x-user-id header.
 */
function parseUserIdFromHeader(req: express.Request): number | null {
  const headerVal = req.header("x-user-id") || "";
  const id = parseInt(headerVal, 10);
  if (!id || Number.isNaN(id)) return null;
  return id;
}

// ----------------------
// POST /rides  (create booking)
// ----------------------
//
// Body:
// {
//   pickup_address: string,
//   dropoff_address: string,
//   pickup_lat?: number,
//   pickup_lng?: number,
//   dropoff_lat?: number,
//   dropoff_lng?: number,
//   pickup_time: string (ISO),
//   ride_type?: "standard" | "grocery",
//   notes?: string
// }
//
// Uses x-user-id header for now.

ridesRouter.post("/", async (req, res) => {
  const userId = parseUserIdFromHeader(req);
  if (!userId) {
    return res.status(401).json({ error: "Missing or invalid x-user-id" });
  }

  const {
    pickup_address,
    dropoff_address,
    pickup_lat,
    pickup_lng,
    dropoff_lat,
    dropoff_lng,
    pickup_time,
    ride_type,
    notes,
  } = req.body || {};

  if (!pickup_address || !dropoff_address || !pickup_time) {
    return res.status(400).json({
      error:
        "Missing required fields: pickup_address, dropoff_address, pickup_time",
    });
  }

  let pickupDate: Date;
  try {
    pickupDate = new Date(pickup_time);
    if (Number.isNaN(pickupDate.getTime())) {
      throw new Error("Invalid date");
    }
  } catch {
    return res.status(400).json({ error: "Invalid pickup_time" });
  }

  const type: "standard" | "grocery" =
    ride_type === "grocery" ? "grocery" : "standard";

  try {
    // Slot capacity check (safety)
    const full = await isSlotFull(pickupDate);
    if (full) {
      return res.status(409).json({
        error: "That time window is fully booked.",
        code: "SLOT_FULL",
      });
    }

    const result = await pool.query(
      `
      INSERT INTO rides (
        user_id,
        pickup_address,
        dropoff_address,
        pickup_lat,
        pickup_lng,
        dropoff_lat,
        dropoff_lng,
        pickup_time,
        ride_type,
        status,
        notes,
        is_from_schedule
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, 'requested', $10, FALSE
      )
      RETURNING
        id,
        user_id,
        pickup_address,
        dropoff_address,
        pickup_lat,
        pickup_lng,
        dropoff_lat,
        dropoff_lng,
        pickup_time,
        ride_type,
        status,
        notes
    `,
      [
        userId,
        pickup_address,
        dropoff_address,
        pickup_lat ?? null,
        pickup_lng ?? null,
        dropoff_lat ?? null,
        dropoff_lng ?? null,
        pickupDate.toISOString(),
        type,
        notes ?? null,
      ]
    );

    const ride = result.rows[0];

    // 🔔 SMS: treat booking as "confirmed" in user-facing language
    try {
      await sendRideStatusNotification(
        userId,
        ride.id,
        "confirmed",
        ride.pickup_time
      );
    } catch (err) {
      console.error("[Notifications] Failed to send booking SMS:", err);
    }

    res.status(201).json({
      ok: true,
      ride,
    });
  } catch (err) {
    console.error("Error in POST /rides:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ----------------------
// GET /rides/user   (rider's rides)
// ----------------------
//
// Uses x-user-id header.
// Returns rides sorted by pickup_time ascending.

ridesRouter.get("/user", async (req, res) => {
  const userId = parseUserIdFromHeader(req);
  if (!userId) {
    return res.status(401).json({ error: "Missing or invalid x-user-id" });
  }

  try {
    const result = await pool.query(
      `
      SELECT
        id,
        user_id,
        pickup_address,
        dropoff_address,
        pickup_lat,
        pickup_lng,
        dropoff_lat,
        dropoff_lng,
        pickup_time,
        ride_type,
        status,
        notes,
        is_from_schedule,
        schedule_id
      FROM rides
      WHERE user_id = $1
      ORDER BY pickup_time ASC
    `,
      [userId]
    );

    res.json({
      ok: true,
      rides: result.rows,
    });
  } catch (err) {
    console.error("Error in GET /rides/user:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ----------------------
// GET /rides/driver  (driver's rides for today)
// ----------------------
//
// Uses x-user-id header to identify driver (must have role = 'driver').
// For now, returns all non-cancelled rides for today (single-driver model).

ridesRouter.get("/driver", async (req, res) => {
  const driverId = parseUserIdFromHeader(req);
  if (!driverId) {
    return res.status(401).json({ error: "Missing or invalid x-user-id" });
  }

  try {
    const now = new Date();
    const dayStart = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        0,
        0,
        0,
        0
      )
    );
    const dayEnd = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        23,
        59,
        59,
        999
      )
    );

    const result = await pool.query(
      `
      SELECT
        r.id,
        r.user_id,
        u.name AS user_name,
        r.pickup_address,
        r.dropoff_address,
        r.pickup_lat,
        r.pickup_lng,
        r.dropoff_lat,
        r.dropoff_lng,
        r.pickup_time,
        r.ride_type,
        r.status
      FROM rides r
      JOIN users u ON u.id = r.user_id
      WHERE r.pickup_time >= $1
        AND r.pickup_time <= $2
        AND r.status <> 'cancelled'
      ORDER BY r.pickup_time ASC
    `,
      [dayStart.toISOString(), dayEnd.toISOString()]
    );

    res.json({
      ok: true,
      rides: result.rows,
    });
  } catch (err) {
    console.error("Error in GET /rides/driver:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ----------------------
// GET /rides/admin   (simple list for admin page)
// ----------------------

ridesRouter.get("/admin", async (_req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        r.id,
        r.user_id,
        u.name AS user_name,
        u.phone,
        r.pickup_address,
        r.dropoff_address,
        r.pickup_time,
        r.ride_type,
        r.status
      FROM rides r
      JOIN users u ON u.id = r.user_id
      ORDER BY r.pickup_time DESC
      LIMIT 100
    `
    );

    res.json({
      ok: true,
      rides: result.rows,
    });
  } catch (err) {
    console.error("Error in GET /rides/admin:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ----------------------
// GET /rides/:id   (details for tracking)
// ----------------------

ridesRouter.get("/:id", async (req, res) => {
  const idParam = req.params.id;
  const rideId = parseInt(idParam, 10);
  if (!rideId || Number.isNaN(rideId)) {
    return res.status(400).json({ error: "Invalid ride id" });
  }

  try {
    const result = await pool.query(
      `
      SELECT
        id,
        user_id,
        pickup_address,
        dropoff_address,
        pickup_lat,
        pickup_lng,
        dropoff_lat,
        dropoff_lng,
        pickup_time,
        ride_type,
        status,
        notes
      FROM rides
      WHERE id = $1
    `,
      [rideId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Ride not found" });
    }

    res.json({
      ok: true,
      ride: result.rows[0],
    });
  } catch (err) {
    console.error("Error in GET /rides/:id:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ----------------------
// POST /rides/:id/status   (status updates + credits + SMS)
// ----------------------

ridesRouter.post("/:id/status", async (req, res) => {
  const idParam = req.params.id;
  const rideId = parseInt(idParam, 10);
  if (!rideId || Number.isNaN(rideId)) {
    return res.status(400).json({ error: "Invalid ride id" });
  }

  const { status } = req.body || {};
  const allowedStatuses: RideStatus[] = [
    "requested",
    "confirmed",
    "driver_en_route",
    "arrived",
    "in_progress",
    "completed",
    "cancelled",
  ];

  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }

  try {
    // Load current ride to know previous status, user & type & pickup_time
    const currentRes = await pool.query(
      `
      SELECT id, user_id, status, ride_type, pickup_time
      FROM rides
      WHERE id = $1
    `,
      [rideId]
    );

    if (currentRes.rows.length === 0) {
      return res.status(404).json({ error: "Ride not found" });
    }

    const current = currentRes.rows[0];
    const prevStatus: RideStatus = current.status;
    const rideType: string = current.ride_type || "standard";
    const pickupTimeIso: string | null = current.pickup_time || null;

    const updatedRes = await pool.query(
      `
      UPDATE rides
      SET status = $1
      WHERE id = $2
      RETURNING
        id,
        user_id,
        status,
        ride_type
    `,
      [status, rideId]
    );

    const updated = updatedRes.rows[0];

    // If we just moved into "completed" from a non-completed status, consume credits
    if (prevStatus !== "completed" && status === "completed") {
      const typeForCredit: "standard" | "grocery" =
        rideType === "grocery" ? "grocery" : "standard";

      try {
        await consumeCredit(updated.user_id, typeForCredit);
      } catch (err) {
        console.error("Error consuming credit for ride", rideId, err);
        // Don't fail the status change just because credit accounting failed.
      }
    }

    // 🔔 SMS notifications for key transitions
    if (status === "driver_en_route" || status === "arrived") {
      try {
        await sendRideStatusNotification(
          updated.user_id,
          updated.id,
          status,
          pickupTimeIso
        );
      } catch (err) {
        console.error(
          "[Notifications] Failed to send status SMS for ride",
          rideId,
          err
        );
      }
    }

    res.json({
      ok: true,
      ride: updated,
    });
  } catch (err) {
    console.error("Error in POST /rides/:id/status:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default ridesRouter;
