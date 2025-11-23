import { Router, Request, Response } from "express";
import { pool } from "../db/pool";

const ridesRouter = Router();

type RideStatus =
  | "pending"
  | "confirmed"
  | "driver_en_route"
  | "arrived"
  | "in_progress"
  | "completed"
  | "cancelled";

const ACTIVE_STATUSES: RideStatus[] = [
  "pending",
  "confirmed",
  "driver_en_route",
  "arrived",
  "in_progress",
];

// ---- Slot capacity settings ----
const MAX_RIDES_PER_SLOT = 3; // how many rides you can realistically do in 15 mins
const SLOT_MINUTES = 15;

type SlotSuggestion = {
  start: string;
  end: string;
  count: number;
  max: number;
  label: string;
};

function getUserIdFromHeader(req: Request): number | null {
  const raw = req.header("x-user-id");
  if (!raw) return null;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return null;
  return n;
}

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

/**
 * Simple overlap check:
 * Prevent rides for same user within ±30 minutes of requested pickup.
 */
async function hasOverlap(
  userId: number,
  pickupTimeIso: string
): Promise<boolean> {
  const center = new Date(pickupTimeIso);
  if (isNaN(center.getTime())) return false;

  const thirtyMin = 30 * 60 * 1000;
  const from = new Date(center.getTime() - thirtyMin);
  const to = new Date(center.getTime() + thirtyMin);

  const result = await pool.query(
    `
    SELECT COUNT(*)::int AS count
    FROM rides
    WHERE user_id = $1
      AND pickup_time >= $2
      AND pickup_time <= $3
      AND status != 'cancelled'
  `,
    [userId, from, to]
  );

  const count: number = result.rows[0]?.count ?? 0;
  return count > 0;
}

/**
 * POST /rides
 * Create a new ride booking.
 */
