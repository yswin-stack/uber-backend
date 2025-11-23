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
    console.warn("⚠️ Failed to initialize Twilio. SMS will be logged only.", err);
    twilioClient = null;
  }
} else {
  console.log(
    "ℹ️ Twilio env vars not set (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER). SMS will be logged only."
  );
}

type RideNotificationStatus =
  | "booking_confirmed"
  | "driver_en_route"
  | "arrived"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "cancelled_by_user"
  | "cancelled_by_admin";

/**
 * Low-level SMS sender.
 */
async function sendSms(phone: string, body: string): Promise<void> {
  if (!phone) return;

  if (!twilioClient || !TWILIO_FROM_NUMBER) {
    console.log(`[SMS MOCK] to ${phone}: ${body}`);
    return;
  }

  try {
    await twilioClient.messages.create({
      from: TWILIO_FROM_NUMBER,
      to: phone,
      body,
    });
    console.log("[SMS] Sent to", phone);
  } catch (err) {
    console.error("❌ Failed to send SMS via Twilio:", err);
  }
}

/**
 * Build a human-readable message based on ride + status.
 */
function buildStatusMessage(
  status: RideNotificationStatus | string,
  userName: string | null,
  ride: {
    pickup_location: string;
    dropoff_location: string;
    pickup_window_start: string | null;
    pickup_window_end: string | null;
    arrival_window_start: string | null;
    arrival_window_end: string | null;
  },
  pickupTimeIso: string | null
): string {
  const namePrefix = userName ? `Hi ${userName}, ` : "";

  const formatTime = (iso: string | null) => {
    if (!iso) return "";
    const d = new Date(iso);
    const h = d.getHours();
    const m = d.getMinutes();
    const h12 = h % 12 === 0 ? 12 : h % 12;
    const mm = m.toString().padStart(2, "0");
    const suffix = h < 12 ? "AM" : "PM";
    return `${h12}:${mm} ${suffix}`;
  };

  const pickupWindow =
    ride.pickup_window_start && ride.pickup_window_end
      ? `${formatTime(ride.pickup_window_start)}–${formatTime(
          ride.pickup_window_end
        )}`
      : "";

  const arrivalWindow =
    ride.arrival_window_start && ride.arrival_window_end
      ? `${formatTime(ride.arrival_window_start)}–${formatTime(
          ride.arrival_window_end
        )}`
      : "";

  const pickupTimeLabel = pickupTimeIso ? formatTime(pickupTimeIso) : "";

  switch (status) {
    case "booking_confirmed":
      return (
        namePrefix +
        `your ride is booked: ${ride.pickup_location} → ${ride.dropoff_location}. ` +
        (pickupWindow
          ? `Pickup window: ${pickupWindow}.`
          : pickupTimeLabel
          ? `Pickup around ${pickupTimeLabel}.`
          : "")
      );

    case "driver_en_route":
      return (
        namePrefix +
        `your driver is on the way to ${ride.pickup_location}. ` +
        (pickupWindow ? `Pickup window: ${pickupWindow}.` : "")
      );

    case "arrived":
      return (
        namePrefix +
        `your driver has arrived at ${ride.pickup_location}. Please head outside.`
      );

    case "in_progress":
      return (
        namePrefix +
        `you’re on the way to ${ride.dropoff_location}. ` +
        (arrivalWindow ? `Arrival window: ${arrivalWindow}.` : "")
      );

    case "completed":
      return (
        namePrefix +
        `your ride from ${ride.pickup_location} to ${ride.dropoff_location} is complete. Thank you!`
      );

    case "cancelled":
    case "cancelled_by_user":
      return namePrefix + "your ride has been cancelled.";

    case "cancelled_by_admin":
      return (
        namePrefix +
        "your ride has been cancelled by the service. Please check the app or contact support if needed."
      );

    default:
      return (
        namePrefix +
        `your ride status changed (${status}). Check the app for the latest details.`
      );
  }
}

/**
 * Main helper used by routes.
 * - Looks up user phone/name and ride info
 * - Builds message
 * - Sends SMS (or logs it)
 * - Inserts row into notifications table
 */
export async function sendRideStatusNotification(
  userId: number,
  rideId: number,
  status: RideNotificationStatus | string,
  pickupTimeIso?: string | null
): Promise<void> {
  try {
    const userRes = await pool.query(
      `
      SELECT name, phone
      FROM users
      WHERE id = $1
      `,
      [userId]
    );

    if (userRes.rowCount === 0) {
      console.warn(
        "[Notifications] Cannot send SMS – user not found:",
        userId
      );
      return;
    }

    const { name, phone } = userRes.rows[0] as {
      name: string | null;
      phone: string | null;
    };

    if (!phone) {
      console.warn(
        "[Notifications] Skipping SMS – user has no phone on file:",
        userId
      );
      return;
    }

    const rideRes = await pool.query(
      `
      SELECT
        pickup_location,
        dropoff_location,
        pickup_window_start,
        pickup_window_end,
        arrival_window_start,
        arrival_window_end,
        pickup_time
      FROM rides
      WHERE id = $1
      `,
      [rideId]
    );

    if (rideRes.rowCount === 0) {
      console.warn("[Notifications] Cannot send SMS – ride not found:", rideId);
      return;
    }

    const ride = rideRes.rows[0] as {
      pickup_location: string;
      dropoff_location: string;
      pickup_window_start: string | null;
      pickup_window_end: string | null;
      arrival_window_start: string | null;
      arrival_window_end: string | null;
      pickup_time: string | null;
    };

    const effectivePickupTimeIso =
      pickupTimeIso || ride.pickup_time || null;

    const message = buildStatusMessage(
      status as RideNotificationStatus,
      name,
      ride,
      effectivePickupTimeIso
    );

    await sendSms(phone, message);

    await pool.query(
      `
      INSERT INTO notifications (user_id, ride_id, channel, message)
      VALUES ($1, $2, $3, $4)
      `,
      [userId, rideId, "sms", message]
    );
  } catch (err) {
    console.error("[Notifications] Failed to send ride status notification:", err);
  }
}
