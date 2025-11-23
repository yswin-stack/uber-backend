import { Router, Request, Response } from "express";
import { pool } from "../db/pool";
import { consumeCreditForRide, getCreditsSummary } from "../lib/credits";
import { sendSmsOrLog } from "../lib/notifications";

export const ridesRouter = Router();

const MAX_RIDES_PER_SLOT = 2; // adjust capacity per 15-min slot

function getUserIdFromHeader(req: Request): number | null {
  const header = req.header("x-user-id");
  if (!header) return null;
  const id = parseInt(header, 10);
  return Number.isNaN(id) ? null : id;

// ---- Slot capacity settings ----
const MAX_RIDES_PER_SLOT = 3;      // how many rides you can realistically do in 15 mins
const SLOT_MINUTES = 15;

const ACTIVE_STATUSES = [
  "pending",
  "confirmed",
  "driver_en_route",
  "arrived",
  "in_progress",
] as const;

type SlotSuggestion = {
  start: string;
  end: string;
  count: number;
  max: number;
  label: string;
};

function computeSlotBounds(iso: string): { start: Date; end: Date } | null {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;

  const rounded = new Date(d);
  const minutes = rounded.getMinutes();
  const remainder = minutes % SLOT_MINUTES;
  rounded.setMinutes(minutes - remainder, 0, 0);

  const start = rounded;
  const end = new Date(rounded.getTime() + SLOT_MINUTES * 60 * 1000);

  return { start, end };
}

function formatTimeLabel(d: Date): string {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * Check how many active rides are in the slot that contains pickupTimeIso.
 * Also compute a few next available slots as suggestions.
 */
async function checkSlotCapacity(
  pickupTimeIso: string
): Promise<{
  isFull: boolean;
  count: number;
  max: number;
  suggestions: SlotSuggestion[];
}> {
  const bounds = computeSlotBounds(pickupTimeIso);
  if (!bounds) {
    return {
      isFull: false,
      count: 0,
      max: MAX_RIDES_PER_SLOT,
      suggestions: [],
    };
  }

  const { start, end } = bounds;

  // Count active rides in that slot
  const baseResult = await pool.query(
    `
    SELECT COUNT(*)::int AS count
    FROM rides
    WHERE pickup_time >= $1
      AND pickup_time < $2
      AND status = ANY($3)
  `,
    [start, end, ACTIVE_STATUSES]
  );

  const baseCount: number = baseResult.rows[0]?.count ?? 0;
  const isFull = baseCount >= MAX_RIDES_PER_SLOT;

  // Build suggestions (next up to 4 slots, first 3 that are not full)
  const suggestions: SlotSuggestion[] = [];
  let cursorStart = new Date(start);

  for (let i = 0; i < 4; i++) {
    cursorStart = new Date(cursorStart.getTime() + SLOT_MINUTES * 60 * 1000);
    const cursorEnd = new Date(
      cursorStart.getTime() + SLOT_MINUTES * 60 * 1000
    );

    const result = await pool.query(
      `
      SELECT COUNT(*)::int AS count
      FROM rides
      WHERE pickup_time >= $1
        AND pickup_time < $2
        AND status = ANY($3)
    `,
      [cursorStart, cursorEnd, ACTIVE_STATUSES]
    );

    const count = result.rows[0]?.count ?? 0;
    if (count < MAX_RIDES_PER_SLOT) {
      suggestions.push({
        start: cursorStart.toISOString(),
        end: cursorEnd.toISOString(),
        count,
        max: MAX_RIDES_PER_SLOT,
        label: formatTimeLabel(cursorStart),
      });
    }

    if (suggestions.length >= 3) break;
  }

  return {
    isFull,
    count: baseCount,
    max: MAX_RIDES_PER_SLOT,
    suggestions,
  };
}

  
}

// Helper: 15-minute slot rounding
function getSlotKey(date: Date): { slotStart: Date; slotLabel: string } {
  const d = new Date(date);
  const minutes = d.getMinutes();
  const slotMinutes = Math.floor(minutes / 15) * 15;
  d.setMinutes(slotMinutes, 0, 0);
  const slotStart = d;
  const slotLabel = slotStart.toISOString();
  return { slotStart, slotLabel };
}

// Helper: find next slot with capacity
async function findNextAvailableSlot(
  pickupLocation: string,
  dropoffLocation: string,
  desiredTime: Date
): Promise<{ slotTime: Date; count: number }> {
  // For simplicity, we just check next 8 slots (2 hours) in 15 min increments
  let checkTime = new Date(desiredTime);
  for (let i = 0; i < 8; i++) {
    const { slotStart } = getSlotKey(checkTime);

    const result = await pool.query(
      `
      SELECT COUNT(*) AS count
      FROM rides
      WHERE pickup_time >= $1
        AND pickup_time < $1 + INTERVAL '15 minutes'
        AND status NOT IN ('cancelled')
    `,
      [slotStart.toISOString()]
    );

    const count = parseInt(result.rows[0].count, 10);
    if (count < MAX_RIDES_PER_SLOT) {
      return { slotTime: slotStart, count };
    }

    checkTime = new Date(slotStart.getTime() + 15 * 60 * 1000);
  }

  // If all full, just return original time as fallback
  return { slotTime: desiredTime, count: MAX_RIDES_PER_SLOT };
}

// 1) BOOK A RIDE
ridesRouter.post("/", async (req: Request, res: Response) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) {
    return res.status(401).json({ error: "Missing or invalid x-user-id" });
  }

  try {
    const {
      pickup_location,
      dropoff_location,
      pickup_lat,
      pickup_lng,
      ride_type,
      pickup_time,
    } = req.body as {
      pickup_location?: string;
      dropoff_location?: string;
      pickup_lat?: number;
      pickup_lng?: number;
      ride_type?: "standard" | "grocery";
      pickup_time?: string | null;
    };

    if (!pickup_location || !dropoff_location) {
      return res
        .status(400)
        .json({ error: "Missing required fields (pickup/dropoff)." });
    }

    const rideType = ride_type || "standard";

    // Determine pickup time: now or supplied
    const now = new Date();
    let pickupTime: Date | null = null;

    if (pickup_time) {
      pickupTime = new Date(pickup_time);
      if (isNaN(pickupTime.getTime())) {
        return res.status(400).json({ error: "Invalid pickup_time." });
      }
    } else {
      pickupTime = now;
    }

    if (!pickupTime) {
      return res.status(400).json({ error: "Unable to determine pickup time." });
    }

    // Capacity check: 15 min slots
    const { slotStart } = getSlotKey(pickupTime);
    const countResult = await pool.query(
      `
      SELECT COUNT(*) AS count
      FROM rides
      WHERE pickup_time >= $1
        AND pickup_time < $1 + INTERVAL '15 minutes'
        AND status NOT IN ('cancelled')
    `,
      [slotStart.toISOString()]
    );
    const count = parseInt(countResult.rows[0].count, 10);

    if (count >= MAX_RIDES_PER_SLOT) {
      const nextSlot = await findNextAvailableSlot(
        pickup_location,
        dropoff_location,
        pickupTime
      );
      return res.status(409).json({
        error: "Slot full",
        code: "SLOT_FULL",
        suggested_pickup_time: nextSlot.slotTime.toISOString(),
      });
    }

    // Check & consume credit
    const creditResult = await consumeCreditForRide(userId, rideType, now);
    if (!creditResult.ok) {
      return res
        .status(402)
        .json({ error: creditResult.message || "No credits left." });
    }

    // Create ride
    const insert = await pool.query(
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
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
      RETURNING *
    `,
      [
        userId,
        pickup_location,
        dropoff_location,
        pickup_lat ?? null,
        pickup_lng ?? null,
        pickupTime.toISOString(),
        rideType,
      ]
    );

    const ride = insert.rows[0];

    // Get user phone
    const userResult = await pool.query(
      `SELECT phone FROM users WHERE id = $1`,
      [userId]
    );
    const phone = userResult.rows[0]?.phone || null;

    // Notify user: ride requested/confirmed
    const appBase = process.env.APP_BASE_URL || "";
    const trackUrl = appBase
      ? `${appBase}/rides/${ride.id}/track`
      : `Ride #${ride.id}`;
    await sendSmsOrLog(
      userId,
      ride.id,
      phone,
      `Your ride request #${ride.id} is received and pending confirmation. ${trackUrl}`
    );

    res.json({ ride });
  } catch (err: any) {
    console.error("Error in POST /rides", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 2) GET RIDES FOR LOGGED-IN RIDER (upcoming + history)
ridesRouter.get("/user", async (req: Request, res: Response) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) {
    return res.status(401).json({ error: "Missing or invalid x-user-id" });
  }

  try {
    const now = new Date().toISOString();

    const upcomingResult = await pool.query(
      `
      SELECT *
      FROM rides
      WHERE user_id = $1
        AND (pickup_time IS NULL OR pickup_time >= $2)
      ORDER BY pickup_time ASC NULLS LAST, created_at DESC
      LIMIT 50
    `,
      [userId, now]
    );

    const historyResult = await pool.query(
      `
      SELECT *
      FROM rides
      WHERE user_id = $1
        AND (pickup_time IS NOT NULL AND pickup_time < $2
             OR status IN ('completed', 'cancelled'))
      ORDER BY pickup_time DESC NULLS LAST, created_at DESC
      LIMIT 50
    `,
      [userId, now]
    );

    const credits = await getCreditsSummary(userId);

    res.json({
      upcoming: upcomingResult.rows,
      history: historyResult.rows,
      credits,
    });
  } catch (err: any) {
    console.error("Error in GET /rides/user", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 3) DRIVER VIEW: GET ALL ACTIVE RIDES FOR TODAY + UPCOMING
ridesRouter.get("/driver", async (req: Request, res: Response) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) {
    return res.status(401).json({ error: "Missing or invalid x-user-id" });
  }

  try {
    // You might also validate that this user is actually a driver (role='driver')
    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);

    const result = await pool.query(
      `
      SELECT r.*,
             u.name AS rider_name,
             u.phone AS rider_phone
      FROM rides r
      JOIN users u ON u.id = r.user_id
      WHERE r.pickup_time >= $1
        AND r.status NOT IN ('completed', 'cancelled')
      ORDER BY r.pickup_time ASC
    `,
      [startOfDay.toISOString()]
    );

    res.json({ rides: result.rows });
  } catch (err: any) {
    console.error("Error in GET /rides/driver", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 4) DRIVER/ADMIN STATUS UPDATE (Arrived → Start → Complete, etc.)
ridesRouter.patch("/:id/status", async (req: Request, res: Response) => {
  const rideId = parseInt(req.params.id, 10);
  if (Number.isNaN(rideId)) {
    return res.status(400).json({ error: "Invalid ride id" });
  }

  const userId = getUserIdFromHeader(req);
  if (!userId) {
    return res.status(401).json({ error: "Missing or invalid x-user-id" });
  }

  const { status } = req.body as { status?: string };

  if (
    !status ||
    ![
      "pending",
      "confirmed",
      "driver_en_route",
      "arrived",
      "in_progress",
      "completed",
      "cancelled",
    ].includes(status)
  ) {
    return res.status(400).json({ error: "Invalid status" });
  }

  try {
    // Update ride
    const update = await pool.query(
      `
      UPDATE rides
      SET status = $1,
          driver_id = COALESCE(driver_id, $2),
          completed_at = CASE WHEN $1 = 'completed' THEN NOW() ELSE completed_at END
      WHERE id = $3
      RETURNING *
    `,
      [status, userId, rideId]
    );

    if (update.rowCount === 0) {
      return res.status(404).json({ error: "Ride not found" });
    }

    const ride = update.rows[0];

    // Grab rider info
    const userResult = await pool.query(
      `SELECT phone FROM users WHERE id = $1`,
      [ride.user_id]
    );
    const phone = userResult.rows[0]?.phone || null;

    let message: string | null = null;
    if (status === "confirmed") {
      message = `Your ride #${ride.id} is confirmed.`;
    } else if (status === "driver_en_route") {
      message = `Your driver is en route for ride #${ride.id}.`;
    } else if (status === "arrived") {
      message = `Your driver has arrived for ride #${ride.id}.`;
    } else if (status === "in_progress") {
      message = `Your ride #${ride.id} is in progress.`;
    } else if (status === "completed") {
      message = `Your ride #${ride.id} is completed.`;
    }

    if (message) {
      await sendSmsOrLog(ride.user_id, ride.id, phone, message);
    }

    res.json({ ride });
  } catch (err: any) {
    console.error("Error in PATCH /rides/:id/status", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
