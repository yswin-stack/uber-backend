import { Router, Request, Response } from "express";
import { pool } from "../db/pool";

const devRouter = Router();

/**
 * POST /dev/create-user
 * Create a user without using SQL console.
 */
devRouter.post("/create-user", async (req: Request, res: Response) => {
  try {
    const { phone, pin } = req.body;

    if (!phone || !pin) {
      return res.status(400).json({ error: "phone and pin required" });
    }

    const result = await pool.query(
      `
      INSERT INTO users (phone, pin)
      VALUES ($1, $2)
      RETURNING id, phone;
      `,
      [phone, pin]
    );

    return res.json({
      ok: true,
      userId: result.rows[0].id,
      phone: result.rows[0].phone,
    });
  } catch (err) {
    console.error("Error creating user:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default devRouter;
