import { Router, Request, Response } from "express";
import { pool } from "../db/pool";

const authRouter = Router();

// This is YOU (admin)
const ADMIN_PHONE = "+14313389073";

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

// POST /auth/register
authRouter.post("/register", async (req: Request, res: Response) => {
  try {
    let { phone, pin, email, name } = req.body as {
      phone?: string;
      pin?: string;
      email?: string;
      name?: string;
    };

    if (!phone || !pin) {
      return res.status(400).json({ error: "phone and pin are required" });
    }

    const normalizedPhone = normalizePhone(phone);
    email = email || null;
    name = name || null;

    // Check if already exists
    const existing = await pool.query(
      "SELECT id, phone FROM users WHERE phone = $1",
      [normalizedPhone]
    );
    if (existing.rowCount && existing.rowCount > 0) {
      return res.status(400).json({ error: "User already exists with this phone." });
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
    console.error("Error in /auth/register:", err);
    return res.status(500).json({ error: "Internal server error during signup." });
  }
});

// POST /auth/login
authRouter.post("/login", async (req: Request, res: Response) => {
  try {
    let { phone, pin } = req.body as {
      phone?: string;
      pin?: string;
    };

    if (!phone || !pin) {
      return res.status(400).json({ error: "phone and pin are required" });
    }

    const normalizedPhone = normalizePhone(phone);

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
      await pool.query("UPDATE users SET role = 'admin' WHERE id = $1", [user.id]);
      user.role = "admin";
    }

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
    console.error("Error in /auth/login:", err);
    return res.status(500).json({ error: "Internal server error during login." });
  }
});

export default authRouter;
export { normalizePhone, ADMIN_PHONE };
