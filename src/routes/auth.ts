import { Router, Request, Response } from "express";
import { pool } from "../db/pool";

const authRouter = Router();

/**
 * POST /auth/register
 * Register a new user with phone, pin, and email.
 */
authRouter.post("/register", async (req: Request, res: Response) => {
  try {
    const { phone, pin, email } = req.body as {
      phone?: string;
      pin?: string;
      email?: string;
    };

    if (!phone || !pin) {
      return res.status(400).json({ error: "Phone and 4-digit PIN are required." });
    }

    if (pin.length !== 4) {
      return res.status(400).json({ error: "PIN must be 4 digits." });
    }

    // Check if phone already exists
    const existing = await pool.query(
      `
      SELECT id
      FROM users
      WHERE phone = $1
      LIMIT 1;
      `,
      [phone]
    );

    if ((existing.rowCount ?? 0) > 0) {
      return res.status(409).json({ error: "An account with this phone already exists." });
    }

    const safeEmail =
      email && email.trim().length > 0
        ? email.trim()
        : `${phone.replace(/[^0-9+]/g, "")}@temporary.local`;
    const role = "subscriber";

    const result = await pool.query(
      `
      INSERT INTO users (email, role, phone, pin)
      VALUES ($1, $2, $3, $4)
      RETURNING id, email, phone, role;
      `,
      [safeEmail, role, phone, pin]
    );

    const user = result.rows[0];

    return res.json({
      ok: true,
      userId: user.id,
      phone: user.phone,
      email: user.email,
      role: user.role,
    });
  } catch (err) {
    console.error("Error in POST /auth/register", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /auth/login
 * Simple phone + 4-digit PIN login.
 */
authRouter.post("/login", async (req: Request, res: Response) => {
  try {
    const { phone, pin } = req.body as { phone?: string; pin?: string };

    if (!phone || !pin) {
      return res.status(400).json({ error: "Phone and PIN are required." });
    }

    const result = await pool.query(
      `
      SELECT id, email, phone, pin
      FROM users
      WHERE phone = $1
      LIMIT 1;
      `,
      [phone]
    );

    if ((result.rowCount ?? 0) === 0) {
      return res.status(401).json({ error: "Invalid phone or PIN." });
    }

    const user = result.rows[0];

    if (user.pin !== pin) {
      return res.status(401).json({ error: "Invalid phone or PIN." });
    }

    return res.json({
      ok: true,
      userId: user.id,
      phone: user.phone,
      email: user.email,
    });
  } catch (err) {
    console.error("Error in POST /auth/login", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default authRouter;
