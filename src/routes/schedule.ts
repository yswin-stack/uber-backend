import { Router, Request, Response } from "express";
import { pool } from "../db/pool";

const scheduleRouter = Router();

function getUserIdFromHeader(req: Request): number | null {
  const h = req.header("x-user-id");
  if (!h) return null;
  const id = parseInt(h, 10);
  if (Number.isNaN(id)) return null;
  return id;
}

/**
 * GET /schedule
 * Returns the weekly schedule for the logged-in user.
 */
scheduleRouter.get("/", async (req: Request, res: Response) => {
  try {
    const userId = getUserIdFromHeader(req);
    if (!userId) {
      return res
        .status(401)
        .json({ error: "Missing or invalid x-user-id header." });
    }

    const result = await pool.query(
      `SELECT id, day_of_week, direction, arrival_time
       FROM user_schedules
       WHERE user_id = $1
       ORDER BY day_of_week ASC, direction ASC`,
      [userId]
    );

    return res.json({
      ok: true,
      schedules: result.rows,
    });
  } catch (err) {
    console.error("Error in GET /schedule:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * POST /schedule/save
 * Body: { days: { dayOfWeek: number, toWorkTime?: string | null, toHomeTime?: string | null }[] }
 * We replace the user's entire weekly schedule with the new one.
 */
scheduleRouter.post("/save", async (req: Request, res: Response) => {
  try {
    const userId = getUserIdFromHeader(req);
    if (!userId) {
      return res
        .status(401)
        .json({ error: "Missing or invalid x-user-id header." });
    }

    const body = req.body as {
      days?: {
        dayOfWeek: number;
        toWorkTime?: string | null;
        toHomeTime?: string | null;
      }[];
    };

    const days = body.days || [];
    if (!Array.isArray(days)) {
      return res.status(400).json({ error: "days must be an array." });
    }

    // Simple approach: clear all existing schedules and reinsert.
    await pool.query("BEGIN");

    await pool.query("DELETE FROM user_schedules WHERE user_id = $1", [
      userId,
    ]);

    for (const d of days) {
      const day = d.dayOfWeek;
      if (day < 0 || day > 6) continue;

      if (d.toWorkTime) {
        await pool.query(
          `INSERT INTO user_schedules (user_id, day_of_week, direction, arrival_time)
           VALUES ($1, $2, $3, $4)`,
          [userId, day, "to_work", d.toWorkTime]
        );
      }
      if (d.toHomeTime) {
        await pool.query(
          `INSERT INTO user_schedules (user_id, day_of_week, direction, arrival_time)
           VALUES ($1, $2, $3, $4)`,
          [userId, day, "to_home", d.toHomeTime]
        );
      }
    }

    await pool.query("COMMIT");

    return res.json({ ok: true });
  } catch (err) {
    console.error("Error in POST /schedule/save:", err);
    try {
      await pool.query("ROLLBACK");
    } catch (e) {
      console.error("Rollback error:", e);
    }
    return res.status(500).json({ error: "Internal server error." });
  }
});

export default scheduleRouter;
