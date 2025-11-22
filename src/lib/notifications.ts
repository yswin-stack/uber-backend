import twilio from "twilio";
import { pool } from "../db/pool";

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromNumber = process.env.TWILIO_FROM_NUMBER;

// Only create client if creds exist (so local dev without Twilio doesn't crash)
const twilioClient =
  accountSid && authToken ? twilio(accountSid, authToken) : null;

export async function sendSmsOrLog(
  userId: number,
  rideId: number | null,
  toPhone: string | null,
  body: string
) {
  // Always log to notifications table
  await pool.query(
    `
    INSERT INTO notifications (user_id, ride_id, type, channel, message)
    VALUES ($1, $2, 'sms', $3, $4)
  `,
    [userId, rideId, twilioClient ? "twilio" : "none", body]
  );

  if (!twilioClient || !fromNumber) {
    console.log("Twilio not configured; SMS not sent. Message:", body);
    return;
  }

  if (!toPhone) {
    console.log("No phone number for user", userId, "Message:", body);
    return;
  }

  try {
    await twilioClient.messages.create({
      from: fromNumber,
      to: toPhone,
      body,
    });
  } catch (err) {
    console.error("Error sending SMS via Twilio:", err);
  }
}
