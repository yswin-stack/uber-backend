import { pool } from "../db/pool";

// How many minutes is one slot?
const SLOT_WINDOW_MINUTES = 15;

// How many rides can a single slot handle (for one driver)?
const MAX_RIDES_PER_SLOT = 4;

type UserScheduleRow = {
  id: number;
  user_id: number;
  day_of_week: number; // 0–6 (JS-style, we’ll assume 0=Sunday)
  direction: "to_work" | "to_home";
  pickup_time: string; // "HH:MM" stored as TEXT or TIME
  pickup_address: string;
  pickup_lat: number | null;
  pickup_lng: number | null;
  dropoff_address: string;
  dropoff_lat: number | null;
  dropoff_lng: number | null;
  is_active: boolean;
};

/**
 * Convert a date + schedule.pickup_time ("HH:MM") into an ISO Date in UTC.
 * You can customize this for local Winnipeg timezone later if needed.
 */
function buildPickupDateForDay(baseDate: Date, pickupTime: string): Date {
  const [hhStr, mmStr] = pickupTime.split(":");
  const hours = parseInt(hhStr, 10);
  const minutes = parseInt(mmStr || "0", 10);

  // Use UTC to avoid timezone confusion (simple version)
  const d = new Date(
    Date.UTC(
      baseDate.getUTCFullYear(),
      baseDate.getUTCMonth(),
      baseDate.getUTCDate(),
      hours,
      minutes,
      0,
      0
    )
  );
  return d;
}

/**
 * Given a pickup time Date, compute the slot start and end (in UTC),
 * e.g. 08:02 → slot 08:00–08:15.
 */
function computeSlotBounds(pickupDate: Date): { slotStart: Date; slotEnd: Date } {
  const slotStart = new Date(pickupDate.getTime());
  const minutes = slotStart.getUTCMinutes();
  const floored = Math.floor(minutes / SLOT_WINDOW_MINUTES) * SLOT_WINDOW_MINUTES;
  slotStart.setUTCMinutes(floored, 0, 0);

  const slotEnd = new Date(
    slotStart.getTime() + SLOT_WINDOW_MINUTES * 60 * 1000
  );

  return { slotStart, slotEnd };
}

/**
 * Check how many rides are already in the same slot.
 * Only counts rides that are not cancelled.
 */
async function isSlotFull(pickupDate: Date): Promise<boolean> {
  const { slotStart, slotEnd } = computeSlotBounds(pickupDate);

  const sql = `
    SELECT COUNT(*) AS count
    FROM rides
    WHERE pickup_time >= $1
      AND pickup_time < $2
      AND status <> 'cancelled'
  `;
  const result = await pool.query(sql, [slotStart.toISOString(), slotEnd.toISOString()]);

  const count = parseInt(result.rows[0]?.count || "0", 10);
  return count >= MAX_RIDES_PER_SLOT;
}

/**
 * Generate rides for all schedules for a given target date.
 * - Only uses schedules where day_of_week matches
 * - Respects slot capacity
 * - Avoids duplicate rides for the same schedule & day
 */
export async function generateRidesForDate(target: Date): Promise<{
  createdCount: number;
  skippedFullSlots: number;
  skippedExisting: number;
}> {
  const client = await pool.connect();
  try {
    const targetDay = target.getUTCDay(); // 0–6

    // Normalize date boundaries (00:00–23:59 of the target date, in UTC)
    const dayStart = new Date(
      Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate(), 0, 0, 0, 0)
    );
    const dayEnd = new Date(
      Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate(), 23, 59, 59, 999)
    );

    // 1) Load all active schedules for that weekday
    const schedulesResult = await client.query<UserScheduleRow>(
      `
      SELECT
        id,
        user_id,
        day_of_week,
        direction,
        pickup_time,
        pickup_address,
        pickup_lat,
        pickup_lng,
        dropoff_address,
        dropoff_lat,
        dropoff_lng,
        is_active
      FROM user_schedules
      WHERE is_active = TRUE
        AND day_of_week = $1
    `,
      [targetDay]
    );

    const schedules = schedulesResult.rows;

    let createdCount = 0;
    let skippedFullSlots = 0;
    let skippedExisting = 0;

    for (const sched of schedules) {
      // Build pickup datetime (UTC) for that day
      const pickupDate = buildPickupDateForDay(target, sched.pickup_time);

      // 2) Check if a ride already exists for this schedule on that day
      const existingRes = await client.query(
        `
        SELECT id
        FROM rides
        WHERE user_id = $1
          AND schedule_id = $2
          AND pickup_time >= $3
          AND pickup_time <= $4
        LIMIT 1
      `,
        [sched.user_id, sched.id, dayStart.toISOString(), dayEnd.toISOString()]
      );

      if (existingRes.rows.length > 0) {
        skippedExisting++;
        continue;
      }

      // 3) Check slot capacity
      const full = await isSlotFull(pickupDate);
      if (full) {
        skippedFullSlots++;
        continue;
      }

      // 4) Insert ride
      await client.query(
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
          schedule_id,
          is_from_schedule
        ) VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          $11,
          $12,
          TRUE
        )
      `,
        [
          sched.user_id,
          sched.pickup_address,
          sched.dropoff_address,
          sched.pickup_lat,
          sched.pickup_lng,
          sched.dropoff_lat,
          sched.dropoff_lng,
          pickupDate.toISOString(),
          "standard", // ride_type
          "requested", // initial status
          sched.direction === "to_work" ? "Auto from schedule: to work" : "Auto from schedule: to home",
          sched.id,
        ]
      );

      createdCount++;
    }

    return { createdCount, skippedFullSlots, skippedExisting };
  } finally {
    client.release();
  }
}
