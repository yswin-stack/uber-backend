import { pool } from "../db/pool";
import {
  getCurrentMonthBounds,
  initCreditsForPlan,
} from "../services/subscriptionService";
import type { PlanCode } from "../shared/types";

/**
 * Monthly reset job:
 *  - Ensures active subscriptions have current_period_start/current_period_end set
 *    to the current month.
 *  - Re-initializes ride_credits_monthly for that period based on plan.
 *
 * Intended to be run once per day via a scheduler (e.g. Render cron).
 */
export async function runMonthlyResetJob(): Promise<void> {
  const { period_start, period_end } = getCurrentMonthBounds(new Date());

  console.log(
    `[monthlyReset] Running for period ${period_start} to ${period_end}`
  );

  const res = await pool.query(
    `
    SELECT
      s.id,
      s.user_id,
      p.code AS plan_code
    FROM subscriptions s
    JOIN subscription_plans p ON s.plan_id = p.id
    WHERE s.status = 'active'
      AND (s.current_period_start IS NULL OR s.current_period_start <> $1)
    `,
    [period_start]
  );

  if (res.rowCount === 0) {
    console.log("[monthlyReset] No subscriptions to update.");
    return;
  }

  for (const row of res.rows) {
    const subscriptionId: number = row.id;
    const userId: number = row.user_id;
    const planCode: PlanCode = row.plan_code as PlanCode;

    try {
      await pool.query(
        `
        UPDATE subscriptions
        SET current_period_start = $1,
            current_period_end   = $2
        WHERE id = $3
        `,
        [period_start, period_end, subscriptionId]
      );

      await initCreditsForPlan(userId, planCode);

      console.log(
        `[monthlyReset] Updated subscription ${subscriptionId} (user ${userId}) for plan ${planCode}`
      );
    } catch (err) {
      console.error(
        `[monthlyReset] Failed to update subscription ${subscriptionId} (user ${userId}):`,
        err
      );
    }
  }

  console.log(
    `[monthlyReset] Completed. Updated ${res.rowCount} subscription(s).`
  );
}

// Optional: allow running via "node dist/jobs/monthlyReset.js"
if (require.main === module) {
  runMonthlyResetJob()
    .then(() => {
      console.log("[monthlyReset] Done.");
      process.exit(0);
    })
    .catch((err) => {
      console.error("[monthlyReset] Error:", err);
      process.exit(1);
    });
}
