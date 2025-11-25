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
  getActiveSubscription,
  getCurrentPeriod,
  initCreditsForPlan,
} from "../services/subscriptionService";
import { requireAuth, requireRole } from "../middleware/auth";
import type { PlanCode } from "../shared/types";
import { runMonthlyResetJob } from "../jobs/monthlyReset";
import { runGenerateUpcomingRidesJob } from "../jobs/generateUpcomingRides";

const adminRouter = Router();

/**
 * Very simple check for admin.
 * Legacy check for older V1 admin pages that still send x-user-id / x-role.
 * Newer endpoints use JWT via requireAuth/requireRole instead.
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
 * GET /admin/ai/config
 * - Reads current AI config from DB (if present).
 */
adminRouter.get("/ai/config", async (_req: Request, res: Response) => {
  try {
    const config = await getAiConfig();
    return res.json({ ok: true, config });
  } catch (err) {
    console.error("Failed to load AI config:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Failed to load AI configuration." });
  }
});

/**
 * POST /admin/ai/load-balance
 * - Manually trigger predictive load balancer for a day (for now: today).
 */
adminRouter.post("/ai/load-balance", async (req: Request, res: Response) => {
  if (!ensureAdmin(req, res)) return;

  try {
    const targetDateStr = req.body?.date || new Date().toISOString().slice(0, 10);
    const summary = await runPredictiveLoadBalancer(targetDateStr);
    return res.json({ ok: true, summary });
  } catch (err) {
    console.error("Error in /admin/ai/load-balance:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Failed to run predictive load balancer." });
  }
});

/**
 * GET /admin/referrals
 * - List all referrals and their status.
 */
adminRouter.get(
  "/referrals",
  requireAuth,
  requireRole("admin"),
  async (_req: Request, res: Response) => {
    try {
      const referrals = await listReferralsForAdmin();
      return res.json(ok({ referrals }));
    } catch (err) {
      console.error("Error in GET /admin/referrals:", err);
      return res
        .status(500)
        .json(fail("REFERRALS_LIST_FAILED", "Failed to list referrals."));
    }
  }
);

/**
 * POST /admin/referrals/:id/apply
 * - Mark a referral reward as applied.
 */
