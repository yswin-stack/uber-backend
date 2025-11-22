import { Router, Request, Response } from "express";
import { pool } from "../db/pool";
import { normalizePhone, ADMIN_PHONE } from "./auth";

const adminRouter = Router();

/**
 * Simple helper to get the current user from x-user-id header.
 */
async function getUserFromHeader(req: Request) {
  const userIdHeader = req.header("x-user-id");
  if (!userIdHeader) return null;

  const userId = parseInt(userIdHeader, 10);
  if (Number.isNaN(userId)) return null;

  const result = await pool.query(
    "SELECT id, phone, role, name FROM users WHERE id = $1",
    [userId]
  );
  if (result.rowCount === 0) return null;

  return result.rows[0];
}

// POST /admin/promote-driver
// Body: { phone: string }
adminRouter.post("/promote-driver", async (req: Request, res: Response) => {
  try {
    // 1. Check that caller is logged-in admin
    const currentUser = await getUserFromHeader(req);
    if (!currentUser) {
      return res.status(401).json({ error: "Not authenticated." });
    }

    // Must be admin AND match the special admin phone
    if (
      currentUser.role !== "admin" ||
      normalizePhone(currentUser.phone) !== normalizePhone(ADMIN_PHONE)
    ) {
      return res.status(403).json({ error: "Not authorized." });
    }

    // 2. Get phone to promote
    let { phone } = req.body as { phone?: string };
    if (!phone) {
      return res.status(400).json({ error: "phone is required." });
    }

    const targetPhone = normalizePhone(phone);

    // 3. Find target user
    const userResult = await pool.query(
      "SELECT id, phone, role, name FROM users WHERE phone = $1",
      [targetPhone]
    );

    if (userResult.rowCount === 0) {
      return res.status(404).json({ error: "User not found with that phone." });
    }

    const targetUser = userResult.rows[0];

    // 4. Update role to driver
    await pool.query("UPDATE users SET role = 'driver' WHERE id = $1", [
      targetUser.id,
    ]);

    return res.json({
      ok: true,
      user: {
        id: targetUser.id,
        phone: targetUser.phone,
        name: targetUser.name,
        role: "driver",
      },
    });
  } catch (err) {
    console.error("Error in /admin/promote-driver:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

export default adminRouter;
