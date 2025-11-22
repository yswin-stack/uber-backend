import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import http from "http";
import { Server as SocketIOServer } from "socket.io";

import { initDb } from "./db/init";
import { ridesRouter } from "./routes/rides";
import authRouter from "./routes/auth";
import devRouter from "./routes/dev";
import { scheduleRouter } from "./routes/schedule";
import { creditsRouter } from "./routes/credits";
import adminRouter from "./routes/admin";
import userRouter from "./routes/user";



dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: "*",
  },
});

// Basic middleware
app.use(cors({ origin: "*" }));
app.use(express.json());

// Health check
app.get("/", (_req, res) => {
  res.json({ ok: true, message: "Backend is running" });
});

// Routers
app.use("/auth", authRouter);
app.use("/rides", ridesRouter);
app.use("/schedule", scheduleRouter);
app.use("/credits", creditsRouter);
app.use("/dev", devRouter);
app.use("/admin", adminRouter); // ⬅️ add this line

// SOCKET.IO for live driver tracking
io.on("connection", (socket) => {
  console.log("Client connected", socket.id);

  socket.on("join_ride", (rideId: number) => {
    socket.join(`ride_${rideId}`);
  });

  socket.on(
    "driver_location_update",
    (payload: { rideId: number; lat: number; lng: number }) => {
      const { rideId, lat, lng } = payload;
      io.to(`ride_${rideId}`).emit("location_update", { lat, lng });
    }
  );

  socket.on("disconnect", () => {
    console.log("Client disconnected", socket.id);
  });
});

// Start server
async function start() {
  await initDb();
  const port = process.env.PORT || 10000;
  server.listen(port, () => {
    console.log(`🚀 Server listening on http://localhost:${port}`);
  });
}

start().catch((err) => {
  console.error("Fatal server start error:", err);
  process.exit(1);
});
