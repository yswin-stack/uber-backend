import { Router, Request, Response } from "express";
import { pool } from "../db/pool";

export const scheduleRouter = Router();

function getUserIdFromHeader(req: Request): number | null {
  const header = req.header("x-user-id");
  if (!header) return null;
  const id = parseInt(header, 10);
  return Number.isNaN(id) ? null : id;
}

// GET current weekly schedule
scheduleRouter.get("/", async (req: Request, res: Response) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) {
    return res.status(401).json({ error: "Missing or invalid x-user-id" });
  }

  try {
    const result = await pool.query(
      `
      SELECT id,
             day_of_week,
             arrival_start,
             arrival_end,
             pickup_address,
             dropoff_address,
             direction,
             active
      FROM weekly_schedule
      WHERE user_id = $1
      ORDER BY day_of_week ASC, direction ASC
    `,
      [userId]
    );

    res.json({ schedule: result.rows });
  } catch (err: any) {
    console.error("Error in GET /schedule", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST/PUT weekly schedule
// Expect: schedule: array of { day_of_week, arrival_start, arrival_end, pickup_address, dropoff_address, direction, active }
scheduleRouter.put("/", async (req: Request, res: Response) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) {
    return res.status(401).json({ error: "Missing or invalid x-user-id" });
  }

  const schedule = req.body.schedule as
    | {
        day_of_week: number;
        arrival_start: string;
        arrival_end: string;
        pickup_address: string;
        dropoff_address: string;
        direction: "to_work" | "to_home";
        active?: boolean;
      }[]
    | undefined;

  if (!Array.isArray(schedule)) {
    return res
      .status(400)
      .json({ error: "schedule must be an array of entries" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // For simplicity, we just wipe and insert
    await client.query(
      `DELETE FROM weekly_schedule WHERE user_id = $1`,
      [userId]
    );

    for (const item of schedule) {
      if (
        item.day_of_week < 0 ||
        item.day_of_week > 6 ||
        !item.arrival_start ||
        !item.arrival_end ||
        !item.pickup_address ||
        !item.dropoff_address ||
        (item.direction !== "to_work" && item.direction !== "to_home")
      ) {
        continue;
      }

      await client.query(
        `
        INSERT INTO weekly_schedule (
          user_id,
          day_of_week,
          arrival_start,
          arrival_end,
          pickup_address,
          dropoff_address,
          direction,
          active
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, TRUE))
      `,
        [
          userId,
          item.day_of_week,
          item.arrival_start,
          item.arrival_end,
          item.pickup_address,
          item.dropoff_address,
          item.direction,
          item.active ?? true,
        ]
      );
    }

    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (err: any) {
    await client.query("ROLLBACK");
    console.error("Error in PUT /schedule", err);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    client.release();
  }
});
