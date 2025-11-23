import { pool } from "../db/pool";

type RideStatus =
  | "requested"
  | "confirmed"
  | "driver_en_route"
  | "arrived"
  | "in_progress"
  | "completed"
  | "cancelled";

let twilioClient: any | null = null;

/**
 * Lazily initialize Twilio client.
 * If env vars are missing or twilio is not installed, returns null and logs a warning.
 */
function getTwilioClient(): any | null {
  if (twilioClient) return twilioClient;

  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;

  if (!sid || !token || !from) {
    console.warn(
      "[Twilio] Missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER – SMS disabled."
    );
    return null;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const twilio = require("twilio");
    twilioClient = twilio(sid, token);
    return twilioClient;
  } catch (err) {
    console.error("[Twilio] Failed to initialise Twilio client:", err);
    return null;
  }
}

/**
 * Simple helper to format pickup window like "8:10–8:20".
 * We’ll use a 10-minute window around the scheduled pickup time.
 */
function formatPickupWindow(pickupIso?: string | null): string | null {
  if (!pickupIso) return null;
  const d = new Date(pickupIso);
  if (Number.isNaN(d.getTime())) return null;

  const baseMinutes = d.getMinutes();
  const floored = Math.floor(baseMinutes / 10) * 10;

  const start = new Date(d.getTime());
  start.setMinutes(floored, 0, 0);

  const end = new Date(start.getTime() + 10 * 60 * 1000);

  const format = (date: Date) => {
    let h = date.getHours();
    const m = date.getMinutes();
    const h12 = h % 12 === 0 ? 12 : h % 12;
    const mm = m.toString().padStart(2, "0");
    const suffix = h < 12 ? "AM" : "PM";
    return `${h12}:${mm} ${suffix}`;
  };

  return `${format(start)}–${format(end)}`;
}

/**
 * Build the SMS text for the given ride status.
 */
function buildMessageForStatus(
  status: RideStatus,
  pickupTimeIso?: string | null
): string | null {
  const window = formatPickupWindow(pickupTimeIso);

  if (status === "confirmed") {
    return window
      ? `Your UniCab ride is confirmed for ${window}. Reply STOP to unsubscribe.`
      : `Your UniCab ride is confirmed. Reply STOP to unsubscribe.`;
  }

  if (status === "driver_en_route") {
    return "Your UniCab driver is on the way. ETA about 6–8 minutes.";
  }

  if (status === "arrived") {
    return "Your UniCab driver has arrived outside your pickup point.";
  }

  // For other statuses, we currently don’t send SMS
  return null;
}

/**
 * Best-effort insert into notifications table.
 * This is wrapped in try/catch so a mismatch in schema doesn’t break the app.
 */
async function insertNotificationRow(
  userId: number,
  rideId: number | null,
  status: RideStatus,
  message: string
): Promise<void> {
  try {
    await pool.query(
      `
      INSERT INTO notifications (user_id, ride_id, channel, type, message)
      VALUES ($1, $2, 'sms', 'ride_status', $3)
    `,
      [userId, rideId, message]
    );
  } catch (err) {
    console.error("[Notifications] Failed to insert notification row:", err);
    // swallow error – don't crash the request
  }
}

/**
 * Send Twilio SMS if user has a phone.
 * Also logs into notifications table.
 *
 * Safe to call from routes – it will not throw fatal errors up the stack.
 */
export async function sendRideStatusNotification(
  userId: number,
  rideId: number,
  status: RideStatus,
  pickupTimeIso?: string | null
): Promise<void> {
  const message = buildMessageForStatus(status, pickupTimeIso);
  if (!message) {
    // No SMS defined for this status
    return;
  }

  // 1) Insert notification row (best effort)
  await insertNotificationRow(userId, rideId, status, message);

  // 2) Try to send SMS via Twilio
  const client = getTwilioClient();
  const from = process.env.TWILIO_FROM_NUMBER;

  if (!client || !from) {
    console.warn("[Twilio] Skipping SMS send – client not configured.");
    return;
  }

  try {
    const userRes = await pool.query(
      `SELECT phone FROM users WHERE id = $1`,
      [userId]
    );
    if (userRes.rows.length === 0) {
      console.warn("[Twilio] No user found for user_id", userId);
      return;
    }

    const phone: string | null = userRes.rows[0].phone || null;
    if (!phone) {
      console.warn("[Twilio] User has no phone – skipping SMS for user", userId);
      return;
    }

    await client.messages.create({
      body: message,
      from,
      to: phone,
    });

    console.log(
      `[Twilio] Sent SMS to user ${userId} for ride ${rideId} status ${status}`
    );
  } catch (err) {
    console.error("[Twilio] Failed to send SMS:", err);
    // Do not rethrow – we don't want to break the API response.
  }
}
