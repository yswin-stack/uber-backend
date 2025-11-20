import twilio from "twilio";

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromNumber = process.env.TWILIO_FROM_NUMBER;
const riderTestPhone = process.env.RIDER_TEST_PHONE; // your phone for now

let client: twilio.Twilio | null = null;

if (accountSid && authToken) {
  client = twilio(accountSid, authToken);
} else {
  console.warn(
    "Twilio not fully configured. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN env vars to enable SMS."
  );
}

function buildStatusMessage(
  rideId: number,
  prevStatus: string,
  newStatus: string
): string | null {
  const transition = `${prevStatus}->${newStatus}`;

  switch (transition) {
    case "pending->driver_en_route":
      return `Your driver is on the way for ride #${rideId}.`;
    case "driver_en_route->arrived":
      return `Your driver has arrived at pickup for ride #${rideId}.`;
    case "arrived->in_progress":
      return `Your ride #${rideId} is now in progress.`;
    case "in_progress->completed":
      return `Your ride #${rideId} is complete. Hope it went well.`;
    default:
      break;
  }

  if (newStatus === "cancelled") {
    return `Your ride #${rideId} was cancelled.`;
  }

  return null;
}

export async function sendRideStatusSms(
  rideId: number,
  prevStatus: string,
  newStatus: string
): Promise<void> {
  try {
    if (!client) {
      console.warn("Twilio client not initialized; skipping SMS.");
      return;
    }

    if (!fromNumber || !riderTestPhone) {
      console.warn("TWILIO_FROM_NUMBER or RIDER_TEST_PHONE not set; skipping SMS.");
      return;
    }

    const body = buildStatusMessage(rideId, prevStatus, newStatus);
    if (!body) {
      // No SMS needed for this transition
      return;
    }

    await client.messages.create({
      from: fromNumber,
      to: riderTestPhone,
      body,
    });

    console.log("✅ Sent SMS:", body);
  } catch (err) {
    console.error("❌ Failed to send SMS via Twilio:", err);
  }
}
