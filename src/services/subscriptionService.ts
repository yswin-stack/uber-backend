import { pool } from "../db/pool";
import { logEvent } from "./analytics";

import type {
  PlanCode,
  SubscriptionStatus,
  Subscription,
  CreditsSummary,
} from "../shared/types";

/**
 * Row from subscription_plans table.
 */
export interface SubscriptionPlan {
  id: number;
  code: PlanCode;
  name: string;
  description: string | null;
  monthly_price_cents: number;
  included_ride_credits: number;
  included_grocery_credits: number;
  peak_access: boolean;
  max_slots: number | null;
  is_active: boolean;
}

/**
 * Shape returned by getActiveSubscription – combines subscription + plan details.
 */
export interface ActiveSubscription {
  subscription: Subscription;
  plan: SubscriptionPlan;
}

/**
 * Compute the start and end of the current billing period.
 * For now: calendar month in UTC, e.g. 2025-11-01 to 2025-11-30.
 */
export function getCurrentMonthBounds(date: Date = new Date()): {
  period_start: string;
  period_end: string;
} {

  const year = date.getUTCFullYear();
  const month = date.getUTCMonth(); // 0-based

  const start = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  const nextMonth = month === 11 ? 0 : month + 1;
  const nextYear = month === 11 ? year + 1 : year;
  const nextStart = new Date(Date.UTC(nextYear, nextMonth, 1, 0, 0, 0, 0));
  const end = new Date(nextStart.getTime() - 1); // last ms of current month

  const period_start = start.toISOString().slice(0, 10); // YYYY-MM-DD
  const period_end = end.toISOString().slice(0, 10);

  return { period_start, period_end };
}

/**
 * Fetch a subscription plan by its code.
 */
