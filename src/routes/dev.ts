import { Router, Request, Response } from "express";
import { pool } from "../db/pool";

const devRouter = Router();

/**
 * POST /dev/create-user
 * Create a user without using SQL console.
 * This version also fills a required email + role field if needed.
 */
devRouter.post("/create-user", async (req: Request, res: Response) => {
  try {
    const { phone, pin } = req.body as { phone?: string; pin?: string };

    if (!phone || !pin) {
      return res.status(400).json({ error: "phone and pin required" });
    }

    // Use phone to generate a dummy email that satisfies NOT NULL constraint
    const email = `${phone.replace(/[^0-9+]/g, "")}@temporary.local`;
    const role = "subscriber";

    const result = await pool.query(
      `
      INSERT INTO users (email, role, phone, pin)
      VALUES ($1, $2, $3, $4)
      RETURNING id, email, phone, role;
      `,
      [email, role, phone, pin]
    );

    const user = result.rows[0];

    return res.json({
      ok: true,
      userId: user.id,
      email: user.email,
      phone: user.phone,
      role: user.role,
    });
  } catch (err) {
    console.error("Error creating user:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default devRouter;
