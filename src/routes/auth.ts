import express from "express";
import { pool } from "../db/pool";

const authRouter = express.Router();

// Your super-admin phone (normalized)
const ADMIN_PHONE = "+14313389073";

/**
 * Normalize phone into a canonical format that matches DB.
 */
export function normalizePhone(input: string): string {
  const trimmed = input.trim();
  const digits = trimmed.replace(/\D/g, "");

  // 10 digits -> +1XXXXXXXXXX
  if (digits.length === 10) {
    return `+1${digits}`;
  }

  // Already has +
  if (trimmed.startsWith("+")) {
    return trimmed;
  }

  // 11 digits starting with 1 -> +XXXXXXXXXXX
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }

  return trimmed;
}

/**
 * POST /auth/login
 * Body: { phone, pin }
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

    // Decide role based on the normalized phone they used to log in
    let role: string = user.role || "rider";

    if (normalizedPhone === ADMIN_PHONE) {
      role = "admin";
      try {
        // keep DB in sync too
        await pool.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [
          user.id,
        ]);
      } catch (err) {
        console.error("Failed to update user role to admin:", err);
      }
    }

    const safeUser = {
      id: user.id,
      name: user.name,
      phone: user.phone,
      email: user.email,
      role,
    };

    return res.json({
      user: safeUser,
      token: null, // JWT later
    });
  } catch (err) {
    console.error("Error in POST /auth/login:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /auth/register
 * Body: { phone, pin, name?, email? }
 */
 const nameVal: string | null = name ? String(name).trim() : null;

// Email must be unique + not null due to DB schema.
// If user didn’t provide an email, generate a unique placeholder.
let emailVal: string = email ? String(email).trim() : "";

if (!emailVal) {
  const safePhone = normalizedPhone.replace(/[^0-9+]/g, "");
  emailVal = `${safePhone}@placeholder.local`;
}


  // Email must satisfy UNIQUE NOT NULL in many DB setups.
  // If user didn't give one, synthesize a unique placeholder based on phone.
  let emailVal: string = email ? String(email).trim() : "";
  if (!emailVal) {
    emailVal = `${normalizedPhone.replace(/[^0-9+]/g, "")}@placeholder.local`;
  }

  try {
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
