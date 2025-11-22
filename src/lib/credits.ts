import { pool } from "../db/pool";

function getMonthStart(date: Date = new Date()): string {
  const d = new Date(date);
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

export type CreditsSummary = {
  standard_total: number;
  standard_used: number;
  grocery_total: number;
  grocery_used: number;
};

export async function ensureMonthlyCreditsRow(
  userId: number,
  now: Date = new Date()
): Promise<CreditsSummary> {
  const monthStart = getMonthStart(now);

  const result = await pool.query(
    `
    INSERT INTO ride_credits_monthly (user_id, month_start)
    VALUES ($1, $2)
    ON CONFLICT (user_id, month_start)
    DO UPDATE SET month_start = EXCLUDED.month_start
    RETURNING standard_total, standard_used, grocery_total, grocery_used
  `,
    [userId, monthStart]
  );

  return result.rows[0];
}

export async function getCreditsSummary(
  userId: number,
  now: Date = new Date()
): Promise<CreditsSummary> {
  const monthStart = getMonthStart(now);
  const result = await pool.query(
    `
    SELECT standard_total, standard_used, grocery_total, grocery_used
    FROM ride_credits_monthly
    WHERE user_id = $1 AND month_start = $2
  `,
    [userId, monthStart]
  );

  if (result.rowCount === 0) {
    return ensureMonthlyCreditsRow(userId, now);
  }
  return result.rows[0];
}

export async function consumeCreditForRide(
  userId: number,
  rideType: "standard" | "grocery",
  now: Date = new Date()
): Promise<{ ok: boolean; message?: string }> {
  const monthStart = getMonthStart(now);

  // Ensure row exists
  await ensureMonthlyCreditsRow(userId, now);

  // Lock row for update
  const result = await pool.query(
    `
    SELECT id, standard_total, standard_used, grocery_total, grocery_used
    FROM ride_credits_monthly
    WHERE user_id = $1 AND month_start = $2
    FOR UPDATE
  `,
    [userId, monthStart]
  );

  if (result.rowCount === 0) {
    return { ok: false, message: "Could not find credits row." };
  }

  const row = result.rows[0];

  if (rideType === "standard") {
    if (row.standard_used >= row.standard_total) {
      return {
        ok: false,
        message: "No standard ride credits left for this month.",
      };
    }

    await pool.query(
      `
      UPDATE ride_credits_monthly
      SET standard_used = standard_used + 1
      WHERE id = $1
    `,
      [row.id]
    );
  } else {
    if (row.grocery_used >= row.grocery_total) {
      return {
        ok: false,
        message: "No grocery ride credits left for this month.",
      };
    }

    await pool.query(
      `
      UPDATE ride_credits_monthly
      SET grocery_used = grocery_used + 1
      WHERE id = $1
    `,
      [row.id]
    );
  }

  return { ok: true };
}
