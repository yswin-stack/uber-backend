import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/auth";
import { ok, fail } from "../lib/apiResponse";
import { getCreditsSummaryForUser } from "../services/subscriptionService";
import { pool } from "../db/pool";

export const meRouter = Router();

/**
 * --------------------------------------------------
 *  GET /me/credits
 *  Returns the user's current ride credits summary
 * --------------------------------------------------
 */
meRouter.get("/credits", requireAuth, async (req: Request, res: Response) => {
  const authUser = req.user;
  if (!authUser) {
    return res
      .status(401)
      .json(fail("UNAUTHENTICATED", "Please log in to view credits."));
  }

  try {
    const summary = await getCreditsSummaryForUser(authUser.id);
    return res.json(ok(summary));
  } catch (err) {
    console.error("Error in GET /me/credits:", err);
    return res
      .status(500)
      .json(fail("CREDITS_FETCH_FAILED", "Failed to load credits summary."));
  }
});

/**
 * Type used by the schedule page on the frontend.
 * We match what app/schedule/page.tsx expects.
 */
type BackendScheduleRow = {
  day_of_week: number;
  kind: "to_work" | "from_work";
  arrival_time: string; // "HH:MM:SS"
  enabled?: boolean;
};

/**
 * Saved locations used by weekly template:
 *  - home
 *  - work
 *  - school
 *  - other
 */
type SavedLocationLabel = "home" | "work" | "school" | "other";

type SavedLocation = {
  id: number;
  label: SavedLocationLabel;
  address: string;
};

// Body can be any string label, we map to SavedLocationLabel internally
type SaveLocationBody = {
  label: string;
  address: string;
};

/**
 * --------------------------------------------------
 *  GET /me/schedule
 *  Returns weekly schedule rows for the logged-in user.
 *
 *  Response (unwrapped by apiClient):
 *    BackendScheduleRow[]
 * --------------------------------------------------
 */
meRouter.get("/schedule", requireAuth, async (req: Request, res: Response) => {
  const authUser = req.user;
  if (!authUser) {
    return res
      .status(401)
      .json(fail("UNAUTHENTICATED", "Please log in to view your schedule."));
  }

  try {
    const result = await pool.query(
      `
      SELECT day_of_week, direction, arrival_time
      FROM user_schedules
      WHERE user_id = $1
      ORDER BY day_of_week ASC, direction ASC
      `,
      [authUser.id]
    );

    const rows: BackendScheduleRow[] = result.rows.map((r: any) => {
      const direction: string = r.direction;
      const kind: "to_work" | "from_work" =
        direction === "to_work" ? "to_work" : "from_work";

      // arrival_time is TIME from Postgres -> ensure "HH:MM:SS"
      let arrival = String(r.arrival_time ?? "").trim();
      if (arrival.length === 5) {
        // "HH:MM" -> "HH:MM:00"
        arrival = `${arrival}:00`;
      }

      return {
        day_of_week: Number(r.day_of_week),
        kind,
        arrival_time: arrival,
        enabled: true,
      };
    });

    // apiClient will unwrap ok(data) → rows
    return res.json(ok(rows));
  } catch (err) {
    console.error("Error in GET /me/schedule:", err);
    return res
      .status(500)
      .json(fail("SCHEDULE_FETCH_FAILED", "Failed to load weekly schedule."));
  }
});

/**
 * --------------------------------------------------
 *  POST /me/schedule
 *  Overwrites the user's weekly schedule template.
 *
 *  Request from frontend:
 *    { schedule: BackendScheduleRow[] }
 *
 *  Mapping:
 *    kind "to_work"   -> direction "to_work"
 *    kind "from_work" -> direction "to_home"
 *
 *  Only rows with enabled !== false and a valid time are saved.
 *  Disabled / empty rows are simply omitted (no row in DB for that slot).
 * --------------------------------------------------
 */
