import { Router, Request, Response } from "express";
import { pool } from "../db/pool";

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
      return res.status(401).json({ error: "Missing or invalid x-user-id header." });
    }

    const result = await pool.query(
      "SELECT id, email, name, role, phone FROM users WHERE id = $1",
      [userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "User not found." });
    }

    return res.json({
      ok: true,
      user: result.rows[0],
    });
  } catch (err) {
    console.error("Error in GET /user/me:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

// PATCH /user/me  -> update name / email
userRouter.patch("/me", async (req: Request, res: Response) => {
  try {
    const userId = getUserIdFromHeader(req);
    if (!userId) {
      return res.status(401).json({ error: "Missing or invalid x-user-id header." });
    }

    const { name, email } = req.body as {
      name?: string;
      email?: string;
    };

    if (!name && !email) {
      return res.status(400).json({ error: "Nothing to update." });
    }

    const result = await pool.query(
      `UPDATE users
       SET
         name = COALESCE($1, name),
         email = COALESCE($2, email)
       WHERE id = $3
       RETURNING id, email, name, role, phone`,
      [name ?? null, email ?? null, userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "User not found." });
    }

    return res.json({
      ok: true,
      user: result.rows[0],
    });
  } catch (err) {
    console.error("Error in PATCH /user/me:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

// GET /user/shortcuts  -> work / school saved locations
userRouter.get("/shortcuts", async (req: Request, res: Response) => {
  try {
    const userId = getUserIdFromHeader(req);
    if (!userId) {
      return res.status(401).json({ error: "Missing or invalid x-user-id header." });
    }

    const result = await pool.query(
      `SELECT id, label, address, lat, lng
       FROM saved_locations
       WHERE user_id = $1`,
      [userId]
    );

    const shortcuts: {
      work: any | null;
      school: any | null;
    } = {
      work: null,
      school: null,
    };

    for (const row of result.rows) {
      if (row.label === "work") {
        shortcuts.work = row;
      } else if (row.label === "school") {
        shortcuts.school = row;
      }
    }

    return res.json({
      ok: true,
      shortcuts,
    });
  } catch (err) {
    console.error("Error in GET /user/shortcuts:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

// POST /user/shortcuts  -> upsert work/school shortcut
// Body: { label: "work" | "school", address: string, lat?: number, lng?: number }
userRouter.post("/shortcuts", async (req: Request, res: Response) => {
  try {
    const userId = getUserIdFromHeader(req);
    if (!userId) {
      return res.status(401).json({ error: "Missing or invalid x-user-id header." });
    }

    const { label, address, lat, lng } = req.body as {
      label?: string;
      address?: string;
      lat?: number;
      lng?: number;
    };

    if (!label || !address) {
      return res.status(400).json({ error: "label and address are required." });
    }

    if (label !== "work" && label !== "school") {
      return res.status(400).json({ error: "label must be 'work' or 'school'." });
    }

    // Simple upsert: delete old, insert new
    await pool.query(
      "DELETE FROM saved_locations WHERE user_id = $1 AND label = $2",
      [userId, label]
    );

    const insert = await pool.query(
      `INSERT INTO saved_locations (user_id, label, address, lat, lng)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, label, address, lat, lng`,
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

export default userRouter;
