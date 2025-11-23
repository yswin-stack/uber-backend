import express from "express";
import { pool } from "../db/pool";

const authRouter = express.Router();

/**
 * Normalize phone into a canonical format that matches DB.
 * - If user types 10-digit number like 204XXXXXXX → +1XXXXXXXXXX
 * - If starts with "+", keep as-is
 * - If 11 digits starting with "1" → +1XXXXXXXXXX
 * - Else fallback to trimmed string
 */
function normalizePhone(input: string): string {
  const trimmed = input.trim();
  const digits = trimmed.replace(/\D/g, "");

  if (digits.length === 10) {
    // e.g. 2041234567
    return `+1${digits}`;
  }

  if (trimmed.startsWith("+")) {
    return trimmed;
  }

  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }

  return trimmed;
}

/**
 * POST /auth/login
 * Body: { phone: string, pin: string }
 * Returns: { user: { id, name, phone, email, role } }
 */
authRouter.post("/login", async (req, res) => {
  const { phone, pin } = req.body || {};

  if (!phone || !pin) {
    return res
      .status(400)
      .json({ error: "Phone and 4-digit PIN are required." });
  }

  if (typeof pin !== "string" || !/^\d{4}$/.test(pin)) {
    return res.status(400).json({ error: "PIN must be 4 digits." });
  }

  const normalizedPhone = normalizePhone(String(phone));

  try {
    const result = await pool.query(
      `
      SELECT id, name, phone, email, pin, role
      FROM users
      WHERE phone = $1
    `,
      [normalizedPhone]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Invalid phone or PIN." });
    }

    const user = result.rows[0];

    if (!user.pin || String(user.pin) !== pin) {
      return res.status(401).json({ error: "Invalid phone or PIN." });
    }

    // Strip pin from response
    const safeUser = {
      id: user.id,
      name: user.name,
      phone: user.phone,
      email: user.email,
      role: user.role || "rider",
    };

    return res.json({
      user: safeUser,
      // token is optional for now; frontend already handles missing token
      token: null,
    });
  } catch (err) {
    console.error("Error in POST /auth/login:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /auth/register
 * Simple rider signup used by your "Register" page.
 * Body: { phone, pin, name?, email? }
 * Returns: { user: { id, name, phone, email, role } }
 */
authRouter.post("/register", async (req, res) => {
  const { phone, pin, name, email } = req.body || {};

  if (!phone || !pin) {
    return res
      .status(400)
      .json({ error: "Phone and 4-digit PIN are required." });
  }

  if (typeof pin !== "string" || !/^\d{4}$/.test(pin)) {
    return res.status(400).json({ error: "PIN must be 4 digits." });
  }

  const normalizedPhone = normalizePhone(String(phone));
  const nameVal: string | null = name ? String(name).trim() : null;
  // Some DBs have email NOT NULL; we avoid null by using empty string if absent
  const emailVal: string = email ? String(email).trim() : "";

  try {
    // Check if phone already exists
    const existing = await pool.query(
      `SELECT id FROM users WHERE phone = $1`,
      [normalizedPhone]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({ error: "User already exists." });
    }

    const insert = await pool.query(
      `
      INSERT INTO users (phone, pin, name, email, role)
      VALUES ($1, $2, $3, $4, 'rider')
      RETURNING id, name, phone, email, role
    `,
      [normalizedPhone, pin, nameVal, emailVal]
    );

    const user = insert.rows[0];

    return res.status(201).json({
      user,
      token: null,
    });
  } catch (err) {
    console.error("Error in POST /auth/register:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default authRouter;