meRouter.post(
  "/schedule",
  requireAuth,
  async (req: Request, res: Response) => {
    const authUser = req.user;
    if (!authUser) {
      return res
        .status(401)
        .json(fail("UNAUTHENTICATED", "Please log in to save your schedule."));
    }

    const userId = authUser.id;
    const body = req.body || {};
    const schedule = body.schedule as BackendScheduleRow[] | undefined;

    if (!Array.isArray(schedule)) {
      return res
        .status(400)
        .json(
          fail(
            "INVALID_SCHEDULE",
            "Request body must include a 'schedule' array."
          )
        );
    }

    // Normalise + validate
    const cleaned: {
      day_of_week: number;
      direction: "to_work" | "to_home";
      arrival_time: string; // "HH:MM:SS"
    }[] = [];

    for (const row of schedule) {
      if (!row) continue;

      const day = Number(row.day_of_week);
      if (!Number.isInteger(day) || day < 0 || day > 6) {
        console.warn("Skipping invalid day_of_week in schedule row:", row);
        continue;
      }

      const kind = row.kind;
      if (kind !== "to_work" && kind !== "from_work") {
        console.warn("Skipping invalid kind in schedule row:", row);
        continue;
      }

      // If explicitly disabled, skip
      if (row.enabled === false) {
        continue;
      }

      let arrival = (row.arrival_time || "").trim();
      if (!arrival) {
        // No time selected = effectively disabled for that direction
        continue;
      }

      // Normalise time into "HH:MM:SS"
      if (/^\d{1,2}:\d{2}$/.test(arrival)) {
        arrival = `${arrival}:00`;
      } else if (!/^\d{1,2}:\d{2}:\d{2}$/.test(arrival)) {
        console.warn("Skipping invalid arrival_time in schedule row:", row);
        continue;
      }

      const direction: "to_work" | "to_home" =
        kind === "to_work" ? "to_work" : "to_home";

      cleaned.push({
        day_of_week: day,
        direction,
        arrival_time: arrival,
      });
    }

    try {
      await pool.query("BEGIN");

      // Clear existing schedule for this user
      await pool.query(
        `
        DELETE FROM user_schedules
        WHERE user_id = $1
        `,
        [userId]
      );

      // Insert new rows
      for (const row of cleaned) {
        await pool.query(
          `
          INSERT INTO user_schedules (user_id, day_of_week, direction, arrival_time)
          VALUES ($1, $2, $3, $4)
          `,
          [userId, row.day_of_week, row.direction, row.arrival_time]
        );
      }

      await pool.query("COMMIT");

      return res.json(
        ok({
          saved: cleaned.length,
        })
      );
    } catch (err) {
      console.error("Error in POST /me/schedule:", err);
      try {
        await pool.query("ROLLBACK");
      } catch (rollbackErr) {
        console.error("Rollback error in POST /me/schedule:", rollbackErr);
      }
      return res
        .status(500)
        .json(fail("SCHEDULE_SAVE_FAILED", "Failed to save weekly schedule."));
    }
  }
);

/**
 * --------------------------------------------------
 *  GET /me/locations
 *  Returns saved locations for this user:
 *    - home
 *    - work
 *    - school
 *    - other
 *
 *  Response (unwrapped by apiClient):
 *    {
 *      locations: SavedLocation[]
 *    }
 * --------------------------------------------------
 */
meRouter.get(
  "/locations",
  requireAuth,
  async (req: Request, res: Response) => {
    const authUser = req.user;
    if (!authUser) {
      return res
        .status(401)
        .json(fail("UNAUTHENTICATED", "Please log in to view locations."));
    }

    const userId = authUser.id;

    try {
      const result = await pool.query(
        `
        SELECT id, label, address
        FROM saved_locations
        WHERE user_id = $1
          AND label IN ('home', 'work', 'school', 'other')
        ORDER BY label ASC, id ASC
        `,
        [userId]
      );

      const locations: SavedLocation[] = result.rows.map((r: any) => ({
        id: Number(r.id),
        label: r.label as SavedLocationLabel,
        address: String(r.address ?? "").trim(),
      }));

      return res.json(ok({ locations }));
    } catch (err) {
      console.error("Error in GET /me/locations:", err);
      return res
        .status(500)
        .json(fail("LOCATIONS_FETCH_FAILED", "Failed to load locations."));
    }
  }
);

/**
 * Helper: normalise any label string into one of:
 *   "home" | "work" | "school" | "other"
 */
function normaliseLocationLabel(raw: string | undefined): SavedLocationLabel {
  const v = (raw || "").toString().toLowerCase().trim();

  if (!v) return "other";
  if (v.includes("home") || v === "house") return "home";
  if (v.includes("work") || v.includes("office") || v.includes("job")) {
    return "work";
  }
  if (
    v.includes("school") ||
    v.includes("campus") ||
    v.includes("uni") ||
    v.includes("university") ||
    v.includes("college")
  ) {
    return "school";
  }
  if (v === "other") return "other";

  return "other";
}

