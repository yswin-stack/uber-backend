import { Router, Request, Response } from "express";
import { pool } from "../db/pool";
import jwt from "jsonwebtoken";

const authRouter = Router();

// This is YOU (admin)
const ADMIN_PHONE = "+14313389073";
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-this";

/**
 * Normalize phone:
 * - Remove spaces, dashes, brackets
 * - Add +1 if missing
 */
function normalizePhone(raw: string): string {
  if (!raw) return raw;
  let cleaned = raw.replace(/\s+/g, "").replace(/[-()]/g, "");

  if (cleaned.startsWith("+1")) return cleaned;
  if (cleaned.startsWith("1") && cleaned.length > 10) return "+" + cleaned;

  // Assume Canadian/US 10-digit, prepend +1
  if (/^\d{10}$/.test(cleaned)) {
    return "+1" + cleaned;
  }

  // Fallback: if already starts with +, keep it
  if (cleaned.startsWith("+")) return cleaned;

  // Otherwise just stick +1 in front
  return "+1" + cleaned;
}

function signToken(userId: number, role: "subscriber" | "driver" | "admin") {
  return jwt.sign(
    {
      userId,
      role,
    },
    JWT_SECRET,
    { expiresIn: "30d" }
  );
}

// POST /auth/register
authRouter.post("/register", async (req: Request, res: Response) => {
  try {
    const body = req.body as {
      phone?: string;
      pin?: string;
      email?: string;
      name?: string;
    };

    const phoneRaw = body.phone;
    const pin = body.pin;
    const email: string | undefined = body.email?.trim() || undefined;
    const name: string | undefined = body.name?.trim() || undefined;

    if (!phoneRaw || !pin) {
      return res.status(400).json({ error: "phone and pin are required" });
    }

    const normalizedPhone = normalizePhone(phoneRaw);

    // Check if already exists
    const existing = await pool.query(
      "SELECT id, phone FROM users WHERE phone = $1",
      [normalizedPhone]
    );
    if (existing.rowCount && existing.rowCount > 0) {
      return res
        .status(400)
        .json({ error: "User already exists with this phone." });
    }

    // Decide role: admin only for that exact special phone, otherwise subscriber
    let role: "subscriber" | "driver" | "admin" = "subscriber";
    if (normalizedPhone === ADMIN_PHONE) {
      role = "admin";
    }

    const insert = await pool.query(
      `INSERT INTO users (email, name, role, phone, pin)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, email, name, role, phone`,
      [email, name, role, normalizedPhone, pin]
    );

    const user = insert.rows[0];

    const token = signToken(user.id, user.role);

    return res.json({
      ok: true,
      token,
      userId: user.id,
      phone: user.phone,
      name: user.name,
      role: user.role,
      isDriver: user.role === "driver",
      isAdmin: user.role === "admin",
    });
  } catch (err) {
    console.error("Error in /auth/register:", err);
    return res
      .status(500)
      .json({ error: "Internal server error during signup." });
  }
});

// POST /auth/login
authRouter.post("/login", async (req: Request, res: Response) => {
  try {
    const body = req.body as {
      phone?: string;
      pin?: string;
    };

    const phoneRaw = body.phone;
    const pin = body.pin;

    if (!phoneRaw || !pin) {
      return res.status(400).json({ error: "phone and pin are required" });
    }

    const normalizedPhone = normalizePhone(phoneRaw);

    const result = await pool.query(
      "SELECT id, email, name, role, phone, pin FROM users WHERE phone = $1",
      [normalizedPhone]
    );

    if (result.rowCount === 0) {
      return res.status(401).json({ error: "Invalid phone or pin." });
    }

    const user = result.rows[0];

    if (user.pin !== pin) {
      return res.status(401).json({ error: "Invalid phone or pin." });
    }

    // Auto-upgrade YOU to admin if for some reason role isn't set
    if (normalizedPhone === ADMIN_PHONE && user.role !== "admin") {
      await pool.query("UPDATE users SET role = 'admin' WHERE id = $1", [
        user.id,
      ]);
      user.role = "admin";
    }

    const token = signToken(user.id, user.role);

    return res.json({
      ok: true,
      token,
      userId: user.id,
      phone: user.phone,
      name: user.name,
      role: user.role,
      isDriver: user.role === "driver",
      isAdmin: user.role === "admin",
    });
  } catch (err) {
    console.error("Error in /auth/login:", err);
    return res
      .status(500)
      .json({ error: "Internal server error during login." });
  }
});

// GET /auth/me  (uses Authorization: Bearer <token>)
authRouter.get("/me", async (req: Request, res: Response) => {
  try {
    const authHeader = req.header("Authorization") || "";
    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing token." });
    }
    const token = authHeader.slice("Bearer ".length).trim();
    if (!token) {
      return res.status(401).json({ error: "Missing token." });
    }

    let payload: any;
    try {
      payload = jwt.verify(token, JWT_SECRET) as {
        userId: number;
        role: "subscriber" | "driver" | "admin";
      };
    } catch (err) {
      console.error("Invalid token in /auth/me:", err);
      return res.status(401).json({ error: "Invalid token." });
    }

    const result = await pool.query(
      "SELECT id, email, name, role, phone FROM users WHERE id = $1",
      [payload.userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "User not found." });
    }

    const user = result.rows[0];

    return res.json({
      ok: true,
      userId: user.id,
      phone: user.phone,
      name: user.name,
      role: user.role,
      isDriver: user.role === "driver",
      isAdmin: user.role === "admin",
    });
  } catch (err) {
    console.error("Error in /auth/me:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

export default authRouter;
export { normalizePhone, ADMIN_PHONE };
