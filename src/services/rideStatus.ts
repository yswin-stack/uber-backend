import { pool } from "../db/pool";
import type { RideStatus } from "../shared/types";

export type RideActorType = "system" | "rider" | "driver" | "admin";

const CANCELLED_STATUSES: RideStatus[] = [
  "cancelled",
  "cancelled_by_user",
  "cancelled_by_admin",
  "cancelled_by_driver",
  "no_show",
];

const ALLOWED_TRANSITIONS: Record<RideStatus, RideStatus[]> = {
  // Initial / scheduled states
  pending: ["driver_en_route", "cancelled_by_user", "cancelled_by_admin"],
  scheduled: ["driver_en_route", "cancelled_by_user", "cancelled_by_admin"],

  // Driver flow
  driver_en_route: ["arrived", "cancelled_by_driver", "cancelled_by_admin"],
  arrived: ["in_progress", "cancelled_by_driver", "cancelled_by_admin"],
  in_progress: ["completed", "cancelled_by_driver", "cancelled_by_admin"],

  // Terminal states
  completed: [],
  cancelled: [],
  cancelled_by_user: [],
  cancelled_by_admin: [],
  cancelled_by_driver: [],
  no_show: [],
};

/**
 * Check if a ride can transition from one status to another.
 */
export function canTransition(
  from: RideStatus,
  to: RideStatus
): boolean {
  if (from === to) return true;
  const allowed = ALLOWED_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to);
}

export { CANCELLED_STATUSES };

/**
 * Insert a row into ride_events for auditing.
 */
export async function logRideEvent(args: {
  rideId: number;
  oldStatus: RideStatus;
  newStatus: RideStatus;
  actorType: RideActorType;
  actorId?: number | null;
  meta?: Record<string, any>;
}): Promise<void> {
  const { rideId, oldStatus, newStatus, actorType, actorId, meta } = args;

  try {
    await pool.query(
      `
      INSERT INTO ride_events (
        ride_id,
        old_status,
        new_status,
        actor_type,
        actor_id,
        meta
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [
        rideId,
        oldStatus,
        newStatus,
        actorType,
        actorId ?? null,
        meta ? JSON.stringify(meta) : null,
      ]
    );
  } catch (err) {
    // We never want logging to break the main flow.
    console.warn(
      "Failed to log ride event for ride_id=%s: %s",
      rideId,
      (err as any)?.message || err
    );
  }
}
