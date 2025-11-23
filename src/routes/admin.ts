import { Router, Request, Response } from "express";
import { pool } from "../db/pool";
import { normalizePhone } from "./auth";

const adminRouter = Router();

/**
 * Helper: get user id from x-user-id header (same pattern as other routes)
 */
function getUserIdFromHeader(req: Request): number | null {
  const raw = req.header("x-user-id");
  if (!raw) return null;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return null;
  return n;
}

/**
 * Helper: ensure that the caller is an admin.
 * If not, sends response and returns null.
 */
async function requireAdmin(
  req: Request,
  res: Response
): Promise<{ id: number } | null> {
  const userId = getUserIdFromHeader(req);
  if (!userId) {
    res.status(401).json({ error: "Missing or invalid x-user-id header." });
    return null;
  }

  const result = await pool.query(
    "SELECT id, role FROM users WHERE id = $1",
    [userId]
  );

  if (result.rowCount === 0) {
    res.status(404).json({ error: "Admin user not found." });
    return null;
  }

  const row = result.rows[0];
  if (row.role !== "admin") {
    res.status(403).json({ error: "Admin access required." });
    return null;
  }

  return { id: row.id };
}

/**
 * GET /admin/users
 * Optional query: role=subscriber|driver|admin
 * Lists users for admin view.
 */
adminRouter.get("/users", async (req: Request, res: Response) => {
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const role = (req.query.role as string | undefined)?.trim();

    let query = `
      SELECT id, phone, email, name, role, created_at
      FROM users
    `;
    const params: any[] = [];

    if (role && ["subscriber", "driver", "admin"].includes(role)) {
      query += " WHERE role = $1";
      params.push(role);
    }

    query += " ORDER BY created_at DESC";

    const result = await pool.query(query, params);

    return res.json({
      ok: true,
      users: result.rows,
    });
  } catch (err) {
    console.error("Error in GET /admin/users:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * POST /admin/promote-driver
 * Body: { phone: string }
 * Finds a user by phone and sets role = 'driver'.
 */
adminRouter.post(
  "/promote-driver",
  async (req: Request, res: Response) => {
    try {
      const admin = await requireAdmin(req, res);
      if (!admin) return;

      const body = req.body as { phone?: string };
      const rawPhone = body.phone?.trim();
      if (!rawPhone) {
        return res.status(400).json({ error: "phone is required." });
      }

      const normalized = normalizePhone(rawPhone);

      const findUser = await pool.query(
        "SELECT id, phone, email, name, role FROM users WHERE phone = $1",
        [normalized]
      );

      if (findUser.rowCount === 0) {
        return res
          .status(404)
          .json({ error: "No user found with that phone." });
      }

      const user = findUser.rows[0];

      if (user.role === "driver") {
        // Already a driver; just return
        return res.json({
          ok: true,
          message: "User is already a driver.",
          user,
        });
      }

      const updated = await pool.query(
        `
        UPDATE users
        SET role = 'driver'
        WHERE id = $1
        RETURNING id, phone, email, name, role, created_at
      `,
        [user.id]
      );

      return res.json({
        ok: true,
        user: updated.rows[0],
      });
    } catch (err) {
      console.error("Error in POST /admin/promote-driver:", err);
      return res.status(500).json({ error: "Internal server error." });
    }
  }
);

/**
 * GET /admin/schedules
 * Optional query: userId=<id>
 * - If userId provided → schedule for that user
 * - Else → all schedules with user info
 */
adminRouter.get("/schedules", async (req: Request, res: Response) => {
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const userIdParam = (req.query.userId as string | undefined)?.trim();

    if (userIdParam) {
      const userId = parseInt(userIdParam, 10);
      if (Number.isNaN(userId)) {
        return res.status(400).json({ error: "Invalid userId." });
      }

      const result = await pool.query(
        `
        SELECT us.id,
               us.user_id,
               us.day_of_week,
               us.direction,
               us.arrival_time,
               u.name,
               u.phone
        FROM user_schedules us
        JOIN users u ON u.id = us.user_id
        WHERE us.user_id = $1
        ORDER BY us.day_of_week ASC, us.direction ASC, us.arrival_time ASC
      `,
        [userId]
      );

      return res.json({
        ok: true,
        schedules: result.rows,
      });
    } else {
      const result = await pool.query(
        `
        SELECT us.id,
               us.user_id,
               us.day_of_week,
               us.direction,
               us.arrival_time,
               u.name,
               u.phone
        FROM user_schedules us
        JOIN users u ON u.id = us.user_id
        ORDER BY us.day_of_week ASC, us.arrival_time ASC
      `
      );

      return res.json({
        ok: true,
        schedules: result.rows,
      });
    }
  } catch (err) {
    console.error("Error in GET /admin/schedules:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

export default adminRouter;