ridesRouter.post("/", async (req: Request, res: Response) => {
  try {
    const userId = getUserIdFromHeader(req);
    if (!userId) {
      return res
        .status(401)
        .json({ error: "Missing or invalid x-user-id header." });
    }

    const body = req.body as any;

    // Try to be flexible with field names from frontend.
    const pickupAddress: string =
      body.pickup_address || body.pickupAddress || "";
    const dropoffAddress: string =
      body.dropoff_address || body.dropoffAddress || "";
    const pickupLat: number | null =
      body.pickup_lat ??
      body.pickupLat ??
      (body.pickupLocation?.lat ?? null);
    const pickupLng: number | null =
      body.pickup_lng ??
      body.pickupLng ??
      (body.pickupLocation?.lng ?? null);
    const dropoffLat: number | null =
      body.dropoff_lat ??
      body.dropoffLat ??
      (body.dropoffLocation?.lat ?? null);
    const dropoffLng: number | null =
      body.dropoff_lng ??
      body.dropoffLng ??
      (body.dropoffLocation?.lng ?? null);

    const pickupTimeIso: string =
      body.pickup_time ||
      body.pickupTime ||
      body.pickup_time_iso ||
      body.pickupTimeIso ||
      "";

    const rideType: string = body.ride_type || body.rideType || "standard";
    const notes: string = body.notes || "";

    if (!pickupAddress || !dropoffAddress || !pickupTimeIso) {
      return res.status(400).json({
        error: "pickupAddress, dropoffAddress, and pickupTime are required.",
      });
    }

    const pickupDate = new Date(pickupTimeIso);
    if (isNaN(pickupDate.getTime())) {
      return res.status(400).json({
        error: "pickup_time must be a valid ISO datetime string.",
      });
    }

    // --- Slot capacity check ---
    const slotCheck = await checkSlotCapacity(pickupTimeIso);
    if (slotCheck.isFull) {
      return res.status(409).json({
        ok: false,
        code: "SLOT_FULL",
        message:
          "That pickup window is already fully booked. Please choose another time.",
        slot: {
          max: slotCheck.max,
          count: slotCheck.count,
        },
        suggestions: slotCheck.suggestions,
      });
    }

    // --- Overlap check for this user ---
    if (await hasOverlap(userId, pickupTimeIso)) {
      return res.status(400).json({
        ok: false,
        code: "OVERLAP",
        message:
          "You already have a ride near that time. We prevent overlapping bookings.",
      });
    }

    // Insert ride
    const insertResult = await pool.query(
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
        status,
        ride_type,
        notes
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
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
        status,
        ride_type,
        notes,
        created_at
    `,
      [
        userId,
        pickupAddress,
        dropoffAddress,
        pickupLat,
        pickupLng,
        dropoffLat,
        dropoffLng,
        pickupDate,
        "pending",
        rideType,
        notes,
      ]
    );

    const ride = insertResult.rows[0];

    return res.status(201).json({
      ok: true,
      ride,
    });
  } catch (err) {
    console.error("Error in POST /rides", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /rides/user
 * List rides for the logged-in user (recent + upcoming).
 */
ridesRouter.get("/user", async (req: Request, res: Response) => {
  try {
    const userId = getUserIdFromHeader(req);
    if (!userId) {
      return res
        .status(401)
        .json({ error: "Missing or invalid x-user-id header." });
    }

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
        status,
        ride_type,
        notes,
        created_at
      FROM rides
      WHERE user_id = $1
      ORDER BY pickup_time DESC
      LIMIT 100
    `,
      [userId]
    );

    return res.json({
      ok: true,
      rides: result.rows,
    });
  } catch (err) {
    console.error("Error in GET /rides/user", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /rides/driver
 * For drivers: list today's and upcoming active rides.
 * Assumes caller is a driver; we just filter by status/time.
 */
ridesRouter.get("/driver", async (req: Request, res: Response) => {
  try {
    const userId = getUserIdFromHeader(req);
    if (!userId) {
      return res
        .status(401)
        .json({ error: "Missing or invalid x-user-id header." });
    }

    // You can also check that this user is actually a driver by joining on users.role if you want.
    const now = new Date();
    const todayStart = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      0,
      0,
      0,
      0
    );

    const result = await pool.query(
      `
      SELECT
        r.id,
        r.user_id,
        r.pickup_address,
        r.dropoff_address,
        r.pickup_lat,
        r.pickup_lng,
        r.dropoff_lat,
        r.dropoff_lng,
        r.pickup_time,
        r.status,
        r.ride_type,
        r.notes,
        r.created_at,
        u.name AS rider_name,
        u.phone AS rider_phone
      FROM rides r
      JOIN users u ON u.id = r.user_id
      WHERE r.pickup_time >= $1
        AND r.status = ANY($2)
      ORDER BY r.pickup_time ASC
    `,
      [todayStart, ACTIVE_STATUSES]
    );

    return res.json({
      ok: true,
      rides: result.rows,
    });
  } catch (err) {
    console.error("Error in GET /rides/driver", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * PATCH /rides/:id/status
 * Body: { status: RideStatus }
 */
ridesRouter.patch("/:id/status", async (req: Request, res: Response) => {
  try {
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

    const body = req.body as { status?: RideStatus };
    const newStatus = body.status;

    const allowed: RideStatus[] = [
      "confirmed",
      "driver_en_route",
      "arrived",
      "in_progress",
      "completed",
      "cancelled",
    ];

    if (!newStatus || !allowed.includes(newStatus)) {
      return res.status(400).json({
        error: "Invalid status.",
        allowed,
      });
    }

    const updateResult = await pool.query(
      `
      UPDATE rides
      SET status = $1, updated_at = now()
      WHERE id = $2
      RETURNING
        id,
        user_id,
        pickup_address,
        dropoff_address,
        pickup_time,
        status,
        ride_type,
        notes,
        created_at,
        updated_at
    `,
      [newStatus, rideId]
    );

    if (updateResult.rowCount === 0) {
      return res.status(404).json({ error: "Ride not found." });
    }

    const ride = updateResult.rows[0];

    return res.json({
      ok: true,
      ride,
    });
  } catch (err) {
    console.error("Error in PATCH /rides/:id/status", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export { ridesRouter };
export default ridesRouter;
