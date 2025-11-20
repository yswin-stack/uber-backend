import { Server, Socket } from "socket.io";

interface DriverLocationPayload {
  rideId: number;
  lat: number;
  lng: number;
}

export function setupTrackingSockets(io: Server) {
  io.on("connection", (socket: Socket) => {
    console.log("🔌 Socket connected:", socket.id);

    // Rider joins a room for a specific ride
    socket.on("join_ride", (rideId: number) => {
      if (!rideId) return;
      const room = `ride:${rideId}`;
      socket.join(room);
      console.log(`👤 Rider socket ${socket.id} joined room ${room}`);
    });

    // Driver sends location updates for a ride
    socket.on("driver_location_update", (payload: DriverLocationPayload) => {
      const { rideId, lat, lng } = payload || {};
      if (!rideId || lat == null || lng == null) return;

      const room = `ride:${rideId}`;
      const message = { rideId, lat, lng, ts: Date.now() };

      // Broadcast to all riders in this ride room
      io.to(room).emit("location_update", message);
      console.log(`📍 Location update for ride ${rideId}:`, { lat, lng });
    });

    socket.on("disconnect", () => {
      console.log("❌ Socket disconnected:", socket.id);
    });
  });
}