/**
 * --------------------------------------------------
 *  POST /me/locations
 *  Create or update a saved location by label.
 *
 *  Body:
 *    {
 *      label: string;   // will be normalised to home/work/school/other
 *      address: string;
 *    }
 *
 *  Behaviour:
 *    - If row exists for (user_id, normalised_label) → UPDATE address
 *    - Else → INSERT new row
 * --------------------------------------------------
 */
meRouter.post(
  "/locations",
  requireAuth,
  async (req: Request, res: Response) => {
    const authUser = req.user;
    if (!authUser) {
      return res
        .status(401)
        .json(fail("UNAUTHENTICATED", "Please log in to save locations."));
    }

    const userId = authUser.id;
    const body = (req.body || {}) as Partial<SaveLocationBody>;

    const canonicalLabel: SavedLocationLabel = normaliseLocationLabel(
      body.label
    );
    const address = (body.address || "").trim();

    if (!address) {
      return res
        .status(400)
        .json(
          fail("INVALID_ADDRESS", "Address is required to save a location.")
        );
    }

    try {
      // Check if a location already exists for this (user, canonicalLabel)
      const existing = await pool.query(
        `
        SELECT id
        FROM saved_locations
        WHERE user_id = $1 AND label = $2
        LIMIT 1
        `,
        [userId, canonicalLabel]
      );

      let saved: SavedLocation;

      if (existing.rowCount && existing.rows.length > 0) {
        const id = existing.rows[0].id;

        await pool.query(
          `
          UPDATE saved_locations
          SET address = $1
          WHERE id = $2
          `,
          [address, id]
        );

        saved = {
          id: Number(id),
          label: canonicalLabel,
          address,
        };
      } else {
        const insertRes = await pool.query(
          `
          INSERT INTO saved_locations (user_id, label, address)
          VALUES ($1, $2, $3)
          RETURNING id, label, address
          `,
          [userId, canonicalLabel, address]
        );

        const row = insertRes.rows[0];
        saved = {
          id: Number(row.id),
          label: row.label as SavedLocationLabel,
          address: String(row.address ?? "").trim(),
        };
      }

      return res.json(ok({ location: saved }));
    } catch (err) {
      console.error("Error in POST /me/locations:", err);
      return res
        .status(500)
        .json(
          fail(
            "LOCATION_SAVE_FAILED",
            "Failed to save this location. Please try again."
          )
        );
    }
  }
);

