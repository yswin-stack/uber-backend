// src/services/analytics.ts
import { pool } from "../db/pool";

export type AnalyticsEventName =
  | "login"
  | "subscription_activate"
  | "ride_created"
  | "ride_completed"
  | "ride_cancelled";

export interface AnalyticsEventPayload {
  [key: string]: unknown;
}

/**
 * Lightweight analytics logger.
 *
 * - Always logs structured JSON to stdout (Render logs, etc).
 * - Tries to write into analytics_events table IF it exists.
 *   If the table is missing, it just logs a warning and keeps going.
 */
export async function logEvent(
  name: AnalyticsEventName,
  payload: AnalyticsEventPayload = {}
): Promise<void> {
  const entry = {
    name,
    payload,
    timestamp: new Date().toISOString(),
  };

  try {
    // Good enough for now: structured logging
    // eslint-disable-next-line no-console
    console.log("[analytics]", JSON.stringify(entry));
  } catch {
    // ignore logging errors
  }

  // Optional DB logging (safe even if table does not exist)
  try {
    await pool.query(
      `
      INSERT INTO analytics_events (name, payload, created_at)
      VALUES ($1, $2, NOW())
      `,
      [name, payload]
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[analytics] Failed to persist analytics event (non-fatal):",
      err
    );
  }
}
