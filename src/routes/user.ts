import { Router, Request, Response } from "express";
import { pool } from "../db/pool";
import {
  getReferralSummaryForUser,
  recordReferralUsage,
} from "../services/referrals";

const userRouter = Router();

function getUserIdFromHeader(req: Request): number | null {
  const h = req.header("x-user-id");
  if (!h) return null;
  const id = parseInt(h, 10);
  if (Number.isNaN(id)) return null;
  return id;
}

// GET /user/me  -> basic profile
userRouter.get("/me", async (req: Request, res: Response) => {
  try {
    const userId = getUserIdFromHeader(req);
    if (!userId) {
      return res
        .status(401)
        .json({ error: "Missing or invalid x-user-id header." });
    }

    const result = await pool.query(
      `
      SELECT
        id,
        name,
        email,
        phone,
        role,
        created_at
      FROM users
      WHERE id = $1
      `,
      [userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "User not found." });
    }

    const user = result.rows[0];

    return res.json({ user });
  } catch (err) {
    console.error("Error in GET /user/me:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

// GET /user/shortcuts
// - returns saved short-cuts for this user
userRouter.get("/shortcuts", async (req: Request, res: Response) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) {
    return res
      .status(401)
      .json({ error: "Missing or invalid x-user-id header." });
  }

  try {
    const result = await pool.query(
      `
      SELECT id, label, address, lat, lng, created_at
      FROM saved_locations
      WHERE user_id = $1
      ORDER BY created_at ASC
      `,
      [userId]
    );

    return res.json({ shortcuts: result.rows });
  } catch (err) {
    console.error("Error in GET /user/shortcuts:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

// POST /user/shortcuts
// - upsert 'work' / 'school' addresses etc.
userRouter.post("/shortcuts", async (req: Request, res: Response) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) {
    return res
      .status(401)
      .json({ error: "Missing or invalid x-user-id header." });
  }

  try {
    const body = req.body as {
      label?: string;
      address?: string;
      lat?: number;
      lng?: number;
    };

    const { label, address, lat, lng } = body;

    if (!label || !address) {
      return res.status(400).json({ error: "label and address are required." });
    }

    if (label !== "work" && label !== "school") {
      return res
        .status(400)
        .json({ error: "label must be 'work' or 'school'." });
    }

    // Simple upsert: delete old, insert new
    await pool.query(
      "DELETE FROM saved_locations WHERE user_id = $1 AND label = $2",
      [userId, label]
    );

    const insert = await pool.query(
      `
      INSERT INTO saved_locations (user_id, label, address, lat, lng)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, label, address, lat, lng, created_at
      `,
      [userId, label, address, lat ?? null, lng ?? null]
    );

    return res.json({
      ok: true,
      shortcut: insert.rows[0],
    });
  } catch (err) {
    console.error("Error in POST /user/shortcuts:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

// GET /user/referral
// - Returns the user's referral_code and simple stats.
userRouter.get("/referral", async (req: Request, res: Response) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) {
    return res
      .status(401)
      .json({ error: "Missing or invalid x-user-id header." });
  }

  try {
    const summary = await getReferralSummaryForUser(userId);
    if (!summary) {
      return res.status(404).json({ error: "User not found." });
    }
    return res.json(summary);
  } catch (err) {
    console.error("Error in GET /user/referral:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

// POST /user/referral/use
// - Record that the current user used a referral code.
// - Business rule: can only be used once per referred user.
userRouter.post("/referral/use", async (req: Request, res: Response) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) {
    return res
      .status(401)
      .json({ error: "Missing or invalid x-user-id header." });
  }

  const referralCode: string | undefined =
    req.body?.referralCode || req.body?.referral_code;
  if (!referralCode || !referralCode.trim()) {
    return res.status(400).json({ error: "referralCode is required." });
  }

  try {
    await recordReferralUsage(userId, referralCode.trim());
    return res.json({ ok: true });
  } catch (err: any) {
    console.error("Error in POST /user/referral/use:", err);
    const message =
      typeof err.message === "string"
        ? err.message
        : "Failed to apply referral code.";
    return res.status(400).json({ error: message });
  }
});

export default userRouter;
