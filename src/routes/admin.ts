import { Router, Request, Response } from "express";
import { pool } from "../db/pool";
import { getAiConfig } from "../services/aiConfig";
import { runPredictiveLoadBalancer } from "../services/loadBalancer";
import {
  listReferralsForAdmin,
  markReferralRewardApplied,
} from "../services/referrals";

import { ok, fail } from "../lib/apiResponse";
import {
  activateSubscription,
  getCreditsSummaryForUser,
} from "../services/subscriptionService";
import { requireAuth, requireRole } from "../middleware/auth";
import type { PlanCode } from "../shared/types";
import { runMonthlyResetJob } from "../jobs/monthlyReset";



const adminRouter = Router();

/**
 * Very simple check for admin.
 * Final version will use JWT or role table entries.
 */
function ensureAdmin(req: Request, res: Response): number | null {
  const header = req.header("x-user-id");
  const role = req.header("x-role"); // frontend already stores role

  if (!header || !role) {
    res.status(401).json({ error: "Missing admin headers." });
    return null;
  }

  if (role !== "admin") {
    res.status(403).json({ error: "Admin access required." });
    return null;
  }

  const id = parseInt(header, 10);
  if (Number.isNaN(id)) {
    res.status(401).json({ error: "Invalid x-user-id header." });
    return null;
  }

  return id;
}

/**
 * GET /admin/users
 * - List all users with basic info for admin view
 */
adminRouter.get("/users", async (req: Request, res: Response) => {
  if (!ensureAdmin(req, res)) return;

  try {
    const usersRes = await pool.query(
      `
      SELECT
        id,
        name,
        email,
        phone,
        role,
        created_at
      FROM users
      ORDER BY created_at DESC
      `
    );

    return res.json({ users: usersRes.rows });
  } catch (err) {
    console.error("Admin users error:", err);
    return res.status(500).json({ error: "Failed to load users." });
  }
});

/**
 * POST /admin/jobs/monthly-reset
 *
 * Triggers the monthly reset job manually.
 * Use this with a scheduler (e.g. Render cron hitting this endpoint once a day).
 */
adminRouter.post(
  "/jobs/monthly-reset",
  requireAuth,
  requireRole("admin"),
  async (_req: Request, res: Response) => {
    try {
      await runMonthlyResetJob();
      return res.json(ok({ ran: true }));
    } catch (err) {
      console.error("Error running monthly reset job:", err);
      return res
        .status(500)
        .json(
          fail(
            "MONTHLY_RESET_FAILED",
            "Failed to run monthly reset job. See server logs."
          )
        );
    }
  }
);



/**
 * POST /admin/subscriptions/:userId/activate
 *
 * Body: { planCode, paymentMethod, notes? }
 *  - planCode: "premium" | "standard" | "light"
 *  - paymentMethod: "cash" | "card_placeholder" | "apple_pay_placeholder"
 */
adminRouter.post(
  "/subscriptions/:userId/activate",
  requireAuth,
  requireRole("admin"),
  async (req, res) => {
    const userId = Number(req.params.userId);
    const { planCode, paymentMethod, notes } = req.body as {
      planCode?: PlanCode;
      paymentMethod?: "cash" | "card_placeholder" | "apple_pay_placeholder";
      notes?: string;
    };

    if (!userId || Number.isNaN(userId)) {
      return res
        .status(400)
        .json(fail("INVALID_USER_ID", "Invalid userId parameter."));
    }

    if (!planCode) {
      return res
        .status(400)
        .json(fail("PLAN_CODE_REQUIRED", "planCode is required."));
    }

    if (
      !paymentMethod ||
      !["cash", "card_placeholder", "apple_pay_placeholder"].includes(
        paymentMethod
      )
    ) {
      return res.status(400).json(
        fail(
          "PAYMENT_METHOD_REQUIRED",
          "paymentMethod must be one of: cash, card_placeholder, apple_pay_placeholder."
        )
      );
    }

    try {
      const subscription = await activateSubscription(
        userId,
        planCode,
        paymentMethod,
        notes
      );

      const credits = await getCreditsSummaryForUser(userId);

      return res.json(ok({ subscription, credits }));
    } catch (err: any) {
      console.error(
        "Error in POST /admin/subscriptions/:userId/activate:",
        err
      );
      return res
        .status(500)
        .json(
          fail(
            "SUBSCRIPTION_ACTIVATE_FAILED",
            err?.message || "Failed to activate subscription."
          )
        );
    }
  }
);


