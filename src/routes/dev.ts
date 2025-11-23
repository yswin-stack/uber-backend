import { Router, Request, Response } from "express";
import { pool } from "../db/pool";

const devRouter = Router();

/**
 * POST /dev/create-test-user
 * Body: { phone: string, pin: string, name?: string, email?: string, role?: "subscriber"|"driver"|"admin" }
 * Quick helper for seeding users without SQL console.
 */
devRouter.post("/create-test-user", async (req: Request, res: Response) => {
  try {
    const {
      phone,
      pin,
      name,
      email,
      role,
    } = req.body as {
      phone?: string;
      pin?: string;
      name?: string;
      email?: string;
      role?: "subscriber" | "driver" | "admin";
    };

    if (!phone || !pin) {
      return res
        .status(400)
        .json({ error: "phone and pin are required for test user" });
    }

    const finalRole: "subscriber" | "driver" | "admin" =
      role || "subscriber";

    const result = await pool.query(
      `INSERT INTO users (email, name, role, phone, pin)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, email, name, role, phone`,
      [email ?? null, name ?? null, finalRole, phone, pin]
    );

    return res.json({
      ok: true,
      user: result.rows[0],
    });
  } catch (err) {
    console.error("Error creating test user:", err);
    return res
      .status(500)
      .json({ error: "Internal server error creating test user" });
  }
});

/**
 * POST /dev/init-schedule-table
 * One-time helper to create the user_schedules table if it doesn't exist.
 */
devRouter.get(
  "/init-schedule-table",
  async (req: Request, res: Response) => {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS user_schedules (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          day_of_week INTEGER NOT NULL, -- 0=Sunday, 6=Saturday
          direction VARCHAR(20) NOT NULL, -- 'to_work' or 'to_home'
          arrival_time TIME NOT NULL,
          created_at TIMESTAMPTZ DEFAULT now()
        );
      `);

      return res.json({ ok: true, message: "user_schedules table ensured." });
    } catch (err) {
      console.error("Error creating user_schedules table:", err);
      return res
        .status(500)
        .json({ error: "Failed to init user_schedules table" });
    }
  }
);

export default devRouter;
