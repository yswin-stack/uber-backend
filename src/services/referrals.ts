import { pool } from "../db/pool";

const DEFAULT_REWARD_CENTS = parseInt(
  process.env.REFERRAL_REWARD_CENTS || "5000",
  10
);

/**
 * Ensure a user has a referral_code. If missing, generate a simple
 * human-readable code based on the user id.
 */
export async function ensureReferralCodeForUser(userId: number): Promise<string> {
  const existing = await pool.query(
    "SELECT referral_code FROM users WHERE id = $1",
    [userId]
  );

  if ((existing.rowCount ?? 0) === 0) {
    throw new Error("User not found");
  }
  
  const current = existing.rows[0].referral_code as string | null;
  if (current && current.trim().length > 0) {
    return current;
  }

  // Generate a deterministic code from the user id.
  // Example: U-1A2B3
  const idPart = userId.toString(36).toUpperCase();
  const code = `U-${idPart}`;

  await pool.query(
    "UPDATE users SET referral_code = $1 WHERE id = $2",
    [code, userId]
  );

  return code;
}

export type ReferralSummary = {
  referral_code: string;
  referred_count: number;
  pending_reward_cents: number;
  total_reward_cents: number;
};

export async function getReferralSummaryForUser(
  userId: number
): Promise<ReferralSummary | null> {
  const code = await ensureReferralCodeForUser(userId);

  const res = await pool.query(
    `
    SELECT
      COUNT(*) FILTER (WHERE reward_applied = FALSE) AS pending_count,
      COALESCE(SUM(reward_cents) FILTER (WHERE reward_applied = FALSE), 0) AS pending_cents,
      COALESCE(SUM(reward_cents), 0) AS total_cents
    FROM referrals
    WHERE referrer_user_id = $1
    `,
    [userId]
  );

  const row = res.rows[0] || {
    pending_count: 0,
    pending_cents: 0,
    total_cents: 0,
  };

  return {
    referral_code: code,
    // Rough derived count from total reward; fine for now
    referred_count: Number(
      row.total_cents > 0 ? row.total_cents / DEFAULT_REWARD_CENTS : 0
    ),
    pending_reward_cents: Number(row.pending_cents),
    total_reward_cents: Number(row.total_cents),
  };
}

/**
 * Record that a user entered a referral code during signup / onboarding.
 * Business rule: one referral per referred user.
 */
export async function recordReferralUsage(
  referredUserId: number,
  referralCode: string
) {
  const referredRes = await pool.query(
    "SELECT id FROM users WHERE id = $1",
    [referredUserId]
  );
  if (referredRes.rowCount === 0) {
    throw new Error("Referred user not found");
  }

  const referrerRes = await pool.query(
    "SELECT id FROM users WHERE referral_code = $1",
    [referralCode]
  );

  if (referrerRes.rowCount === 0) {
    throw new Error("Referral code not found");
  }

  const referrerId = referrerRes.rows[0].id as number;

  if (referrerId === referredUserId) {
    throw new Error("You cannot use your own referral code.");
  }

  // Check if this user already has a referral recorded
  const existing = await pool.query(
    "SELECT id FROM referrals WHERE referred_user_id = $1",
    [referredUserId]
  );
  if (existing.rowCount > 0) {
    throw new Error("Referral already recorded for this user.");
  }

  await pool.query(
    `
    INSERT INTO referrals (
      referrer_user_id,
      referred_user_id,
      code,
      reward_cents
    ) VALUES ($1, $2, $3, $4)
    `,
    [referrerId, referredUserId, referralCode, DEFAULT_REWARD_CENTS]
  );
}

/**
 * Simple list for admin view.
 */
export async function listReferralsForAdmin(limit = 200) {
  const res = await pool.query(
    `
    SELECT
      r.id,
      r.referrer_user_id,
      u1.name AS referrer_name,
      u1.phone AS referrer_phone,
      r.referred_user_id,
      u2.name AS referred_name,
      u2.phone AS referred_phone,
      r.code,
      r.reward_cents,
      r.reward_applied,
      r.created_at
    FROM referrals r
    JOIN users u1 ON u1.id = r.referrer_user_id
    JOIN users u2 ON u2.id = r.referred_user_id
    ORDER BY r.created_at DESC
    LIMIT $1
    `,
    [limit]
  );

  return res.rows;
}

/**
 * Mark a referral reward as applied (e.g., discount given).
 */
export async function markReferralRewardApplied(referralId: number) {
  await pool.query(
    `
    UPDATE referrals
    SET reward_applied = TRUE
    WHERE id = $1
    `,
    [referralId]
  );
}