/**
 * POST /admin/promote-driver
 * - Promote an existing user (by phone) to driver role.
 */
adminRouter.post(
  "/promote-driver",
  async (req: Request, res: Response) => {
    const adminId = ensureAdmin(req, res);
    if (!adminId) return;

    try {
      const { phone } = req.body || {};
      if (!phone) {
        return res.status(400).json({ error: "phone is required." });
      }

      const userRes = await pool.query(
        `
        SELECT id, name, email, phone, role
        FROM users
        WHERE phone = $1
        `,
        [phone]
      );

      if (userRes.rowCount === 0) {
        return res.status(404).json({ error: "User not found." });
      }

      const user = userRes.rows[0];

      if (user.role === "driver") {
        return res.json({
          ok: true,
          user,
          message: "User is already a driver.",
        });
      }

      const updated = await pool.query(
        `
        UPDATE users
        SET role = 'driver'
        WHERE id = $1
        RETURNING id, name, email, phone, role
        `,
        [user.id]
      );

      return res.json({
        ok: true,
        user: updated.rows[0],
      });
    } catch (err) {
      console.error("Admin promote-driver error:", err);
      return res.status(500).json({ error: "Failed to promote user." });
    }
  }
);

/**
 * GET /admin/schedules
 * - For a given userId (optional), list weekly schedule entries.
 */
adminRouter.get("/schedules", async (req: Request, res: Response) => {
  if (!ensureAdmin(req, res)) return;

  try {
    const userIdParam = req.query.userId;
    let sql = `
      SELECT
        s.id,
        s.user_id,
        s.day_of_week,
        s.direction,
        s.arrival_time,
        u.name,
        u.phone
      FROM user_schedules s
      JOIN users u ON u.id = s.user_id
    `;
    const params: any[] = [];

    if (userIdParam) {
      sql += " WHERE s.user_id = $1";
      params.push(parseInt(String(userIdParam), 10));
    }

    sql += " ORDER BY s.user_id, s.day_of_week, s.arrival_time";

    const schedulesRes = await pool.query(sql, params);
    return res.json({ schedules: schedulesRes.rows });
  } catch (err) {
    console.error("Admin schedules error:", err);
    return res.status(500).json({ error: "Failed to load schedules." });
  }
});

/**
 * GET /admin/metrics/month
 * - Simple monthly subscription / rides stats for dashboard.
 */
