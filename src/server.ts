import express from "express";
import cors from "cors";
import http from "http";
import { Server } from "socket.io";
import dotenv from "dotenv";

import authRouter from "./routes/auth";
import ridesRouter from "./routes/rides";
import scheduleRouter from "./routes/schedule";
import adminRouter from "./routes/admin";
import creditsRouter from "./routes/credits";
import devRouter from "./routes/dev";
import { initDb } from "./db/init";

dotenv.config();

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const PORT = process.env.PORT || 10000;

// --- Middleware ---
app.use(cors({ origin: "*" }));
app.use(express.json());

// --- Health check ---
app.get("/", (_req, res) => {
  res.json({ ok: true, message: "Backend is running" });
});

// --- Routers mounted here ---
// These paths MUST match what frontend uses:
//  - /auth/...
//  - /rides/...
//  - /schedule/...
//  - /admin/...
//  - /credits/...
//  - /dev/...
app.use("/auth", authRouter);
app.use("/rides", ridesRouter);
app.use("/schedule", scheduleRouter);
app.use("/admin", adminRouter);
app.use("/credits", creditsRouter);
app.use("/dev", devRouter);

// --- Socket.IO for live driver tracking ---
io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  // Rider joins a ride room
  socket.on("join_ride", (rideId: number) => {
    if (!rideId) return;
    const room = `ride_${rideId}`;
    socket.join(room);
    console.log(`Socket ${socket.id} joined room ${room}`);
  });

  // Driver sends location updates
  socket.on(
    "driver_location_update",
    (payload: { rideId?: number; lat?: number; lng?: number }) => {
      const { rideId, lat, lng } = payload || {};
      if (!rideId || lat == null || lng == null) return;
      const room = `ride_${rideId}`;
      io.to(room).emit("driver_location_update", { lat, lng });
    }
  );

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
  });
});

// --- Start server with DB init ---
async function start() {
  try {
    await initDb();
    server.listen(PORT, () => {
      console.log(`🚀 Server listening on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error("Failed to initialize database", err);
    process.exit(1);
  }
}

start();
