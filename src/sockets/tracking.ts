import { Server, Socket } from "socket.io";
import { pool } from "../db/pool";
import {
  recordEtaUpdate,
  clearProximityStateForRide,
} from "../services/rideProximity";

/**
 * A simple payload type for driver location updates.
 */
type LocationUpdatePayload = {
  rideId: number;
  lat: number;
  lng: number;
};

/**
 * Statuses where it makes sense to track driver location
 * and show it to riders.
 */
const TRACKABLE_STATUSES = ["driver_en_route", "arrived", "in_progress"];

/**
 * Fetch the minimal information we need for a ride.
 */
async function getRideBasic(
  rideId: number
): Promise<{
  id: number;
  user_id: number;
  status: string;
  pickup_time: string;
} | null> {
  const res = await pool.query(
    `
    SELECT id, user_id, status, pickup_time
    FROM rides
    WHERE id = $1
    LIMIT 1
    `,
    [rideId]
  );

  if (!res.rowCount) return null;
  const row = res.rows[0];
  return {
    id: row.id,
    user_id: row.user_id,
    status: row.status,
    pickup_time: row.pickup_time,
  };
}

/**
 * Calculate a rough ETA in minutes based on scheduled pickup_time.
 * Since we don't (yet) have driving distance calculations wired in,
 * this is essentially "minutes until scheduled pickup".
 */
function calculateEtaMinutes(pickupTimeIso: string): number {
  const now = Date.now();
  const pickup = new Date(pickupTimeIso).getTime();
  if (Number.isNaN(pickup)) return 0;
  const diffMs = pickup - now;
  const diffMin = Math.round(diffMs / 60000);
  return Math.max(0, diffMin);
}

/**
 * Attach tracking handlers to the main Socket.IO server.
 * This is the core implementation used by both the named
 * and default exports.
 */
export function attachTrackingHandlers(io: Server) {
  io.on("connection", (socket: Socket) => {
    /**
     * Rider or driver joins a ride-specific room.
     * We keep the protocol simple: ride:ID rooms.
     */
    socket.on("join_ride_room", (payload: { rideId?: number }) => {
      const rideId = payload?.rideId;
      if (!rideId || Number.isNaN(Number(rideId))) return;

      const room = `ride:${rideId}`;
      socket.join(room);
    });

    /**
     * Driver sends location updates for a given ride.
     * - We rebroadcast to the ride room (so rider(s) see marker move)
     * - We emit a ride_eta_update event with a rough ETA
     * - We trigger proximity notifications (5-min / arrival)
     *   based on this ETA, without blocking the driver.
     */
    socket.on(
      "location_update",
      async (payload: LocationUpdatePayload) => {
        try {
          const rideId = Number(payload?.rideId);
          if (!rideId || Number.isNaN(rideId)) return;

          const ride = await getRideBasic(rideId);
          if (!ride) {
            return;
          }

          // If the ride is no longer trackable, do not send updates to riders.
          if (!TRACKABLE_STATUSES.includes(ride.status)) {
            // If ride is finished/cancelled, clean proximity state so we don't
            // accidentally reuse it if IDs get recycled in local dev.
            if (
              ride.status === "completed" ||
              ride.status === "cancelled" ||
              ride.status === "cancelled_by_user" ||
              ride.status === "cancelled_by_admin" ||
              ride.status === "no_show"
            ) {
              clearProximityStateForRide(rideId);
            }
            return;
          }

          const room = `ride:${rideId}`;
          const updatedAtIso = new Date().toISOString();

          // Broadcast live location to everyone in this ride room
          io.to(room).emit("location_update", {
            rideId,
            lat: payload.lat,
            lng: payload.lng,
            updatedAt: updatedAtIso,
          });

          // Calculate a rough ETA in minutes and broadcast it as well
          const etaMinutes = calculateEtaMinutes(ride.pickup_time);
          io.to(room).emit("ride_eta_update", {
            etaMinutes,
          });

          // Trigger 5-min and "driver is here" SMS as needed
          // (this function is best-effort and non-blocking from the driver's POV)
          recordEtaUpdate({
            rideId,
            userId: ride.user_id,
            etaMinutes,
          }).catch((err) => {
            console.error(
              "[tracking] Failed to record ETA proximity event:",
              err
            );
          });
        } catch (err) {
          console.error("Error processing location_update:", err);
        }
      }
    );

    socket.on("disconnect", () => {
      // At the moment we don't need explicit cleanup per socket.
      // Rooms and in-memory proximity state are keyed by ride, not socket.
    });
  });
}

/**
 * Named export used by src/server.ts:
 *   import { setupTrackingSockets } from "./sockets/tracking";
 *
 * We simply delegate to attachTrackingHandlers so we don't
 * duplicate any logic.
 */
export function setupTrackingSockets(io: Server) {
  attachTrackingHandlers(io);
}

/**
 * Default export remains for any existing imports that use:
 *   import setupTrackingSockets from "./sockets/tracking";
 */
export default attachTrackingHandlers;