/**
 * --------------------------------------------------
 *  POST /me/schedule/generate-rides
 *
 *  Use the weekly schedule template + saved locations
 *  to generate real rides into the "rides" table,
 *  consuming standard ride credits.
 *
 *  Optional body:
 *    { maxRides?: number }
 *  If provided, this caps how many rides we generate.
 *  Otherwise we try to infer from credits.
 * --------------------------------------------------
meRouter.post(
  "/schedule/generate-rides",
  requireAuth,
  async (req: Request, res: Response) => {
    const authUser = req.user;
    if (!authUser) {
      return res
        .status(401)
        .json(fail("UNAUTHENTICATED", "Please log in to generate rides."));
    }

    const userId = authUser.id;
    const body = (req.body || {}) as { maxRides?: number };

    try {
      // 1) Load weekly schedule for this user
      const scheduleRes = await pool.query(
        `
        SELECT day_of_week, direction, arrival_time
        FROM user_schedules
        WHERE user_id = $1
        ORDER BY day_of_week ASC, direction ASC
        `,
        [userId]
      );

      if (!scheduleRes.rowCount || scheduleRes.rows.length === 0) {
        return res.status(400).json(
          fail(
            "NO_SCHEDULE",
            "You need to set up a weekly schedule before generating rides."
          )
        );
      }

      const scheduleRows = scheduleRes.rows.map((r: any) => ({
        day_of_week: Number(r.day_of_week),
        direction: String(r.direction) as "to_work" | "to_home",
        arrival_time: String(r.arrival_time ?? "").trim(), // TIME
      })) as {
        day_of_week: number;
        direction: "to_work" | "to_home";
        arrival_time: string;
      }[];

      // 2) Load saved locations (home, work, school)
      const locRes = await pool.query(
        `
        SELECT label, address
        FROM saved_locations
        WHERE user_id = $1
          AND label IN ('home', 'work', 'school')
        `,
        [userId]
      );

      let homeAddress = "";
      let workAddress = "";
      let schoolAddress = "";

      for (const row of locRes.rows as { label: string; address: string }[]) {
        const label = row.label as SavedLocationLabel;
        const addr = (row.address || "").trim();
        if (label === "home") homeAddress = addr;
        if (label === "work") workAddress = addr;
        if (label === "school") schoolAddress = addr;
      }

      if (!homeAddress) {
        return res.status(400).json(
          fail(
            "NO_HOME_LOCATION",
            "Please set a home address before generating rides."
          )
        );
      }

      // Prefer "work" for destination, fallback to "school"
      const destinationAddress = workAddress || schoolAddress;
      if (!destinationAddress) {
        return res.status(400).json(
          fail(
            "NO_WORK_LOCATION",
            "Please set a work or school address before generating rides."
          )
        );
      }

      // 3) Determine how many rides we are allowed to generate
      let ridesRemaining: number | null = null;
      let creditsLoaded = false;

      // a) If caller passes an explicit maxRides, we respect that first
      if (typeof body.maxRides === "number" && body.maxRides > 0) {
        ridesRemaining = body.maxRides;
      }

      // b) Otherwise, try to infer from credits summary
      if (ridesRemaining === null) {
        try {
          const credits: any = await getCreditsSummaryForUser(userId);

          const candidates: (number | undefined)[] = [
            credits?.standardRidesRemaining,
            credits?.standard_rides_remaining,
            credits?.standard?.remaining,
            credits?.standard?.ridesRemaining,
          ];

          const numeric = candidates.filter(
            (v) => typeof v === "number" && !Number.isNaN(v)
          ) as number[];

          if (numeric.length > 0) {
            ridesRemaining = numeric[0];
            creditsLoaded = true;
          }
        } catch (err) {
          console.warn(
            "Failed to load credits summary inside /me/schedule/generate-rides:",
            err
          );
        }
      }

      // c) If we *still* don't have anything, fall back to a safe default
      if (ridesRemaining === null || ridesRemaining <= 0) {
        if (!creditsLoaded) {
          // we don't actually know the real credit count, so assume 40 for now
          ridesRemaining = 40;
        }
      }

      // If we DID load credits and they say 0 or negative, respect that
      if (creditsLoaded && (ridesRemaining === null || ridesRemaining <= 0)) {
        return res.status(400).json(
          fail(
            "NO_CREDITS",
            "You don't have any standard rides available to generate."
          )
        );
      }

      // 4) Generate rides from today forward (e.g. next 60 days)
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const horizon = new Date(today);
      horizon.setDate(horizon.getDate() + 60); // 60-day horizon

      function getScheduleForDow(dow: number) {
        return scheduleRows.filter((row) => row.day_of_week === dow);
      }

      function buildDateTime(base: Date, timeStr: string): Date | null {
        const clean = timeStr.trim();
        if (!clean) return null;

        const parts = clean.split(":");
        if (parts.length < 2) return null;

        const hh = Number(parts[0]);
        const mm = Number(parts[1]);

        if (
          Number.isNaN(hh) ||
          Number.isNaN(mm) ||
          hh < 0 ||
          hh > 23 ||
          mm < 0 ||
          mm > 59
        ) {
          return null;
        }

        const dt = new Date(base);
        dt.setHours(hh, mm, 0, 0);
        return dt;
      }

      let createdCount = 0;

      await pool.query("BEGIN");

      for (
        let cursor = new Date(today);
        cursor <= horizon && (ridesRemaining ?? 0) > 0;
        cursor.setDate(cursor.getDate() + 1)
      ) {
        const dow = cursor.getDay(); // 0=Sunday ... 6=Saturday
        const rowsForDay = getScheduleForDow(dow);

        if (!rowsForDay.length) continue;

        for (const row of rowsForDay) {
          if ((ridesRemaining ?? 0) <= 0) break;

          const dt = buildDateTime(cursor, row.arrival_time);
          if (!dt) continue;

          const pickupTimeIso = dt.toISOString();

          let pickup_location: string;
          let dropoff_location: string;

          if (row.direction === "to_work") {
            pickup_location = homeAddress;
            dropoff_location = destinationAddress;
          } else {
            pickup_location = destinationAddress;
            dropoff_location = homeAddress;
          }

          await pool.query(
            `
            INSERT INTO rides (rider_id, pickup_location, dropoff_location, pickup_time, status)
            VALUES ($1, $2, $3, $4, 'scheduled')
            `,
            [userId, pickup_location, dropoff_location, pickupTimeIso]
          );

          ridesRemaining = (ridesRemaining ?? 0) - 1;
          createdCount += 1;

          if ((ridesRemaining ?? 0) <= 0) break;
        }
      }

      await pool.query("COMMIT");

      return res.json(
        ok({
          created: createdCount,
          remainingCredits: ridesRemaining,
        })
      );
    } catch (err) {
      console.error("Error in POST /me/schedule/generate-rides:", err);
      try {
        await pool.query("ROLLBACK");
      } catch (rollbackErr) {
        console.error(
          "Rollback error in POST /me/schedule/generate-rides:",
          rollbackErr
        );
      }
      return res
        .status(500)
        .json(
          fail(
            "GENERATE_RIDES_FAILED",
            "Failed to generate rides from your schedule."
          )
        );
    }
  }
);


    const userId = authUser.id;
    const body = (req.body || {}) as { maxRides?: number };

    try {
      // 1) Load weekly schedule for this user
      const scheduleRes = await pool.query(
        `
        SELECT day_of_week, direction, arrival_time
        FROM user_schedules
        WHERE user_id = $1
        ORDER BY day_of_week ASC, direction ASC
        `,
        [userId]
      );

      if (!scheduleRes.rowCount || scheduleRes.rows.length === 0) {
        return res.status(400).json(
          fail(
            "NO_SCHEDULE",
            "You need to set up a weekly schedule before generating rides."
          )
        );
      }

      const scheduleRows = scheduleRes.rows.map((r: any) => ({
        day_of_week: Number(r.day_of_week),
        direction: String(r.direction) as "to_work" | "to_home",
        arrival_time: String(r.arrival_time ?? "").trim(), // TIME
      })) as {
        day_of_week: number;
        direction: "to_work" | "to_home";
        arrival_time: string;
      }[];

      // 2) Load saved locations (home, work, school)
      const locRes = await pool.query(
        `
        SELECT label, address
        FROM saved_locations
        WHERE user_id = $1
          AND label IN ('home', 'work', 'school')
        `,
        [userId]
      );

      let homeAddress = "";
      let workAddress = "";
      let schoolAddress = "";

      for (const row of locRes.rows as { label: string; address: string }[]) {
        const label = row.label as SavedLocationLabel;
        const addr = (row.address || "").trim();
        if (label === "home") homeAddress = addr;
        if (label === "work") workAddress = addr;
        if (label === "school") schoolAddress = addr;
      }

      if (!homeAddress) {
        return res.status(400).json(
          fail(
            "NO_HOME_LOCATION",
            "Please set a home address before generating rides."
          )
        );
      }

      // Prefer "work" for destination, fallback to "school"
      const destinationAddress = workAddress || schoolAddress;
      if (!destinationAddress) {
        return res.status(400).json(
          fail(
            "NO_WORK_LOCATION",
            "Please set a work or school address before generating rides."
          )
        );
      }

      // 3) Determine how many rides we are allowed to generate
      let ridesRemaining: number | null = null;

      // a) If caller passes an explicit maxRides, we respect that
      if (typeof body.maxRides === "number" && body.maxRides > 0) {
        ridesRemaining = body.maxRides;
      } else {
        // b) Otherwise, try to infer from credits summary
        try {
          const credits: any = await getCreditsSummaryForUser(userId);
          // You may need to adjust this depending on your real summary shape.
          // Try several common field names without breaking anything.
          const candidates: (number | undefined)[] = [
            credits?.standardRidesRemaining,
            credits?.standard_rides_remaining,
            credits?.standard?.remaining,
            credits?.standard?.ridesRemaining,
          ].filter((v) => typeof v === "number");

          if (candidates.length > 0) {
            ridesRemaining = candidates[0] as number;
          }
        } catch (err) {
          console.warn(
            "Failed to load credits summary inside /me/schedule/generate-rides:",
            err
          );
        }
      }

      if (ridesRemaining === null || ridesRemaining <= 0) {
        return res.status(400).json(
          fail(
            "NO_CREDITS",
            "You don't have any standard rides available to generate."
          )
        );
      }

      // 4) Generate rides from today forward (e.g. next 60 days)
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const horizon = new Date(today);
      horizon.setDate(horizon.getDate() + 60); // 60-day horizon

      // Helper to find schedule rows for a day_of_week
      function getScheduleForDow(dow: number) {
        return scheduleRows.filter((row) => row.day_of_week === dow);
      }

      // Helper to build a JS Date from a base date and "HH:MM:SS"
      function buildDateTime(base: Date, timeStr: string): Date | null {
        const clean = timeStr.trim();
        if (!clean) return null;

        const parts = clean.split(":");
        if (parts.length < 2) return null;

        const hh = Number(parts[0]);
        const mm = Number(parts[1]);

        if (
          Number.isNaN(hh) ||
          Number.isNaN(mm) ||
          hh < 0 ||
          hh > 23 ||
          mm < 0 ||
          mm > 59
        ) {
          return null;
        }

        const dt = new Date(base);
        dt.setHours(hh, mm, 0, 0);
        return dt;
      }

      let createdCount = 0;

      await pool.query("BEGIN");

      // Iterate day by day until horizon or until credits are used
      for (
        let cursor = new Date(today);
        cursor <= horizon && ridesRemaining > 0;
        cursor.setDate(cursor.getDate() + 1)
      ) {
        const dow = cursor.getDay(); // 0=Sunday ... 6=Saturday
        const rowsForDay = getScheduleForDow(dow);

        if (!rowsForDay.length) continue;

        for (const row of rowsForDay) {
          if (ridesRemaining <= 0) break;

          const dt = buildDateTime(cursor, row.arrival_time);
          if (!dt) continue;

          // For now, we treat arrival_time as pickup_time.
          // (Later you can subtract travel buffer to turn into a pickup window.)
          const pickupTimeIso = dt.toISOString();

          let pickup_location: string;
          let dropoff_location: string;

          if (row.direction === "to_work") {
            pickup_location = homeAddress;
            dropoff_location = destinationAddress;
          } else {
            // to_home
            pickup_location = destinationAddress;
            dropoff_location = homeAddress;
          }

          // Insert a basic scheduled ride.
          // We only use columns we know exist from earlier code:
          //   id, rider_id, pickup_time, status, pickup_location, dropoff_location
          await pool.query(
            `
            INSERT INTO rides (rider_id, pickup_location, dropoff_location, pickup_time, status)
            VALUES ($1, $2, $3, $4, 'scheduled')
            `,
            [userId, pickup_location, dropoff_location, pickupTimeIso]
          );

          ridesRemaining -= 1;
          createdCount += 1;

          if (ridesRemaining <= 0) break;
        }
      }

      await pool.query("COMMIT");

      return res.json(
        ok({
          created: createdCount,
          remainingCredits: ridesRemaining,
        })
      );
    } catch (err) {
      console.error("Error in POST /me/schedule/generate-rides:", err);
      try {
        await pool.query("ROLLBACK");
      } catch (rollbackErr) {
        console.error(
          "Rollback error in POST /me/schedule/generate-rides:",
          rollbackErr
        );
      }
      return res
        .status(500)
        .json(
          fail(
            "GENERATE_RIDES_FAILED",
            "Failed to generate rides from your schedule."
          )
        );
    }
  }
);

/**
 * --------------------------------------------------
 *  POST /me/rides/:rideId/cancel
 *  Allow rider to cancel own ride, but only up to
 *  15 minutes before pickup_time.
 *
 *  Response:
 *    { id: number; status: string }
 * --------------------------------------------------
 */