export async function getPlanByCode(
  planCode: PlanCode
): Promise<SubscriptionPlan | null> {
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
    WHERE code = $1
    `,
    [planCode]
  );

  if (result.rowCount === 0) return null;

  const row = result.rows[0];

  return {
    id: row.id,
    code: row.code as PlanCode,
    name: row.name,
    description: row.description ?? null,
    monthly_price_cents: row.monthly_price_cents,
    included_ride_credits: row.included_ride_credits,
    included_grocery_credits: row.included_grocery_credits,
    peak_access: !!row.peak_access,
    max_slots: row.max_slots ?? null,
    is_active: !!row.is_active,
  };
}

/**
 * Get (or infer) the current period + any existing credits row for that period.
 * Uses existing V1 schema: ride_credits_monthly(month_start,...)
 */
export async function getCurrentPeriod(userId: number): Promise<{
  period_start: string;
  period_end: string;
  creditsRow: {
    id: number;
    user_id: number;
    month_start: string;
    standard_total: number;
    standard_used: number;
    grocery_total: number;
    grocery_used: number;
  } | null;
}> {
  const { period_start, period_end } = getCurrentMonthBounds();

  const creditsRes = await pool.query(
    `
    SELECT
      id,
      user_id,
      month_start,
      standard_total,
      standard_used,
      grocery_total,
      grocery_used
    FROM ride_credits_monthly
    WHERE user_id = $1 AND month_start = $2
    `,
    [userId, period_start]
  );

  const creditsRow =
    creditsRes.rowCount > 0 ? (creditsRes.rows[0] as any) : null;

  return {
    period_start,
    period_end,
    creditsRow,
  };
}

/**
 * Return a simple CreditsSummary for the current period.
 * If no row exists yet, we return zeros.
 */
export async function getCreditsSummaryForUser(
  userId: number
): Promise<CreditsSummary> {
  const { period_start } = await getCurrentPeriod(userId);

  const res = await pool.query(
    `
    SELECT
      standard_total,
      standard_used,
      grocery_total,
      grocery_used
    FROM ride_credits_monthly
    WHERE user_id = $1 AND month_start = $2
    `,
    [userId, period_start]
  );

  if (res.rowCount === 0) {
    return {
      standard_total: 0,
      standard_used: 0,
      grocery_total: 0,
      grocery_used: 0,
    };
  }

  const row = res.rows[0];
  return {
    standard_total: row.standard_total ?? 0,
    standard_used: row.standard_used ?? 0,
    grocery_total: row.grocery_total ?? 0,
    grocery_used: row.grocery_used ?? 0,
  };
}

/**
 * Initialize or refresh monthly credits for a user based on their plan.
 * This does not enforce anything yet – it just prepares data.
 */
export async function initCreditsForPlan(
  userId: number,
  planCode: PlanCode
): Promise<void> {
  const plan = await getPlanByCode(planCode);
  if (!plan) {
    throw new Error(`Unknown plan code: ${planCode}`);
  }

  const { period_start } = getCurrentMonthBounds();

  await pool.query(
    `
    INSERT INTO ride_credits_monthly (
      user_id,
      month_start,
      standard_total,
      standard_used,
      grocery_total,
      grocery_used
    )
    VALUES ($1, $2, $3, 0, $4, 0)
    ON CONFLICT (user_id, month_start) DO UPDATE SET
      standard_total = EXCLUDED.standard_total,
      grocery_total = EXCLUDED.grocery_total
    `,
    [
      userId,
      period_start,
      plan.included_ride_credits,
      plan.included_grocery_credits,
    ]
  );
}

/**
 * Get the most recent active subscription for a user, with plan details.
 */
export async function getActiveSubscription(
  userId: number
): Promise<ActiveSubscription | null> {
  const res = await pool.query(
    `
    SELECT
      s.id,
      s.user_id,
      s.status,
      s.start_date,
      s.end_date,
      s.current_period_start,
      s.current_period_end,
      s.payment_method,
      s.notes,
      p.id      AS plan_id,
      p.code    AS plan_code,
      p.name    AS plan_name,
      p.description AS plan_description,
      p.monthly_price_cents,
      p.included_ride_credits,
      p.included_grocery_credits,
      p.peak_access,
      p.max_slots,
      p.is_active
    FROM subscriptions s
    JOIN subscription_plans p ON s.plan_id = p.id
    WHERE s.user_id = $1
      AND s.status = 'active'
    ORDER BY COALESCE(s.current_period_start, s.start_date) DESC, s.id DESC
    LIMIT 1
    `,
    [userId]
  );

  if (res.rowCount === 0) return null;

  const row = res.rows[0];

  const rawStart =
    row.current_period_start !== null && row.current_period_start !== undefined
      ? row.current_period_start
      : row.start_date;
  const rawEnd =
    row.current_period_end !== null && row.current_period_end !== undefined
      ? row.current_period_end
      : row.end_date;

  const start_date =
    rawStart instanceof Date
      ? rawStart.toISOString().slice(0, 10)
      : String(rawStart);
  const end_date =
    rawEnd instanceof Date ? rawEnd.toISOString().slice(0, 10) : String(rawEnd);

  const subscription: Subscription = {
    id: row.id,
    user_id: row.user_id,
    plan_code: row.plan_code as PlanCode,
    status: (row.status || "active") as SubscriptionStatus,
    start_date,
    end_date,
  };

  const plan: SubscriptionPlan = {
    id: row.plan_id,
    code: row.plan_code as PlanCode,
    name: row.plan_name,
    description: row.plan_description ?? null,
    monthly_price_cents: row.monthly_price_cents,
    included_ride_credits: row.included_ride_credits,
    included_grocery_credits: row.included_grocery_credits,
    peak_access: !!row.peak_access,
    max_slots: row.max_slots ?? null,
    is_active: !!row.is_active,
  };

  return { subscription, plan };
}

/**
 * Activate a subscription for the given user + plan.
 *  - Links user to plan
 *  - Creates a new row in subscriptions table
 *  - Initializes monthly credits based on that plan
 *
 * Admin routes will call this in Step 4; here we only provide the helper.
 */
export async function activateSubscription(
  userId: number,
  planCode: PlanCode,
  paymentMethod: "cash" | "card_placeholder" | "apple_pay_placeholder",
  notes?: string
): Promise<Subscription> {
  const plan = await getPlanByCode(planCode);
  if (!plan) {
    throw new Error(`Unknown plan code: ${planCode}`);
  }

  const { period_start, period_end } = getCurrentMonthBounds();

  const result = await pool.query(
    `
    INSERT INTO subscriptions (
      user_id,
      plan_id,
      start_date,
      end_date,
      status,
      current_period_start,
      current_period_end,
      payment_method,
      notes
    )
    VALUES ($1, $2, $3, $4, 'active', $3, $4, $5, $6)
    RETURNING
      id,
      user_id,
      status,
      start_date,
      end_date,
      current_period_start,
      current_period_end
    `,
    [userId, plan.id, period_start, period_end, paymentMethod, notes ?? null]
  );

  const row = result.rows[0];

  // Initialize / refresh credits for the period
  await initCreditsForPlan(userId, plan.code as PlanCode);

  const rawStart =
    row.current_period_start !== null && row.current_period_start !== undefined
      ? row.current_period_start
      : row.start_date;
  const rawEnd =
    row.current_period_end !== null && row.current_period_end !== undefined
      ? row.current_period_end
      : row.end_date;

  const start_date =
    rawStart instanceof Date
      ? rawStart.toISOString().slice(0, 10)
      : String(rawStart);
  const end_date =
    rawEnd instanceof Date ? rawEnd.toISOString().slice(0, 10) : String(rawEnd);

  const subscription: Subscription = {
    id: row.id,
    user_id: row.user_id,
    plan_code: plan.code as PlanCode,
    status: (row.status || "active") as SubscriptionStatus,
    start_date,
    end_date,
  };

   // Analytics: subscription activated/changed
  try {
    await logEvent("subscription_activate", {
      userId,
      planCode: plan.code,
      paymentMethod,
      period_start: subscription.start_date,
      period_end: subscription.end_date,
    });
  } catch (logErr) {
    console.warn("[analytics] Failed to log subscription_activate:", logErr);
  }


  return subscription;
}