adminRouter.get("/metrics/month", async (req: Request, res: Response) => {
  if (!ensureAdmin(req, res)) return;

  try {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    const subs = await pool.query(
      `
      SELECT COUNT(*) AS active
      FROM subscriptions
      WHERE period_start >= $1
        AND period_start < $2
        AND status = 'active'
      `,
      [start, end]
    );

    const riderCount = await pool.query(
      `
      SELECT COUNT(*) AS cnt
      FROM users
      WHERE role = 'rider'
      `
    );

    const totalRides = await pool.query(
      `
      SELECT COUNT(*) AS cnt
      FROM rides
      WHERE pickup_time >= $1
        AND pickup_time < $2
      `,
      [start, end]
    );

    const activeDrivers = await pool.query(
      `
      SELECT COUNT(*) AS cnt
      FROM users
      WHERE role = 'driver'
      `
    );

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
 * GET /admin/ai/config
 * - Exposes current AI tuning values (speed, snow penalties, etc.)
 */
adminRouter.get("/ai/config", async (req: Request, res: Response) => {
  if (!ensureAdmin(req, res)) return;

  const cfg = getAiConfig();
  return res.json(cfg);
});

/**
 * POST /admin/load-insights/run
 *
 * Runs the nightly predictive load balancer for a given day.
 * - If body.day or ?day=YYYY-MM-DD is provided, uses that.
 * - Otherwise defaults to "tomorrow" (UTC).
 */
adminRouter.post(
  "/load-insights/run",
  async (req: Request, res: Response) => {
    if (!ensureAdmin(req, res)) return;

    try {
      const bodyDay: string | undefined = req.body?.day;
      const queryDay: string | undefined =
        typeof req.query.day === "string" ? req.query.day : undefined;
      const dayStr = bodyDay || queryDay || null;

      let target: Date;
      if (dayStr) {
        const parsed = new Date(dayStr);
        if (Number.isNaN(parsed.getTime())) {
          return res
            .status(400)
            .json({ error: "Invalid day format. Use YYYY-MM-DD." });
        }
        target = parsed;
      } else {
        const now = new Date();
        // Default: tomorrow in UTC
        target = new Date(
          Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            now.getUTCDate() + 1,
            0,
            0,
            0,
            0
          )
        );
      }

      const insight = await runPredictiveLoadBalancer(target);
      return res.json({ ok: true, insight });
    } catch (err) {
      console.error("Error running predictive load balancer:", err);
      return res
        .status(500)
        .json({ error: "Failed to run predictive load balancer." });
    }
  }
);

/**
 * GET /admin/load-insights
 *
 * Reads the latest daily_load_insights row for a given day.
 * - If ?day=YYYY-MM-DD provided, uses that.
 * - Otherwise defaults to "tomorrow" (UTC).
 */
adminRouter.get(
  "/load-insights",
  async (req: Request, res: Response) => {
    if (!ensureAdmin(req, res)) return;

    try {
      const queryDay: string | undefined =
        typeof req.query.day === "string" ? req.query.day : undefined;

      let target: Date;
      if (queryDay) {
        const parsed = new Date(queryDay);
        if (Number.isNaN(parsed.getTime())) {
          return res
            .status(400)
            .json({ error: "Invalid day format. Use YYYY-MM-DD." });
        }
        target = parsed;
      } else {
        const now = new Date();
        target = new Date(
          Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            now.getUTCDate() + 1,
            0,
            0,
            0,
            0
          )
        );
      }

      const dayStr = target.toISOString().slice(0, 10);

      // Ensure table exists (in case GET is called before POST /run)
      await pool.query(`
        CREATE TABLE IF NOT EXISTS daily_load_insights (
          id SERIAL PRIMARY KEY,
          day DATE NOT NULL,
          generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          total_rides INTEGER NOT NULL,
          recommended_start_time TIMESTAMPTZ,
          overbooked_slots JSONB,
          at_risk_rides JSONB
        )
      `);

      const result = await pool.query(
        `
        SELECT *
        FROM daily_load_insights
        WHERE day = $1
        ORDER BY generated_at DESC
        LIMIT 1
        `,
        [dayStr]
      );

      if (result.rowCount === 0) {
        return res
          .status(404)
          .json({ error: "No load insights for that day yet." });
      }

      return res.json({ insight: result.rows[0] });
    } catch (err) {
      console.error("Error reading load insights:", err);
      return res
        .status(500)
        .json({ error: "Failed to load predictive insights." });
    }
  }
);

/**
 * GET /admin/referrals
 * - List recent referral activity.
 */
adminRouter.get("/referrals", async (req: Request, res: Response) => {
  if (!ensureAdmin(req, res)) return;

  try {
    const list = await listReferralsForAdmin(200);
    return res.json({ referrals: list });
  } catch (err) {
    console.error("Error in GET /admin/referrals:", err);
    return res.status(500).json({ error: "Failed to load referrals." });
  }
});

/**
 * POST /admin/referrals/:id/apply
 * - Mark a referral reward as applied (e.g. discount given).
 */
adminRouter.post(
  "/referrals/:id/apply",
  async (req: Request, res: Response) => {
    if (!ensureAdmin(req, res)) return;

    const idRaw = req.params.id;
    const referralId = parseInt(idRaw, 10);
    if (Number.isNaN(referralId)) {
      return res.status(400).json({ error: "Invalid referral id." });
    }

    try {
      await markReferralRewardApplied(referralId);
      return res.json({ ok: true });
    } catch (err) {
      console.error("Error in POST /admin/referrals/:id/apply:", err);
      return res
        .status(500)
        .json({ error: "Failed to mark referral reward as applied." });
    }
  }
);

export { adminRouter };
export default adminRouter;
