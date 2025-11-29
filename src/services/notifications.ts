import { pool } from "../db/pool";

// Optional Twilio support – if not configured, we just log to console.
let twilioClient: any = null;

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;

if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM_NUMBER) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const twilio = require("twilio");
    twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
    console.log("✅ Twilio SMS client initialized.");
  } catch (err) {
    console.error("❌ Failed to initialize Twilio client:", err);
    twilioClient = null;
  }
} else {
  console.log(
    "ℹ️ Twilio not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER). SMS will be logged only."
  );
}

/**
 * Low-level SMS sender.
 * If Twilio is configured, we send a real SMS; otherwise we log to stdout.
 */
export async function sendSms(to: string, message: string): Promise<void> {
  if (!to) {
    console.warn("[SMS] No destination phone provided. Skipping.");
    return;
  }

  if (!twilioClient || !TWILIO_FROM_NUMBER) {
    console.log(`[SMS MOCK] To=${to} :: ${message}`);
    return;
  }

  try {
    await twilioClient.messages.create({
      to,
      from: TWILIO_FROM_NUMBER,
      body: message,
    });
    console.log("[SMS] Sent message to", to);
  } catch (err) {
    console.error("[SMS] Failed to send SMS via Twilio:", err);
  }
}

// Events around a ride lifecycle that we care about for notifications.
// These include both actual statuses and synthetic events.
export type RideStatusNotificationEvent =
  | "booking_confirmed"
  | "driver_en_route"
  | "driver_5_mins_away"
  | "arrived"
  | "in_progress"
  | "completed"
  | "cancelled_by_user"
  | "cancelled_by_admin"
  | "cancelled"
  | "no_show";

/**
 * Builds a human-readable SMS message for a given ride event.
 */
function buildRideStatusMessage(
  event: RideStatusNotificationEvent,
  pickupTimeIso: string | null
): string {
  let timePart = "";
  if (pickupTimeIso) {
    try {
      const d = new Date(pickupTimeIso);
      if (!Number.isNaN(d.getTime())) {
        const timeStr = d.toLocaleTimeString("en-CA", {
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        });
        const dateStr = d.toLocaleDateString("en-CA", {
          month: "short",
          day: "numeric",
        });
        timePart = ` on ${dateStr} at ${timeStr}`;
      }
    } catch {
      // ignore date formatting failures
    }
  }

  switch (event) {
    case "booking_confirmed":
      return `Your ride is booked${timePart}. We'll send updates as your driver heads out.`;
    case "driver_en_route":
      return `Your driver is on the way${timePart}. Please be ready at your pickup point.`;
    case "driver_5_mins_away":
      return `Your driver is about 5 minutes away! Please head to your pickup point now.`;
    case "arrived":
      return `Your driver has arrived! 🚗 Please come out now. Driver will wait up to 5 minutes. Wait time charges may apply after 2 minutes.`;
    case "in_progress":
      return `You're on your way! 🚗 Please buckle up - we care about your safety! 😊`;
    case "completed":
      return `Ride complete! ✅ Thank you for riding with us. We'd love your feedback - rate your ride in the app!`;
    case "cancelled_by_user":
      return `Your ride has been cancelled as requested.`;
    case "cancelled_by_admin":
      return `Your ride was cancelled by the service. If this wasn't expected, please contact support.`;
    case "cancelled":
      return `Your ride has been cancelled.`;
    case "no_show":
      return `Your driver waited but could not find you. This ride was marked as a no-show.`;
    default:
      return `There's an update on your ride.`;
  }
}

/**
 * Send a proximity alert when driver is close to pickup
 * Called from the location tracking socket when driver is within threshold
 */
export async function sendProximityAlert(
  userId: number,
  rideId: number,
  minutesAway: number
): Promise<void> {
  if (minutesAway <= 5 && minutesAway > 0) {
    await sendRideStatusNotification(userId, rideId, "driver_5_mins_away", null);
  }
}

/**
 * High-level helper used across the backend whenever ride status changes
 * or a booking is created.
 *
 * - Looks up the user's phone number
 * - Builds a friendly message
 * - Sends SMS (real or mock)
 * - Stores a record in the notifications table (best-effort)
 */
export async function sendRideStatusNotification(
  userId: number,
  rideId: number,
  event: RideStatusNotificationEvent,
  pickupTimeIso: string | null
): Promise<void> {
  try {
    // 1) Get user's phone number (if present)
    const userRes = await pool.query(
      `
      SELECT phone
      FROM users
      WHERE id = $1
      `,
      [userId]
    );

    if (userRes.rowCount === 0) {
      console.warn(
        "[Notifications] User not found when sending ride status notification:",
        userId
      );
      return;
    }

    const phone: string | null = userRes.rows[0].phone || null;
    if (!phone) {
      console.warn(
        "[Notifications] User has no phone; skipping SMS for ride",
        rideId
      );
      return;
    }

    // 2) Build message & send SMS
    const message = buildRideStatusMessage(event, pickupTimeIso);
    await sendSms(phone, message);

    // 3) Best-effort: insert into notifications table for audit/history
    try {
      await pool.query(
        `
        INSERT INTO notifications (user_id, ride_id, channel, message)
        VALUES ($1, $2, $3, $4)
        `,
        [userId, rideId, "sms", message]
      );
    } catch (err) {
      // If the table doesn't exist yet, log and continue.
      console.warn(
        "[Notifications] Failed to persist notification record:",
        err
      );
    }
  } catch (err) {
    console.error(
      "[Notifications] Failed to send ride status notification:",
      err
    );
  }
}
