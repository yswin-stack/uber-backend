import { Router, Request, Response } from "express";
import { pool } from "../db/pool";
import { getAiConfig } from "../services/aiConfig";
import { runPredictiveLoadBalancer } from "../services/loadBalancer";


const adminRouter = Router();

/**
 * Very simple check for admin.
 * Final version will use JWT or role table entries.
 */
function ensureAdmin(req: Request, res: Response): number | null {
  const header = req.header("x-user-id");
  const role = req.header("x-role"); // frontend already stores role
  if (!header || role !== "admin") {
    res.status(403).json({ error: "Admin access required." });
    return null;
  }
  return parseInt(header, 10);
}

/**
 * GET /admin/metrics/today
 * - how many rides today
 * - how many completed
 * - how many cancelled
 * - on-time %
 */
adminRouter.get("/metrics/today", async (req: Request, res: Response) => {
  if (!ensureAdmin(req, res)) return;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  try {
    const totalRes = await pool.query(
      `
      SELECT COUNT(*) AS count
      FROM rides
      WHERE pickup_time >= $1
        AND pickup_time < $2
      `,
      [today.toISOString(), tomorrow.toISOString()]
    );

    const completedRes = await pool.query(
      `
      SELECT COUNT(*) AS count
      FROM rides
      WHERE status = 'completed'
        AND pickup_time >= $1
        AND pickup_time < $2
      `,
      [today.toISOString(), tomorrow.toISOString()]
    );

    const cancelledRes = await pool.query(
      `
      SELECT COUNT(*) AS count
      FROM rides
      WHERE status IN ('cancelled','cancelled_by_user','cancelled_by_admin')
        AND pickup_time >= $1 AND pickup_time < $2
      `,
      [today.toISOString(), tomorrow.toISOString()]
    );

    const lateRes = await pool.query(
      `
      SELECT COUNT(*) AS count
      FROM rides
      WHERE status='completed'
        AND actual_arrival_time IS NOT NULL
        AND arrival_window_end IS NOT NULL
        AND actual_arrival_time > arrival_window_end
        AND pickup_time >= $1 AND pickup_time < $2
      `,
      [today.toISOString(), tomorrow.toISOString()]
    );

    const total = Number(totalRes.rows[0].count);
    const completed = Number(completedRes.rows[0].count);
    const cancelled = Number(cancelledRes.rows[0].count);
    const late = Number(lateRes.rows[0].count);

    const onTime =
      completed === 0 ? 100 : Math.max(0, 100 - (late / completed) * 100);

    return res.json({
      total_rides: total,
      completed,
      cancelled,
      late,
      on_time_percent: onTime.toFixed(1),
    });
  } catch (err) {
    console.error("Admin metrics today error:", err);
    return res.status(500).json({ error: "Failed to load metrics." });
  }
});

/**
 * GET /admin/metrics/this-month
 */
adminRouter.get("/metrics/this-month", async (req: Request, res: Response) => {
  if (!ensureAdmin(req, res)) return;

  const now = new Date();
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  );

  try {
    const riderCount = await pool.query(
      `
      SELECT COUNT(*) FROM subscriptions
      WHERE current_period_start >= $1
      `,
      [monthStart.toISOString()]
    );

    const totalRides = await pool.query(
      `
      SELECT COUNT(*) FROM rides
      WHERE created_at >= $1
      `,
      [monthStart.toISOString()]
    );

    const activeDrivers = await pool.query(`
      SELECT COUNT(*) FROM users WHERE role='driver'
    `);

    return res.json({
      active_subscribers: Number(riderCount.rows[0].count),
      rides_created: Number(totalRides.rows[0].count),
      drivers: Number(activeDrivers.rows[0].count),
    });
  } catch (err) {
    console.error("Admin metrics month error:", err);
    return res.status(500).json({ error: "Failed to load monthly metrics." });
  }
});

/**
 * GET /admin/schedule/today
 * - Admin timeline view
 */
adminRouter.get("/schedule/today", async (req: Request, res: Response) => {
  if (!ensureAdmin(req, res)) return;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  try {
    const ridesRes = await pool.query(
      `
      SELECT *
      FROM rides
      WHERE pickup_time >= $1 AND pickup_time < $2
      ORDER BY pickup_time ASC
      `,
      [today.toISOString(), tomorrow.toISOString()]
    );

    return res.json({
      rides: ridesRes.rows,
    });
  } catch (err) {
    console.error("Admin schedule load error:", err);
    return res.status(500).json({ error: "Failed to load schedule." });
  }
});

/**
 * GET /admin/ai/config
 * - Exposes current AI tuning values (speed, snow penalties, etc.)
 */
adminRouter.get("/ai/config", async (req: Request, res: Response) => {
  if (!ensureAdmin(req, res)) return;

  const cfg = getAiConfig();
  return res.json(cfg);
});

export { adminRouter };
export default adminRouter;
