import { Server, Socket } from "socket.io";
import jwt from "jsonwebtoken";
import { pool } from "../db/pool";
import { computeDistanceKm } from "../utils/distance";
import { getAiConfig } from "../services/aiConfig";
import type { RideStatus } from "../shared/types";

interface DriverLocationPayload {
  rideId: number;
  lat: number;
  lng: number;
}

interface JwtPayload {
  id: number;
  role: string;
  phone?: string | null;
}

interface AuthedSocket extends Socket {
  data: {
    userId?: number;
    role?: string;
  };
}

const JWT_SECRET = process.env.JWT_SECRET || "";

// Only allow tracking when ride is in one of these statuses
const TRACKABLE_RIDE_STATUSES: RideStatus[] = ["driver_en_route", "in_progress"];

// Fallback campus centre – used if we can't read a more precise destination.
const CAMPUS_CENTER = { lat: 49.8075, lng: -97.1325 };

export function setupTrackingSockets(io: Server) {
  io.on("connection", (socket: AuthedSocket) => {
    console.log("🔌 Socket connected:", socket.id);

    // --- 1) Best-effort JWT auth for this socket (for drivers) ---
    try {
      const tokenFromAuth =
        (socket.handshake.auth as any)?.token ||
        (socket.handshake.headers?.authorization as string | undefined);

      let token: string | null = null;

      if (tokenFromAuth && tokenFromAuth.startsWith("Bearer ")) {
        token = tokenFromAuth.slice("Bearer ".length);
      } else if (tokenFromAuth) {
        token = tokenFromAuth;
      } else {
        const queryToken = (socket.handshake.query as any)?.token;
        if (typeof queryToken === "string" && queryToken) {
          token = queryToken;
        }
      }

      if (token && JWT_SECRET) {
        const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
        if (decoded && typeof decoded.id === "number" && decoded.role) {
          socket.data.userId = decoded.id;
          socket.data.role = decoded.role;
          console.log(
            "✅ Socket authenticated:",
            socket.id,
            "user",
            decoded.id,
            "role",
            decoded.role
          );
        }
      }
    } catch (err) {
      console.warn("⚠️ Failed to authenticate socket:", err);
    }

    // --- 2) Riders join a room for a specific ride ---
    socket.on("join_ride_room", (payload: { rideId: number } | number) => {
      const rideId =
        typeof payload === "number" ? payload : Number(payload?.rideId);
      if (!rideId || Number.isNaN(rideId)) return;

      const room = `ride:${rideId}`;
      socket.join(room);
      console.log(`👥 Socket ${socket.id} joined room ${room}`);
    });

    // Legacy name kept for backwards compatibility
    socket.on("join_ride", (rideId: number) => {
      if (!rideId || Number.isNaN(rideId)) return;
      const room = `ride:${rideId}`;
      socket.join(room);
      console.log(`👥 Socket ${socket.id} joined room ${room} (legacy)`);
    });

    // --- 3) Driver sends live location updates ---
    socket.on("location_update", async (payload: DriverLocationPayload) => {
      const { rideId, lat, lng } = payload || ({} as DriverLocationPayload);

      if (!rideId || Number.isNaN(rideId)) return;
      if (typeof lat !== "number" || typeof lng !== "number") return;

      const room = `ride:${rideId}`;
      const nowIso = new Date().toISOString();

      // Always emit location_update to riders – even if validation fails later.
      const locationMessage = {
        rideId,
        lat,
        lng,
        updatedAt: nowIso,
      };
      io.to(room).emit("location_update", locationMessage);
      console.log(`📍 location_update for ride ${rideId}:`, {
        lat,
        lng,
        socket: socket.id,
      });

      // Validate that this socket belongs to a driver/admin
      const userId = socket.data.userId;
      const role = socket.data.role;
      if (!userId || !role || (role !== "driver" && role !== "admin")) {
        console.warn(
          "⚠️ location_update ignored: unauthenticated or non-driver socket",
          socket.id
        );
        return;
      }

      try {
        // Check that ride exists and is in a trackable status
        const rideRes = await pool.query(
          `
          SELECT status
          FROM rides
          WHERE id = $1
          `,
          [rideId]
        );

        if (rideRes.rowCount === 0) {
          console.warn(
            "⚠️ location_update for unknown ride id:",
            rideId
          );
          return;
        }

        const status = (rideRes.rows[0].status || "pending") as RideStatus;

        if (!TRACKABLE_RIDE_STATUSES.includes(status)) {
          console.warn(
            `⚠️ location_update ignored: ride ${rideId} in status ${status}`
          );
          return;
        }

        // Compute a simple ETA from driver's location to campus centre (fallback destination).
        // Later we can swap to real pickup/dropoff coordinates.
        const cfg = getAiConfig();
        const distanceKm = computeDistanceKm(
          lat,
          lng,
          CAMPUS_CENTER.lat,
          CAMPUS_CENTER.lng
        );

        // Avoid division by zero
        const effectiveSpeedKmh =
          cfg.travel_speed_kmh && cfg.travel_speed_kmh > 0
            ? cfg.travel_speed_kmh
            : 25;

        const etaMinutesFloat = (distanceKm / effectiveSpeedKmh) * 60;
        const etaMinutes = Math.max(1, Math.round(etaMinutesFloat));

        const etaDate = new Date();
        etaDate.setMinutes(etaDate.getMinutes() + etaMinutes);

        const etaMessage = {
          rideId,
          eta_minutes: etaMinutes,
          eta_arrival_time: etaDate.toISOString(),
        };

        io.to(room).emit("ride_eta_update", etaMessage);
        console.log("⏱ ride_eta_update:", etaMessage);
      } catch (err) {
        // Graceful fallback: we already emitted location_update; just log ETA failure.
        console.error(
          "❌ Failed to compute ETA/location validation for ride",
          rideId,
          err
        );
      }
    });

    socket.on("disconnect", () => {
      console.log("❌ Socket disconnected:", socket.id);
    });
  });
}
