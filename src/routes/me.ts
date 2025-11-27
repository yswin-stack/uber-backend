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
 * We match what app/schedule/page.ts expects.
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

type SaveLocationBody = {
  label: SavedLocationLabel;
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
 * --------------------------------------------------
 *  POST /me/locations
 *  Create or update a saved location by label.
 *
 *  Body:
 *    {
 *      label: "home" | "work" | "school" | "other";
 *      address: string;
 *    }
 *
 *  Behaviour:
 *    - If row exists for (user_id, label) → UPDATE address
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

    const label = body.label;
    const addressRaw = body.address;

    if (
      label !== "home" &&
      label !== "work" &&
      label !== "school" &&
      label !== "other"
    ) {
      return res
        .status(400)
        .json(
          fail(
            "INVALID_LABEL",
            "Label must be one of: home, work, school, other."
          )
        );
    }

    const address = (addressRaw || "").trim();
    if (!address) {
      return res
        .status(400)
        .json(
          fail(
            "INVALID_ADDRESS",
            "Address is required to save a location."
          )
        );
    }

    try {
      // Check if a location already exists for this (user, label)
      const existing = await pool.query(
        `
        SELECT id
        FROM saved_locations
        WHERE user_id = $1 AND label = $2
        LIMIT 1
        `,
        [userId, label]
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
          label,
          address,
        };
      } else {
        const insertRes = await pool.query(
          `
          INSERT INTO saved_locations (user_id, label, address)
          VALUES ($1, $2, $3)
          RETURNING id, label, address
          `,
          [userId, label, address]
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
