// src/jobs/generateUpcomingRides.ts

import { pool } from "../db/pool";
import { getAiConfig } from "../services/aiConfig";
import { estimateTravelMinutesKm } from "../services/predictiveEngine";
import { computeDistanceKm } from "../utils/distance";
import { localToUtc } from "../lib/time";
import {
  getCurrentPeriod,
  getActiveSubscription,
} from "../services/subscriptionService";
import { isInPeakWindow } from "../lib/peak";

/**
 * Helper: add minutes to a Date, returning a new Date.
 */
function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

type UserScheduleRow = {
  day_of_week: number;
  direction: "to_work" | "to_home";
  arrival_time: string; // "HH:MM:SS" from Postgres
};

type SavedLocationRow = {
  label: string; // "home" | "work" | "school" | ...
  address: string;
  lat: number | null;
  lng: number | null;
};

const CANCELLED_STATUSES = [
  "cancelled",
  "cancelled_by_user",
  "cancelled_by_admin",
  "no_show",
];

/**
 * Generate upcoming rides from weekly schedule templates.
 *
 * For each user with:
 *  - ride_credits_monthly row for current period
 *  - an active subscription plan
 *  - at least one user_schedules row
 *  - saved "home" and "work"/"school" locations with coords
 *
 * We generate rides for the next `daysAhead` days, as long as:
 *  - they have standard credits remaining
 *  - capacity per hour is not exceeded
 *  - no overlapping ride exists within ±overlap_buffer_minutes
 *  - if the time is in a peak window, only plans with peak_access get rides there
 */
export async function generateUpcomingRides(
  daysAhead: number = 7
): Promise<void> {
  const aiConfig = getAiConfig();
  const now = new Date();

  // Find all users who have a weekly schedule.
  const usersRes = await pool.query(
    `
    SELECT DISTINCT us.user_id
    FROM user_schedules us
    `
  );

  if (usersRes.rowCount === 0) {
    console.log("[scheduleGenerator] No users with schedules found.");
    return;
  }

  console.log(
    "[scheduleGenerator] Found %d users with schedules.",
    usersRes.rowCount
  );

  for (const row of usersRes.rows) {
    const userId: number = row.user_id;

    try {
      await generateForUser(userId, daysAhead, aiConfig, now);
    } catch (err) {
      console.error(
        "[scheduleGenerator] Failed to generate rides for user %s:",
        userId,
        err
      );
    }
  }
}

