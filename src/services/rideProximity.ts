import { pool } from "../db/pool";

/**
 * We keep simple in-memory sets to avoid sending repeated
 * "5 min away" or "driver arrived" messages for the same ride.
 * This resets when the server restarts, which is acceptable for now.
 */

const fiveMinNotified = new Set<number>();
const arrivalNotified = new Set<number>();

type ProximityKind = "five_min" | "arrival_now";

type EtaUpdateArgs = {
  rideId: number;
  userId: number;
  etaMinutes: number;
};

/**
 * Look up the rider's phone number.
 */
async function getUserPhone(userId: number): Promise<string | null> {
  const res = await pool.query(
    `
    SELECT phone
    FROM users
    WHERE id = $1
    LIMIT 1
    `,
    [userId]
  );

  if (!res.rowCount) return null;
  const phone = res.rows[0].phone as string | null;
  if (!phone || typeof phone !== "string" || !phone.trim()) return null;
  return phone.trim();
}

/**
 * Right now we keep SMS as a stub: log out the message.
 * In production you'll plug in Twilio or your SMS provider here.
 */
async function sendProximitySmsToUser(
  userId: number,
  body: string
): Promise<void> {
  const phone = await getUserPhone(userId);
  if (!phone) {
    console.warn(
      "[rideProximity] No phone on file for user; skipping SMS.",
      { userId }
    );
    return;
  }

  // TODO: Plug in Twilio or other SMS provider.
  // Example:
  // await twilioClient.messages.create({ to: phone, from: TWILIO_FROM, body });

  console.log("[rideProximity] Would send SMS:", {
    userId,
    phone,
    body,
  });
}

/**
 * Send a specific proximity notification type.
 */
async function sendProximityNotification(args: {
  rideId: number;
  userId: number;
  kind: ProximityKind;
}) {
  const { rideId, userId, kind } = args;

  if (kind === "five_min") {
    await sendProximitySmsToUser(
      userId,
      "Your driver will be at your pickup in about 5 minutes."
    );
    fiveMinNotified.add(rideId);
    return;
  }

  if (kind === "arrival_now") {
    await sendProximitySmsToUser(
      userId,
      "Your driver is now at your pickup point. Please head outside. Driver will wait about 5 minutes before leaving."
    );
    arrivalNotified.add(rideId);
    return;
  }
}

/**
 * Called when we have a new ETA estimate for a ride.
 * Decides whether to trigger 5-min or arrival SMS.
 *
 * NOTE: This is intentionally conservative and based on ETA in minutes,
 * not actual GPS distance, because we don't yet store pickup lat/lng.
 */
export async function recordEtaUpdate({
  rideId,
  userId,
  etaMinutes,
}: EtaUpdateArgs): Promise<void> {
  if (!Number.isFinite(etaMinutes) || etaMinutes < 0) {
    return;
  }

  // "5 minutes away" notification
  if (etaMinutes <= 5 && !fiveMinNotified.has(rideId)) {
    try {
      await sendProximityNotification({
        rideId,
        userId,
        kind: "five_min",
      });
    } catch (err) {
      console.error(
        "[rideProximity] Failed to send 5-min proximity SMS:",
        err
      );
    }
  }

  // "Driver is here" / arrival notification
  if (etaMinutes <= 1 && !arrivalNotified.has(rideId)) {
    try {
      await sendProximityNotification({
        rideId,
        userId,
        kind: "arrival_now",
      });
    } catch (err) {
      console.error(
        "[rideProximity] Failed to send arrival proximity SMS:",
        err
      );
    }
  }
}

/**
 * When a ride is completed/cancelled, we can clean up
 * any in-memory state for it (best-effort).
 */
export function clearProximityStateForRide(rideId: number) {
  fiveMinNotified.delete(rideId);
  arrivalNotified.delete(rideId);
}
