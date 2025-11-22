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
 * Normalize phone for US/Canada:
 *
 * Accepted inputs:
 *  - "+12041234567"  -> stays "+12041234567"
 *  - "2041234567"    -> "+12041234567"
 *  - "1 204 123 4567"-> "+12041234567"
 *  - "12041234567"   -> "+12041234567"
 *
 * Logic:
 * 1. Remove spaces, dashes, (), dots.
 * 2. If already starts with "+", trust user and return it.
 * 3. If starts with "1" and length is 11 -> treat as +1 + rest.
 * 4. If length is 10 -> treat as +1 + digits.
 * 5. Else, just prefix "+" so it’s still usable.
 */
function normalizePhone(raw: string): string {
  let digits = raw.trim().replace(/[\s\-().]/g, "");

  if (digits.startsWith("+")) {
    return digits;
  }

  if (digits.startsWith("1") && digits.length === 11) {
    return `+${digits}`;
  }

  if (digits.length === 10) {
    return `+1${digits}`;
  }

  return `+${digits}`;
}

/**
 * Helper: build a safe "email" even if user only supplies phone.
 * (because your DB requires email NOT NULL)
 */
function ensureEmail(email: string | undefined, phone: string | undefined): string {
  if (email && email.trim() !== "") return email.trim().toLowerCase();

  if (phone && phone.trim() !== "") {
    const p = normalizePhone(phone);
    return `${p.replace("+", "")}@local`;
  }

  // Last-resort fallback (should basically never be hit if frontend sends phone)
  return `user${Date.now()}@local`;
}

/**
 * POST /auth/signup
 * Body: { name?, email?, phone?, pin }
 *
 * - At least ONE of email or phone is required.
 * - Phone is what we actually care about (for SMS), but we don’t force it here
 *   in case your UI changes.
 */
authRouter.post("/signup", async (req, res) => {
  try {
    const { name, email, phone, pin } = req.body as {
      name?: string;
      email?: string;
      phone?: string;
      pin?: string;
    };

    if (!email && !phone) {
      return res
        .status(400)
        .json({ error: "Please provide at least a phone number or an email." });
    }

    if (!pin || typeof pin !== "string" || pin.length !== 4) {
      return res.status(400).json({ error: "PIN must be a 4-digit string." });
    }

    const normalizedPhone =
      phone && phone.trim() !== "" ? normalizePhone(phone) : null;
    const finalEmail = ensureEmail(email, normalizedPhone ?? undefined);

    // Check if user already exists by phone OR email
    const existing = await pool.query<UserRow>(
      `
      SELECT id, name, email, phone, pin, role
      FROM users
      WHERE email = $1
         OR ($2 IS NOT NULL AND phone = $2)
      LIMIT 1
    `,
      [finalEmail, normalizedPhone]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({
        error:
          "An account with this email or phone already exists. Please log in instead.",
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
  } catch (err: any) {
    console.error("Error in /auth/signup:", err);

    // For now we pack error details into the main error string
    // so you can see EXACTLY what Postgres is complaining about.
    const msg = err?.message || String(err);
    return res.status(500).json({
      error: `Internal server error during signup: ${msg}`,
    });
  }
});

/**
 * POST /auth/login
 * Body: { identifier, pin }
 * identifier can be:
 *  - email (contains "@")
 *  - phone like "2041234567" or "+12041234567"
 *
 * We also support fallback:
 *  - if phone search fails, we try the synthetic email created from phone.
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

      // 1) Try by phone column
      let result = await pool.query<UserRow>(
        `
        SELECT id, name, email, phone, pin, role
        FROM users
        WHERE phone = $1
        LIMIT 1
      `,
        [normalizedPhone]
      );

      if (result.rows.length > 0) {
        userRow = result.rows[0];
      } else {
        // 2) Fallback: try alias email (for old rows created using phone->email)
        const aliasEmail = ensureEmail(undefined, normalizedPhone);
        result = await pool.query<UserRow>(
          `
          SELECT id, name, email, phone, pin, role
          FROM users
          WHERE email = $1
          LIMIT 1
        `,
          [aliasEmail]
        );
        if (result.rows.length > 0) {
          userRow = result.rows[0];
        }
      }
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
  } catch (err: any) {
    console.error("Error in /auth/login:", err);
    const msg = err?.message || String(err);
    return res.status(500).json({
      error: `Internal server error during login: ${msg}`,
    });
  }
});

/**
 * GET /auth/me
 * Reads x-user-id header and returns basic profile.
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
  } catch (err: any) {
    console.error("Error in /auth/me:", err);
    const msg = err?.message || String(err);
    return res.status(500).json({
      error: `Internal server error in /auth/me: ${msg}`,
    });
  }
});

/**
 * PUT /auth/profile
 * Updates name/email/phone for logged-in user.
 * Body: { name?, email?, phone? }
 * Header: x-user-id
 */
authRouter.put("/profile", async (req, res) => {
  try {
    const userIdHeader = req.header("x-user-id");
    const userIdNum = userIdHeader ? Number(userIdHeader) : NaN;

    if (!userIdHeader || Number.isNaN(userIdNum)) {
      return res.status(401).json({ error: "Missing or invalid x-user-id header." });
    }

    const { name, email, phone } = req.body as {
      name?: string;
      email?: string;
      phone?: string;
    };

    if (!email && !phone) {
      return res
        .status(400)
        .json({ error: "Please keep at least an email or a phone number." });
    }

    const normalizedPhone =
      phone && phone.trim() !== "" ? normalizePhone(phone) : null;
    const finalEmail = ensureEmail(email, normalizedPhone ?? undefined);

    const result = await pool.query<UserRow>(
      `
      UPDATE users
      SET name = $1,
          email = $2,
          phone = $3
      WHERE id = $4
      RETURNING id, name, email, phone, role
    `,
      [name ?? null, finalEmail, normalizedPhone, userIdNum]
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
  } catch (err: any) {
    console.error("Error in /auth/profile:", err);
    const msg = err?.message || String(err);
    return res.status(500).json({
      error: `Internal server error while updating profile: ${msg}`,
    });
  }
});

export default authRouter;
