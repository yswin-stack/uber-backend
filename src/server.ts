import http from "http";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { Server as SocketIOServer } from "socket.io";

import { initDb } from "./db/init";
import { ridesRouter } from "./routes/rides";     // NAMED EXPORT
import authRouter from "./routes/auth";           // DEFAULT EXPORT
import devRouter from "./routes/dev";             // DEFAULT EXPORT

dotenv.config();

const app = express();

/**
 * Basic middleware
 */
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "x-user-id"],
  })
);
app.use(express.json());

/**
 * Health check
 */
app.get("/", (_req, res) => {
  res.json({ ok: true, message: "Backend is running" });
});

/**
 * Routes
 */
app.use("/auth", authRouter);
app.use("/rides", ridesRouter);
app.use("/dev", devRouter);

/**
 * HTTP + Socket.IO server
 */
const PORT = Number(process.env.PORT) || 10000;
const httpServer = http.createServer(app);

const io = new SocketIOServer(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

/**
 * Socket.IO: rooms per ride + location broadcast
 */
io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  socket.on("join_ride", (data: { rideId: any }) => {
    try {
      const rideIdNum = Number(data.rideId);
      if (!rideIdNum || Number.isNaN(rideIdNum)) {
        console.warn("join_ride invalid rideId:", data);
        return;
      }

      const room = `ride_${rideIdNum}`;
      socket.join(room);
      console.log(`Socket ${socket.id} joined room ${room}`);
    } catch (err) {
      console.error("join_ride error:", err);
    }
  });

  socket.on("location_update", (payload: { rideId: any; lat: number; lng: number }) => {
    try {
      const rideIdNum = Number(payload.rideId);
      if (!rideIdNum || Number.isNaN(rideIdNum)) {
        console.warn("location_update invalid rideId:", payload);
        return;
      }

      const room = `ride_${rideIdNum}`;
      const out = {
        rideId: rideIdNum,
        lat: payload.lat,
        lng: payload.lng,
      };

      io.to(room).emit("location_update", out);
      console.log("Broadcast →", room, out);
    } catch (err) {
      console.error("location_update error:", err);
    }
  });

  socket.on("disconnect", () => {
    console.log("Socket disconnected:", socket.id);
  });
});

/**
 * Start server after DB init
 */
async function start() {
  try {
    await initDb();
    console.log("✅ Database initialized");

    httpServer.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error("❌ DB init failed", err);
    process.exit(1);
  }
}

start();
