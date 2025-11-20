import { Server, Socket } from "socket.io";

interface TrackingAuth {
  role?: "driver" | "rider";
  driverId?: string;
  userId?: string;
}

export function setupTrackingSockets(io: Server) {
  io.on("connection", (socket: Socket) => {
    const auth = socket.handshake.auth as TrackingAuth;

    console.log("Socket connected", {
      id: socket.id,
      role: auth.role,
      driverId: auth.driverId,
      userId: auth.userId,
    });

    socket.on("join_ride", (rideId: string) => {
      if (!rideId) return;
      socket.join(rideId);
      console.log(`Socket ${socket.id} joined ride room ${rideId}`);
    });

    // Driver sends location updates
    socket.on(
      "location_update",
      (payload: { rideId: string; lat: number; lng: number }) => {
        const { rideId, lat, lng } = payload || {};
        if (!rideId || typeof lat !== "number" || typeof lng !== "number") {
          return;
        }

        const auth = socket.handshake.auth as TrackingAuth;
        if (auth.role !== "driver") {
          console.warn("Non-driver tried to send location_update");
          return;
        }

        // Broadcast to riders in this ride room
        io.to(rideId).emit("location_update", {
          rideId,
          lat,
          lng,
          updatedAt: new Date().toISOString(),
        });

        // Mock ETA calculation
        const mockEtaMinutes = 5 + Math.floor(Math.random() * 10);
        io.to(rideId).emit("ride_eta_update", {
          rideId,
          etaMinutes: mockEtaMinutes,
        });
      }
    );

    socket.on("disconnect", () => {
      console.log("Socket disconnected", socket.id);
    });
  });
}
