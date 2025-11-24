// src/routes/plans.ts

import { Router, Request, Response } from "express";
import { ok, fail } from "../lib/apiResponse";
import { requireAuth } from "../middleware/auth";
import { getPlanByCode } from "../services/subscriptionService";
import { pool } from "../db/pool";
import type { PlanCode } from "../shared/types";

export const plansRouter = Router();

/**
 * GET /plans
 *  - Returns list of active subscription plans for UI.
 */
plansRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `
      SELECT
        id,
        code,
        name,
        description,
        monthly_price_cents,
        included_ride_credits,
        included_grocery_credits,
        peak_access,
        max_slots,
        is_active
      FROM subscription_plans
      WHERE is_active = true
      ORDER BY monthly_price_cents ASC, id ASC
      `
    );

    const plans = result.rows.map((row) => ({
      id: row.id,
      code: row.code as PlanCode,
      name: row.name,
      description: row.description,
      monthly_price_cents: row.monthly_price_cents,
      included_ride_credits: row.included_ride_credits,
      included_grocery_credits: row.included_grocery_credits,
      peak_access: !!row.peak_access,
      max_slots: row.max_slots,
    }));

    return res.json(ok(plans));
  } catch (err) {
    console.error("Error in GET /plans:", err);
    return res
      .status(500)
      .json(fail("PLANS_LIST_FAILED", "Failed to load plans."));
  }
});

/**
 * POST /plans/request
 * Body: { planCode }
 *
 * Marks that the logged-in user wants a plan. We add a "pending" row in
 * subscriptions table pointing at that plan. Admin later confirms + activates.
 */
plansRouter.post(
  "/request",
  requireAuth,
  async (req: Request, res: Response) => {
    const authUser = req.user!;
    const { planCode } = req.body as { planCode?: PlanCode };

    if (!planCode) {
      return res
        .status(400)
        .json(fail("PLAN_CODE_REQUIRED", "planCode is required."));
    }

    try {
      const plan = await getPlanByCode(planCode);
      if (!plan || !plan.is_active) {
        return res
          .status(400)
          .json(fail("PLAN_NOT_FOUND", "Selected plan is not available."));
      }

      const insert = await pool.query(
        `
        INSERT INTO subscriptions (
          user_id,
          plan_id,
          status,
          start_date,
          end_date,
          current_period_start,
          current_period_end,
          payment_method,
          notes
        )
        VALUES ($1, $2, 'pending', NULL, NULL, NULL, NULL, NULL, $3)
        RETURNING id, status
        `,
        [authUser.id, plan.id, `Requested plan: ${plan.code}`]
      );

      const subRow = insert.rows[0];

      return res.json(
        ok({
          subscriptionId: subRow.id,
          status: subRow.status,
          planCode: plan.code,
        })
      );
    } catch (err) {
      console.error("Error in POST /plans/request:", err);
      return res
        .status(500)
        .json(
          fail(
            "PLAN_REQUEST_FAILED",
            "Failed to record your plan request. Please try again."
          )
        );
    }
  }
);
