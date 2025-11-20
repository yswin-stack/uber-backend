import { Router, Request, Response } from "express";
import pool from "../db/pool";

const authRouter = Router();

/**
 * POST /auth/login
 * Simple phone + 4-digit PIN login.
 * For now, returns userId and phone if credentials match.
 */
authRouter.post("/login", async (req: Request, res: Response) => {
  try {
    const { phone, pin } = req.body as { phone?: string; pin?: string };

    if (!phone || !pin) {
      return res.status(400).json({ error: "Phone and pin are required." });
    }

    // Adjust column names here if your users table is different
    const result = await pool.query(
      `
      SELECT id, phone, pin
      FROM users
      WHERE phone = $1
      LIMIT 1;
      `,
      [phone]
    );

    if ((result.rowCount ?? 0) === 0) {
      return res.status(401).json({ error: "Invalid phone or pin." });
    }

    const user = result.rows[0];

    if (user.pin !== pin) {
      return res.status(401).json({ error: "Invalid phone or pin." });
    }

    return res.json({
      ok: true,
      userId: user.id,
      phone: user.phone,
    });
  } catch (err) {
    console.error("Error in POST /auth/login", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default authRouter;