async function generateForUser(
  userId: number,
  daysAhead: number,
  aiConfig: ReturnType<typeof getAiConfig>,
  now: Date
): Promise<void> {
  // Fetch current period + credits for the user.
  const { period_start, period_end, creditsRow } = await getCurrentPeriod(
    userId
  );

  if (!creditsRow) {
    // No credits row yet => nothing to generate.
    console.log(
      "[scheduleGenerator] No credits row for user %s; skipping.",
      userId
    );
    return;
  }

  const active = await getActiveSubscription(userId);
  if (!active) {
    console.log(
      "[scheduleGenerator] User %s has no active subscription plan; skipping.",
      userId
    );
    return;
  }
  const plan = active.plan;

  let standardRemaining =
    (creditsRow.standard_total ?? 0) - (creditsRow.standard_used ?? 0);

  if (standardRemaining <= 0) {
    console.log(
      "[scheduleGenerator] User %s has no standard credits remaining; skipping.",
      userId
    );
    return;
  }

  // Pull all schedule rows for this user.
  const schedRes = await pool.query(
    `
    SELECT day_of_week, direction, arrival_time
    FROM user_schedules
    WHERE user_id = $1
    `,
    [userId]
  );

  if (schedRes.rowCount === 0) {
    console.log(
      "[scheduleGenerator] User %s has no schedule entries; skipping.",
      userId
    );
    return;
  }

  const schedules: UserScheduleRow[] = schedRes.rows.map((r: any) => ({
    day_of_week: Number(r.day_of_week),
    direction: r.direction,
    arrival_time: String(r.arrival_time),
  }));

  // Saved locations: need at least "home" and "work" / "school".
  const locRes = await pool.query(
    `
    SELECT label, address, lat, lng
    FROM saved_locations
    WHERE user_id = $1
    `,
    [userId]
  );

  if (locRes.rowCount === 0) {
    console.log(
      "[scheduleGenerator] User %s has no saved locations; skipping.",
      userId
    );
    return;
  }

  const locations: SavedLocationRow[] = locRes.rows;
  const home = locations.find((l) => l.label === "home");
  const workOrSchool =
    locations.find((l) => l.label === "work") ||
    locations.find((l) => l.label === "school");

  if (
    !home ||
    !workOrSchool ||
    home.lat == null ||
    home.lng == null ||
    workOrSchool.lat == null ||
    workOrSchool.lng == null
  ) {
    console.log(
      "[scheduleGenerator] User %s missing usable home/work locations; skipping.",
      userId
    );
    return;
  }

  console.log(
    "[scheduleGenerator] Generating rides for user %s; credits remaining: %d.",
    userId,
    standardRemaining
  );

  const todayLocal = new Date();
  todayLocal.setHours(0, 0, 0, 0);

  const pickupWindowHalf = Math.round(aiConfig.pickup_window_size / 2);
  const arrivalWindowHalf = Math.round(aiConfig.arrival_window_size / 2);
  const overlapBuffer = aiConfig.overlap_buffer_minutes || 30;
  const maxRidesPerHour = aiConfig.max_rides_per_hour || 4;
  const arriveEarlyMinutes = aiConfig.arrive_early_minutes || 5;

  for (let offset = 0; offset < daysAhead; offset++) {
    if (standardRemaining <= 0) break;

    const dayLocal = new Date(todayLocal.getTime());
    dayLocal.setDate(dayLocal.getDate() + offset);

    const dow = dayLocal.getDay(); // 0 (Sun) - 6 (Sat), matches stored convention

    const daySchedules = schedules.filter((s) => s.day_of_week === dow);
    if (daySchedules.length === 0) continue;

    for (const sched of daySchedules) {
      if (standardRemaining <= 0) break;

      // Parse arrival_time "HH:MM:SS"
      const [hhStr, mmStr] = sched.arrival_time.split(":");
      const hour = Number(hhStr || "0");
      const minute = Number(mmStr || "0");

      const arrivalLocal = new Date(dayLocal.getTime());
      arrivalLocal.setHours(hour, minute, 0, 0);

      // Skip anything in the past (today's rides with arrival time already passed).
      if (arrivalLocal.getTime() <= now.getTime()) {
        continue;
      }

      // Determine pickup & dropoff locations based on direction.
      const from = sched.direction === "to_work" ? home : workOrSchool;
      const to = sched.direction === "to_work" ? workOrSchool : home;

      if (
        from.lat == null ||
        from.lng == null ||
        to.lat == null ||
        to.lng == null
      ) {
        continue;
      }

      const legKm = computeDistanceKm(
        Number(from.lat),
        Number(from.lng),
        Number(to.lat),
        Number(to.lng)
      );

      const travelEstimate = estimateTravelMinutesKm(legKm, {
        when: arrivalLocal,
      });
      const travelMinutes = travelEstimate.travel_minutes;

      const pickupLocal = addMinutes(
        arrivalLocal,
        -(travelMinutes + arriveEarlyMinutes)
      );

      // Peak window enforcement (Premium-only access), same rule as /rides:
      if (!plan.peak_access && isInPeakWindow(pickupLocal)) {
        // This time is reserved for peak-access plans.
        continue;
      }

      const pickupWindowStartLocal = addMinutes(
        pickupLocal,
        -pickupWindowHalf
      );
      const pickupWindowEndLocal = addMinutes(pickupLocal, pickupWindowHalf);

      const arrivalWindowStartLocal = addMinutes(
        arrivalLocal,
        -arrivalWindowHalf
      );
      const arrivalWindowEndLocal = addMinutes(
        arrivalLocal,
        arrivalWindowHalf
      );

      // Convert times to UTC ISO for storage.
      const pickupTimeUtc = localToUtc(pickupLocal);
      const pickupWindowStartUtc = localToUtc(pickupWindowStartLocal);
      const pickupWindowEndUtc = localToUtc(pickupWindowEndLocal);
      const arrivalTargetUtc = localToUtc(arrivalLocal);
      const arrivalWindowStartUtc = localToUtc(arrivalWindowStartLocal);
      const arrivalWindowEndUtc = localToUtc(arrivalWindowEndLocal);

      // Capacity check: max rides per hour of pickup_time.
      const hourStartUtc = new Date(pickupTimeUtc.getTime());
      hourStartUtc.setMinutes(0, 0, 0);
      const hourEndUtc = new Date(hourStartUtc.getTime());
      hourEndUtc.setHours(hourEndUtc.getHours() + 1);

      const capRes = await pool.query(
        `
        SELECT COUNT(*) AS count
        FROM rides
        WHERE pickup_time >= $1
          AND pickup_time < $2
          AND status NOT IN (${CANCELLED_STATUSES.map(
            (_, i) => `$${i + 3}`
          ).join(", ")})
        `,
        [
          hourStartUtc.toISOString(),
          hourEndUtc.toISOString(),
          ...CANCELLED_STATUSES,
        ]
      );

      const capCount = parseInt(capRes.rows[0]?.count ?? "0", 10);
      if (capCount >= maxRidesPerHour) {
        continue;
      }

      // Overlap check: no ride within ±overlapBuffer minutes for this user.
      const overlapStartUtc = addMinutes(pickupTimeUtc, -overlapBuffer);
      const overlapEndUtc = addMinutes(pickupTimeUtc, overlapBuffer);

      const overlapRes = await pool.query(
        `
        SELECT 1
        FROM rides
        WHERE user_id = $1
          AND pickup_time >= $2
          AND pickup_time <= $3
          AND status NOT IN (${CANCELLED_STATUSES.map(
            (_, i) => `$${i + 4}`
          ).join(", ")})
        LIMIT 1
        `,
        [
          userId,
          overlapStartUtc.toISOString(),
          overlapEndUtc.toISOString(),
          ...CANCELLED_STATUSES,
        ]
      );

          if ((overlapRes.rowCount ?? 0) > 0) {
        // Already have a ride near this time; skip to avoid duplicates.
        continue;
      }


      // If we reached here, we can safely create the ride.
      if (standardRemaining <= 0) break;

      const insertRes = await pool.query(
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
        )
        VALUES (
          $1, $2, $3,
          $4, $5, $6, $7,
          $8, $9, $10, $11, $12, $13,
          'standard',
          'pending',
          $14
        )
        RETURNING id
        `,
        [
          userId,
          from.address,
          to.address,
          from.lat,
          from.lng,
          to.lat,
          to.lng,
          pickupTimeUtc.toISOString(),
          arrivalTargetUtc.toISOString(),
          pickupWindowStartUtc.toISOString(),
          pickupWindowEndUtc.toISOString(),
          arrivalWindowStartUtc.toISOString(),
          arrivalWindowEndUtc.toISOString(),
          "Auto-generated from weekly schedule",
        ]
      );

      const newRideId: number = insertRes.rows[0].id;

      // Deduct one standard credit for this generated ride.
      await pool.query(
        `
        UPDATE ride_credits_monthly
        SET standard_used = standard_used + 1
        WHERE id = $1
        `,
        [creditsRow.id]
      );

      standardRemaining -= 1;

      console.log(
        "[scheduleGenerator] Created ride %d for user %s on %s (%s). Remaining standard credits: %d",
        newRideId,
        userId,
        arrivalLocal.toISOString(),
        sched.direction,
        standardRemaining
      );
    }
  }
}

// Allow running standalone via "node dist/jobs/generateUpcomingRides.js"
if (require.main === module) {
  const daysArg = process.argv[2];
  const daysAhead = daysArg ? Number(daysArg) || 7 : 7;

  generateUpcomingRides(daysAhead)
    .then(() => {
      console.log("[scheduleGenerator] Done.");
      process.exit(0);
    })
    .catch((err) => {
      console.error("[scheduleGenerator] Error:", err);
      process.exit(1);
    });
}

/**
 * Small admin-friendly wrapper so routes/admin.ts can trigger the job
 * without worrying about parameters.
 */
export async function runGenerateUpcomingRidesJob(): Promise<void> {
  return generateUpcomingRides(7);
}

