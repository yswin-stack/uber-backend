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

    const has_home = homeRes.rowCount > 0;
    const has_work = workRes.rowCount > 0;
    const has_schedule = scheduleRes.rowCount > 0;

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