meRouter.post(
  "/rides/:rideId/cancel",
  requireAuth,
  async (req: Request, res: Response) => {
    const authUser = req.user;
    if (!authUser) {
      return res
        .status(401)
        .json(fail("UNAUTHENTICATED", "Please log in to cancel a ride."));
    }

    const rideId = Number(req.params.rideId);
    if (!Number.isInteger(rideId) || rideId <= 0) {
      return res
        .status(400)
        .json(fail("INVALID_RIDE_ID", "Ride id must be a positive integer."));
    }

    try {
      // Fetch ride for this user
      const rideRes = await pool.query(
        `
        SELECT id, rider_id, pickup_time, status
        FROM rides
        WHERE id = $1 AND rider_id = $2
        LIMIT 1
        `,
        [rideId, authUser.id]
      );

      if (!rideRes.rowCount || rideRes.rows.length === 0) {
        return res
          .status(404)
          .json(fail("RIDE_NOT_FOUND", "Ride not found for this user."));
      }

      const ride = rideRes.rows[0] as {
        id: number;
        rider_id: number;
        pickup_time: string | null;
        status: string;
      };

      if (!ride.pickup_time) {
        return res
          .status(400)
          .json(
            fail(
              "NO_PICKUP_TIME",
              "This ride cannot be cancelled right now."
            )
          );
      }

      const pickup = new Date(ride.pickup_time);
      if (Number.isNaN(pickup.getTime())) {
        return res
          .status(400)
          .json(
            fail(
              "INVALID_PICKUP_TIME",
              "This ride has an invalid pickup time."
            )
          );
      }

      const now = new Date();
      const diffMinutes = (pickup.getTime() - now.getTime()) / 60000;

      if (diffMinutes < 15) {
        return res.status(400).json(
          fail(
            "CANCEL_WINDOW_PASSED",
            "Rides can only be cancelled up to 15 minutes before pickup."
          )
        );
      }

      // Optional: block cancelling once already completed/cancelled
      if (
        ride.status === "completed" ||
        ride.status === "cancelled" ||
        ride.status === "cancelled_by_user" ||
        ride.status === "cancelled_by_admin" ||
        ride.status === "no_show"
      ) {
        return res
          .status(400)
          .json(
            fail(
              "CANNOT_CANCEL",
              "This ride can no longer be cancelled."
            )
          );
      }

      await pool.query(
        `
        UPDATE rides
        SET status = 'cancelled_by_user'
        WHERE id = $1
        `,
        [rideId]
      );

      return res.json(
        ok({
          id: rideId,
          status: "cancelled_by_user",
        })
      );
    } catch (err) {
      console.error("Error in POST /me/rides/:rideId/cancel:", err);
      return res
        .status(500)
        .json(
          fail(
            "CANCEL_FAILED",
            "Failed to cancel this ride. Please try again."
          )
        );
    }
  }
);

