import { pool } from "../db/pool";

export type CreditSummary = {
  user_id: number;
  period_start: string;
  period_end: string;
  standard_total: number;
  standard_used: number;
  grocery_total: number;
  grocery_used: number;
};

/**
 * Decide what "billing period" means.
 * For now: rolling 30-day period.
 *
 * - If there is a current row whose period_end > now → use that
 * - Otherwise, create new row starting today for 30 days
 */
export async function getOrCreateCurrentCredits(
  userId: number
): Promise<CreditSummary> {
  const now = new Date().toISOString();

  const existing = await pool.query(
    `
    SELECT id, user_id, period_start, period_end,
           standard_total, standard_used, grocery_total, grocery_used
    FROM ride_credits_monthly
    WHERE user_id = $1
      AND period_end > $2
    ORDER BY period_start DESC
    LIMIT 1
  `,
    [userId, now]
  );

  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    return {
      user_id: row.user_id,
      period_start: row.period_start,
      period_end: row.period_end,
      standard_total: row.standard_total,
      standard_used: row.standard_used,
      grocery_total: row.grocery_total,
      grocery_used: row.grocery_used,
    };
  }

  // No active period → create a new 30-day window
  const start = new Date();
  const end = new Date(start.getTime() + 30 * 24 * 60 * 60 * 1000);

  const standardTotal = 40;
  const groceryTotal = 4;

  const insert = await pool.query(
    `
    INSERT INTO ride_credits_monthly (
      user_id,
      period_start,
      period_end,
      standard_total,
      standard_used,
      grocery_total,
      grocery_used
    )
    VALUES ($1, $2, $3, $4, 0, $5, 0)
    RETURNING user_id, period_start, period_end,
              standard_total, standard_used, grocery_total, grocery_used
  `,
    [userId, start.toISOString(), end.toISOString(), standardTotal, groceryTotal]
  );

  const row = insert.rows[0];
  return {
    user_id: row.user_id,
    period_start: row.period_start,
    period_end: row.period_end,
    standard_total: row.standard_total,
    standard_used: row.standard_used,
    grocery_total: row.grocery_total,
    grocery_used: row.grocery_used,
  };
}

/**
 * Consume one credit for the given ride type
 * (called when a ride is completed for the first time).
 *
 * Returns updated summary or null if no credits row.
 */
export async function consumeCredit(
  userId: number,
  rideType: "standard" | "grocery"
): Promise<CreditSummary | null> {
  // Make sure we have a current period
  const summary = await getOrCreateCurrentCredits(userId);

  const col =
    rideType === "grocery" ? "grocery_used" : "standard_used";

  const updated = await pool.query(
    `
    UPDATE ride_credits_monthly
    SET ${col} = ${col} + 1
    WHERE user_id = $1
      AND period_start = $2
      AND period_end = $3
    RETURNING user_id, period_start, period_end,
              standard_total, standard_used, grocery_total, grocery_used
  `,
    [summary.user_id, summary.period_start, summary.period_end]
  );

  if (updated.rows.length === 0) {
    return null;
  }

  const row = updated.rows[0];
  return {
    user_id: row.user_id,
    period_start: row.period_start,
    period_end: row.period_end,
    standard_total: row.standard_total,
    standard_used: row.standard_used,
    grocery_total: row.grocery_total,
    grocery_used: row.grocery_used,
  };
}
