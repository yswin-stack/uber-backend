import { Router } from "express";
import { pool } from "../db/pool";

const authRouter = Router();

type UserRow = {
  id: number;
  name: string | null;
  email: string;
  phone: string | null;
  pin: string;
  role: string | null;
};

/**
 * Normalize phone:
 * - remove spaces/dashes
 * - if no + at start, prefix +1 (US/Canada)
 */
function normalizePhone(raw: string): string {
  let value = raw.trim();
  value = value.replace(/[\s\-]/g, "");
  if (!value.startsWith("+")) {
    value = "+1" + value;
  }
  return value;
}

/**
 * Helper: build a safe "email" even if user only supplies phone.
 * (because your DB requires email NOT NULL)
 */
function ensureEmail(email: string | undefined, phone: string | undefined): string {
  if (email && email.trim() !== "") return email.trim().toLowerCase();

  const phoneId = phone ? normalizePhone(phone) : `user${Date.now()}`;
  return `${phoneId.replace("+", "")}@local`;
}

/**
 * POST /auth/signup
 * Body: { name?, email?, phone?, pin }
 */
authRouter.post("/signup", async (req, res) => {
  try {
    const { name, email, phone, pin } = req.body as {
      name?: string;
      email?: string;
      phone?: string;
      pin?: string;
    };

    if (!pin || typeof pin !== "string" || pin.length !== 4) {
      return res.status(400).json({ error: "PIN must be a 4-digit string." });
    }

    if (!email && !phone) {
      return res
        .status(400)
        .json({ error: "Please provide an email or a phone number." });
    }

    const normalizedPhone = phone ? normalizePhone(phone) : null;
    const finalEmail = ensureEmail(email, normalizedPhone ?? undefined);

    // Check if user already exists by email OR phone
    const existing = await pool.query<UserRow>(
      `
      SELECT id, name, email, phone, pin, role
      FROM users
      WHERE email = $1 OR (phone IS NOT NULL AND phone = $2)
      LIMIT 1
    `,
      [finalEmail, normalizedPhone]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({
        error: "An account with this email or phone already exists. Please log in instead.",
      });
    }

    const insert = await pool.query<UserRow>(
      `
      INSERT INTO users (email, phone, name, pin, role)
      VALUES ($1, $2, $3, $4, 'subscriber')
      RETURNING id, name, email, phone, role
    `,
      [finalEmail, normalizedPhone, name ?? null, pin]
    );

    const user = insert.rows[0];

    return res.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
      },
    });
  } catch (err) {
    console.error("Error in /auth/signup:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /auth/login
 * Body: { identifier, pin }
 * identifier can be email OR phone
 */
authRouter.post("/login", async (req, res) => {
  try {
    const { identifier, pin } = req.body as {
      identifier?: string;
      pin?: string;
    };

    if (!identifier || !pin) {
      return res.status(400).json({ error: "identifier and pin are required." });
    }

    if (typeof pin !== "string" || pin.length !== 4) {
      return res.status(400).json({ error: "PIN must be a 4-digit string." });
    }

    const raw = identifier.trim();
    let userRow: UserRow | null = null;

    if (raw.includes("@")) {
      // Treat as email
      const email = raw.toLowerCase();
      const result = await pool.query<UserRow>(
        `
        SELECT id, name, email, phone, pin, role
        FROM users
        WHERE email = $1
        LIMIT 1
      `,
        [email]
      );
      if (result.rows.length > 0) userRow = result.rows[0];
    } else {
      // Treat as phone
      const normalizedPhone = normalizePhone(raw);
      const result = await pool.query<UserRow>(
        `
        SELECT id, name, email, phone, pin, role
        FROM users
        WHERE phone = $1
        LIMIT 1
      `,
        [normalizedPhone]
      );
      if (result.rows.length > 0) userRow = result.rows[0];
    }

    if (!userRow) {
      return res.status(401).json({ error: "User not found." });
    }

    if (userRow.pin !== pin) {
      return res.status(401).json({ error: "Incorrect PIN." });
    }

    return res.json({
      user: {
        id: userRow.id,
        name: userRow.name,
        email: userRow.email,
        phone: userRow.phone,
        role: userRow.role,
      },
    });
  } catch (err) {
    console.error("Error in /auth/login:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /auth/me
 * Reads x-user-id header and returns basic profile.
 * (Used by frontend dashboard later if you want.)
 */
authRouter.get("/me", async (req, res) => {
  try {
    const userIdHeader = req.header("x-user-id");
    const userIdNum = userIdHeader ? Number(userIdHeader) : NaN;

    if (!userIdHeader || Number.isNaN(userIdNum)) {
      return res.status(401).json({ error: "Missing or invalid x-user-id header." });
    }

    const result = await pool.query<UserRow>(
      `
      SELECT id, name, email, phone, role
      FROM users
      WHERE id = $1
      LIMIT 1
    `,
      [userIdNum]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found." });
    }

    const user = result.rows[0];

    return res.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
      },
    });
  } catch (err) {
    console.error("Error in /auth/me:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default authRouter;
