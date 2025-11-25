import express from "express";
import { pool } from "../db/pool";
import { ok, fail } from "../lib/apiResponse";
import jwt from "jsonwebtoken";
import { logEvent } from "../services/analytics";




const authRouter = express.Router();

// Your super-admin phone (normalized)
const ADMIN_PHONE = "+14313389073";

/**
 * Normalize phone into a canonical format that matches DB.
 */
const JWT_SECRET = process.env.JWT_SECRET || "";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";

function signAuthToken(payload: { id: number; role: string; phone?: string | null }) {
  if (!JWT_SECRET) {
    console.warn(
      "[auth] JWT_SECRET is not set – token will be null. Configure JWT_SECRET in env."
    );
    return null;
  }

   return jwt.sign(payload, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN as any,
  });


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
      .json(fail("AUTH_MISSING_FIELDS", "Phone and 4-digit PIN are required."));
  }

  if (typeof pin !== "string" || !/^\d{4}$/.test(pin)) {
    return res
      .status(400)
      .json(fail("AUTH_INVALID_PIN_FORMAT", "PIN must be 4 digits."));
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
      return res
        .status(401)
        .json(fail("AUTH_INVALID_CREDENTIALS", "Invalid phone or PIN."));
    }

    const user = result.rows[0];

    if (!user.pin || String(user.pin) !== pin) {
      return res
        .status(401)
        .json(fail("AUTH_INVALID_CREDENTIALS", "Invalid phone or PIN."));
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

    const token = signAuthToken({
      id: safeUser.id,
      role,
      phone: safeUser.phone,
    });

        // Analytics: login event
    try {
      await logEvent("login", {
        userId: safeUser.id,
        role,
        phone: safeUser.phone,
      });
    } catch (logErr) {
      console.warn("[analytics] Failed to log login event:", logErr);
    }

    return res.json(
      ok({
        user: safeUser,
        token, // may be null if JWT_SECRET not configured
      })
    );


    // If you later want httpOnly cookies, you can set them here.
    // For now we rely on JSON token (frontend sends Authorization: Bearer <token>).
    // if (token) {
    //   res.cookie("auth_token", token, {
    //     httpOnly: true,
    //     secure: process.env.NODE_ENV === "production",
    //     sameSite: "lax",
    //     maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    //   });
    // }

    return res.json(
      ok({
        user: safeUser,
        token, // may be null if JWT_SECRET not configured
      })
    );
  } catch (err) {
    console.error("Error in POST /auth/login:", err);
    return res
      .status(500)
      .json(fail("AUTH_INTERNAL_ERROR", "Internal server error"));
  }
});


/**
 * POST /auth/register
 * Body: { phone, pin, name?, email? }
 */
authRouter.post("/register", async (req, res) => {
  const { phone, pin, name, email } = req.body || {};

  if (!phone || !pin) {
    return res
      .status(400)
      .json(fail("AUTH_MISSING_FIELDS", "Phone and 4-digit PIN are required."));
  }

  if (typeof pin !== "string" || !/^\d{4}$/.test(pin)) {
    return res
      .status(400)
      .json(fail("AUTH_INVALID_PIN_FORMAT", "PIN must be 4 digits."));
  }

  const normalizedPhone = normalizePhone(String(phone));
  const nameVal: string | null = name ? String(name).trim() : null;

  // Email must be unique and not null in many DB schemas.
  // If user didn't provide one, generate a unique placeholder from phone.
  let emailVal: string = email ? String(email).trim() : "";
  if (!emailVal) {
    const safePhone = normalizedPhone.replace(/[^0-9+]/g, "");
    emailVal = `${safePhone}@placeholder.local`;
  }

  try {
    const existing = await pool.query(
      `SELECT id FROM users WHERE phone = $1`,
      [normalizedPhone]
    );

    if (existing.rows.length > 0) {
      return res
        .status(409)
        .json(fail("REGISTER_USER_EXISTS", "User already exists."));
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

    return res.status(201).json(
      ok({
        user,
        token: null,
      })
    );
  } catch (err) {
    console.error("Error in POST /auth/register:", err);
    return res
      .status(500)
      .json(fail("AUTH_INTERNAL_ERROR", "Internal server error"));
  }
});



export default authRouter;
