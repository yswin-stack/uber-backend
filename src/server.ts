import express from "express";
import http from "http";
import cors from "cors";
import { Server as SocketIOServer } from "socket.io";
import dotenv from "dotenv";

import { initDb } from "./db/init";

// Routes (all as default exports)
import authRouter from "./routes/auth";
import devRouter from "./routes/dev";
import ridesRouter from "./routes/rides";
import scheduleRouter from "./routes/schedule";
import adminRouter from "./routes/admin";
import { creditsRouter } from "./routes/credits";

dotenv.config();

const app = express();
const server = http.createServer(app);

const io = new SocketIOServer(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// Basic middleware
app.use(cors({ origin: "*"}));
app.use(express.json());

// Health check
app.get("/", (_req, res) => {
  res.json({ ok: true, message: "Backend is running" });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, status: "healthy" });
});

// Mount routes
app.use("/auth", authRouter);
app.use("/dev", devRouter);
app.use("/rides", ridesRouter);
app.use("/schedule", scheduleRouter);
app.use("/admin", adminRouter);
app.use("/credits", creditsRouter);

// -------------------------
// Socket.IO real-time stuff
// -------------------------
//
// rooms are "ride_<id>"
// driver sends location → riders see it

io.on("connection", (socket) => {
  console.log("Client connected", socket.id);

  socket.on("join_ride", (payload: { rideId: number; role?: string }) => {
    try {
      const room = `ride_${payload.rideId}`;
      socket.join(room);
      console.log(`Socket ${socket.id} joined room ${room} as ${payload.role}`);
    } catch (err) {
      console.error("Error in join_ride:", err);
    }
  });

  // Driver sends location updates
  socket.on(
    "driver_location",
    (payload: {
      rideId: number;
      lat: number;
      lng: number;
      heading?: number;
      speedKmh?: number;
    }) => {
      try {
        const room = `ride_${payload.rideId}`;
        io.to(room).emit("location_update", {
          lat: payload.lat,
          lng: payload.lng,
          heading: payload.heading ?? null,
          speedKmh: payload.speedKmh ?? null,
          at: new Date().toISOString(),
        });
      } catch (err) {
        console.error("Error in driver_location:", err);
      }
    }
  );

  socket.on("disconnect", () => {
    console.log("Client disconnected", socket.id);
  });
});

// -------------------------
// Start server
// -------------------------

const PORT = process.env.PORT || 10000;

async function start() {
  try {
    await initDb();
    console.log("✅ Database initialized (tables ensured).");

    server.listen(PORT, () => {
      console.log(`🚀 Server listening on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error("❌ Failed to initialize database", err);
    process.exit(1);
  }
}

start();