/**
 * --------------------------------------------------
 *  GET /me/setup
 *  Simple onboarding flags.
 *
 *  {
 *    has_home: boolean;
 *    has_work: boolean;   // work OR school
 *    has_schedule: boolean;
 *  }
 * --------------------------------------------------
 */

// Helper to satisfy TypeScript for rowCount (number | null)
function hasAnyRows(
  result: { rowCount: number | null } | null | undefined
): boolean {
  return !!result && typeof result.rowCount === "number" && result.rowCount > 0;
}

meRouter.get("/setup", requireAuth, async (req: Request, res: Response) => {
  const authUser = req.user;
  if (!authUser) {
    return res
      .status(401)
      .json(fail("UNAUTHENTICATED", "Please log in to view setup status."));
  }

  const userId = authUser.id;

  try {
    const [homeRes, workRes, scheduleRes] = await Promise.all([
      pool.query(
        `
        SELECT 1
        FROM saved_locations
        WHERE user_id = $1 AND label = 'home'
        LIMIT 1
        `,
        [userId]
      ),
      pool.query(
        `
        SELECT 1
        FROM saved_locations
        WHERE user_id = $1 AND (label = 'work' OR label = 'school')
        LIMIT 1
        `,
        [userId]
      ),
      pool.query(
        `
        SELECT 1
        FROM user_schedules
        WHERE user_id = $1
        LIMIT 1
        `,
        [userId]
      ),
    ]);

    const has_home = hasAnyRows(homeRes);
    const has_work = hasAnyRows(workRes);
    const has_schedule = hasAnyRows(scheduleRes);

    return res.json(
      ok({
        has_home,
        has_work,
        has_schedule,
      })
    );
  } catch (err) {
    console.error("Error in GET /me/setup:", err);
    return res
      .status(500)
      .json(fail("SETUP_CHECK_FAILED", "Failed to check setup status."));
  }
});

export default meRouter;
