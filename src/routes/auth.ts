import { Router } from "express";
import { pool } from "../db/pool";

const authRouter = Router();

type UserRow = {
  id: number;
  email: string;
  phone: string | null;
  pin: string;
  role: string | null;
  name: string | null;
  work_address: string | null;
  school_address: string | null;
};

/**
 * Normalize phone for US/Canada:
 *
 *  - "+12041234567"  -> stays "+12041234567"
 *  - "2041234567"    -> "+12041234567"
 *  - "1 204 123 4567"-> "+12041234567"
 *  - "12041234567"   -> "+12041234567"
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

  return `user${Date.now()}@local`;
}

/**
 * POST /auth/signup
 * Body: { name?, email?, phone, pin }
 */
authRouter.post("/signup", async (req, res) => {
  try {
    const { name, email, phone, pin } = req.body as {
      name?: string;
      email?: string;
      phone?: string;
      pin?: string;
    };

    if (!phone || phone.trim() === "") {
      return res
        .status(400)
        .json({ error: "Phone number is required to create an account." });
    }

    if (!pin || typeof pin !== "string" || pin.length !== 4) {
      return res.status(400).json({ error: "PIN must be a 4-digit string." });
    }

    const normalizedPhone = normalizePhone(phone);
    const finalEmail = ensureEmail(email, normalizedPhone);
    const finalName = name && name.trim() !== "" ? name.trim() : null;

    // Check if user already exists by phone OR email
    const existing = await pool.query<UserRow>(
      `
      SELECT id, email, phone, pin, role, name, work_address, school_address
      FROM users
      WHERE email = $1
         OR phone = $2
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
      INSERT INTO users (email, phone, pin, role, name)
      VALUES ($1, $2, $3, 'subscriber', $4)
      RETURNING id, email, phone, pin, role, name, work_address, school_address
    `,
      [finalEmail, normalizedPhone, pin, finalName]
    );

    const user = insert.rows[0];

    return res.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        workAddress: user.work_address,
        schoolAddress: user.school_address,
      },
    });
  } catch (err: any) {
    console.error("Error in /auth/signup:", err);
    const msg = err?.message || String(err);
    return res.status(500).json({
      error: `Internal server error during signup: ${msg}`,
    });
  }
});

/**
 * POST /auth/login
 * Body: { identifier, pin }
 * identifier: email OR phone
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
      const email = raw.toLowerCase();
      const result = await pool.query<UserRow>(
        `
        SELECT id, email, phone, pin, role, name, work_address, school_address
        FROM users
        WHERE email = $1
        LIMIT 1
      `,
        [email]
      );
      if (result.rows.length > 0) userRow = result.rows[0];
    } else {
      const normalizedPhone = normalizePhone(raw);

      // 1) Try by phone
      let result = await pool.query<UserRow>(
        `
        SELECT id, email, phone, pin, role, name, work_address, school_address
        FROM users
        WHERE phone = $1
        LIMIT 1
      `,
        [normalizedPhone]
      );

      if (result.rows.length > 0) {
        userRow = result.rows[0];
      } else {
        // 2) Fallback alias email from phone (for older rows)
        const aliasEmail = ensureEmail(undefined, normalizedPhone);
        result = await pool.query<UserRow>(
          `
          SELECT id, email, phone, pin, role, name, work_address, school_address
          FROM users
          WHERE email = $1
          LIMIT 1
        `,
          [aliasEmail]
        );
        if (result.rows.length > 0) userRow = result.rows[0];
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
        workAddress: userRow.work_address,
        schoolAddress: userRow.school_address,
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
      SELECT id, email, phone, pin, role, name, work_address, school_address
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
        workAddress: user.work_address,
        schoolAddress: user.school_address,
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
 * Body: { name?, email?, phone?, workAddress?, schoolAddress? }
 */
authRouter.put("/profile", async (req, res) => {
  try {
    const userIdHeader = req.header("x-user-id");
    const userIdNum = userIdHeader ? Number(userIdHeader) : NaN;

    if (!userIdHeader || Number.isNaN(userIdNum)) {
      return res.status(401).json({ error: "Missing or invalid x-user-id header." });
    }

    const { name, email, phone, workAddress, schoolAddress } = req.body as {
      name?: string;
      email?: string;
      phone?: string;
      workAddress?: string;
      schoolAddress?: string;
    };

    if (!email && !phone) {
      return res
        .status(400)
        .json({ error: "Please keep at least an email or a phone number." });
    }

    const normalizedPhone =
      phone && phone.trim() !== "" ? normalizePhone(phone) : null;
    const finalEmail = ensureEmail(email, normalizedPhone ?? undefined);

    const finalName = name && name.trim() !== "" ? name.trim() : null;
    const finalWork = workAddress && workAddress.trim() !== "" ? workAddress.trim() : null;
    const finalSchool =
      schoolAddress && schoolAddress.trim() !== "" ? schoolAddress.trim() : null;

    const result = await pool.query<UserRow>(
      `
      UPDATE users
      SET email = $1,
          phone = $2,
          name = $3,
          work_address = $4,
          school_address = $5
      WHERE id = $6
      RETURNING id, email, phone, pin, role, name, work_address, school_address
    `,
      [finalEmail, normalizedPhone, finalName, finalWork, finalSchool, userIdNum]
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
        workAddress: user.work_address,
        schoolAddress: user.school_address,
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