adminRouter.post(
  "/referrals/:id/apply",
  requireAuth,
  requireRole("admin"),
  async (req: Request, res: Response) => {
    const referralId = Number(req.params.id);
    if (!referralId || Number.isNaN(referralId)) {
      return res
        .status(400)
        .json(fail("INVALID_REFERRAL_ID", "Invalid referral id."));
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

/**
 * GET /admin/users
 * - Legacy simple user list for older admin UI.
 *   Newer, richer user detail is available at GET /admin/users/:userId.
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
      const summary = await runMonthlyResetJob();
      return res.json(ok(summary));
    } catch (err) {
      console.error("Error in POST /admin/jobs/monthly-reset:", err);
      return res
        .status(500)
        .json(
          fail("MONTHLY_RESET_FAILED", "Failed to run monthly reset job.")
        );
    }
  }
);

/**
 * POST /admin/jobs/generate-upcoming-rides
 *
 * Trigger the nightly "generate upcoming rides" job manually.
 */
adminRouter.post(
  "/jobs/generate-upcoming-rides",
  requireAuth,
  requireRole("admin"),
  async (_req: Request, res: Response) => {
    try {
      const summary = await runGenerateUpcomingRidesJob();
      return res.json(ok(summary));
    } catch (err) {
      console.error(
        "Error in POST /admin/jobs/generate-upcoming-rides:",
        err
      );
      return res
        .status(500)
        .json(
          fail(
            "GENERATE_UPCOMING_RIDES_FAILED",
            "Failed to run upcoming rides generator."
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
 * GET /admin/users/:userId
 * Detailed view for a single user: basic profile, active subscription,
 * credits summary, schedule template, and recent rides.
 */
adminRouter.get(
  "/users/:userId",
  requireAuth,
  requireRole("admin"),
  async (req: Request, res: Response) => {
    const userId = Number(req.params.userId);
    if (!userId || Number.isNaN(userId)) {
      return res
        .status(400)
        .json(fail("INVALID_USER_ID", "Invalid userId parameter."));
    }

    try {
      const userRes = await pool.query(
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

      if (userRes.rowCount === 0) {
        return res
          .status(404)
          .json(fail("USER_NOT_FOUND", "User not found."));
      }

      const user = userRes.rows[0];

      // Active subscription + plan
      const active = await getActiveSubscription(userId).catch(() => null);

      // Credits summary (may fail if period/credits not initialized yet)
      let credits = null;
      try {
        credits = await getCreditsSummaryForUser(userId);
      } catch (err) {
        console.warn(
          "Failed to load credits summary for user %s:",
          userId,
          err
        );
      }

      // Weekly schedule template
      let schedule: any[] = [];
      try {
        const schedRes = await pool.query(
          `
          SELECT
            id,
            day_of_week,
            direction,
            pickup_time,
            pickup_address,
            dropoff_address,
            is_active
          FROM user_schedules
          WHERE user_id = $1
          ORDER BY day_of_week ASC, direction ASC, pickup_time ASC
          `,
          [userId]
        );

        schedule = schedRes.rows;
      } catch (err) {
        console.warn(
          "Failed to load schedule template for user %s:",
          userId,
          err
        );
      }

      // Recent rides history
      let rides: any[] = [];
      try {
        const ridesRes = await pool.query(
          `
          SELECT
            id,
            pickup_location,
            dropoff_location,
            pickup_time,
            status,
            ride_type,
            notes
          FROM rides
          WHERE user_id = $1
          ORDER BY pickup_time DESC
          LIMIT 100
          `,
          [userId]
        );

        rides = ridesRes.rows;
      } catch (err) {
        console.warn(
          "Failed to load rides history for user %s:",
          userId,
          err
        );
      }

      return res.json(
        ok({
          user,
          subscription: active ? active.subscription : null,
          plan: active ? active.plan : null,
          credits,
          schedule,
          rides,
        })
      );
    } catch (err) {
      console.error("Error in GET /admin/users/:userId:", err);
      return res
        .status(500)
        .json(
          fail(
            "ADMIN_USER_DETAIL_FAILED",
            "Failed to load admin user details."
          )
        );
    }
  }
);

/**
 * POST /admin/users/:userId/subscription
 *
 * A convenience wrapper for activating a subscription for a user.
 * Body: { planCode, paymentMethod, notes? }
 */
adminRouter.post(
  "/users/:userId/subscription",
  requireAuth,
  requireRole("admin"),
  async (req: Request, res: Response) => {
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

      return res.json(
        ok({
          subscription,
          credits,
        })
      );
    } catch (err: any) {
      console.error("Error in POST /admin/users/:userId/subscription:", err);
      return res
        .status(500)
        .json(
          fail(
            "ADMIN_USER_SUBSCRIPTION_FAILED",
            err?.message || "Failed to update user subscription."
          )
        );
    }
  }
);

/**
 * POST /admin/users/:userId/credits
 *
 * Adjust a user's monthly ride credits.
 * Body: { standardDelta?: number, groceryDelta?: number }
 */
adminRouter.post(
  "/users/:userId/credits",
  requireAuth,
  requireRole("admin"),
  async (req: Request, res: Response) => {
    const userId = Number(req.params.userId);
    const { standardDelta, groceryDelta } = req.body as {
      standardDelta?: number;
      groceryDelta?: number;
    };

    if (!userId || Number.isNaN(userId)) {
      return res
        .status(400)
        .json(fail("INVALID_USER_ID", "Invalid userId parameter."));
    }

    const stdDelta = Number(standardDelta || 0);
    const groDelta = Number(groceryDelta || 0);

    if (stdDelta === 0 && groDelta === 0) {
      return res.status(400).json(
        fail(
          "NO_DELTA_PROVIDED",
          "Provide at least one of standardDelta or groceryDelta."
        )
      );
    }

    try {
      // Ensure current period & credits row exists
      const period = await getCurrentPeriod(userId);
      let creditsRow = period.creditsRow;

      if (!creditsRow) {
        // Try to bootstrap from active subscription
        const active = await getActiveSubscription(userId);
        if (!active) {
          return res.status(400).json(
            fail(
              "NO_ACTIVE_SUBSCRIPTION",
              "User has no active subscription; cannot adjust credits."
            )
          );
        }

        await initCreditsForPlan(userId, active.plan.code);
        const refreshed = await getCurrentPeriod(userId);
        creditsRow = refreshed.creditsRow;

        if (!creditsRow) {
          return res.status(500).json(
            fail(
              "CREDITS_INIT_FAILED",
              "Failed to initialize credits for this user."
            )
          );
        }
      }

      await pool.query(
        `
        UPDATE ride_credits_monthly
        SET
          standard_total = GREATEST(standard_total + $1, standard_used),
          grocery_total = GREATEST(grocery_total + $2, grocery_used)
        WHERE id = $3
        `,
        [stdDelta, groDelta, creditsRow.id]
      );

      const credits = await getCreditsSummaryForUser(userId);

      return res.json(ok({ credits }));
    } catch (err) {
      console.error("Error in POST /admin/users/:userId/credits:", err);
      return res
        .status(500)
        .json(
          fail(
            "ADMIN_USER_CREDITS_FAILED",
            "Failed to adjust user credits."
          )
        );
    }
  }
);

export { adminRouter };
export default adminRouter;
