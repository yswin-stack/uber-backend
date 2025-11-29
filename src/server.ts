// src/server.ts
import express from "express";
import cors from "cors";
import http from "http";
import { Server } from "socket.io";
import dotenv from "dotenv";

import authRouter from "./routes/auth";
import ridesRouter from "./routes/rides";
import scheduleRouter from "./routes/schedule";
import { adminRouter } from "./routes/admin";
import { creditsRouter } from "./routes/credits";
import devRouter from "./routes/dev";
import slotsRouter from "./routes/slots";
import userRouter from "./routes/user";
import driverRouter from "./routes/driver";
import { meRouter } from "./routes/me";
import { plansRouter } from "./routes/plans";
import { availabilityRouter } from "./routes/availability";
import { holdsRouter } from "./routes/holds";
import { capacityRouter } from "./routes/capacity";
import { initDb } from "./db/init";
import { setupTrackingSockets } from "./sockets/tracking";
import { notFoundHandler, errorHandler } from "./middleware/errorHandler";

dotenv.config();

const app = express();

const corsOrigin =
  process.env.CORS_ORIGIN && process.env.CORS_ORIGIN !== ""
    ? process.env.CORS_ORIGIN
    : "*";

app.use(
  cors({
    origin: corsOrigin,
    credentials: true,
  })
);

app.use(express.json());

// Simple healthcheck
app.get("/", (_req, res) => {
  res.json({ ok: true, message: "Backend is alive" });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, status: "healthy" });
});

// REST routes
app.use("/auth", authRouter);
app.use("/rides", ridesRouter);
app.use("/schedule", scheduleRouter);
app.use("/admin", adminRouter);
app.use("/credits", creditsRouter);
app.use("/dev", devRouter);
app.use("/slots", slotsRouter);
app.use("/user", userRouter);
app.use("/driver", driverRouter);
app.use("/me", meRouter);
app.use("/plans", plansRouter);
app.use("/availability", availabilityRouter);
app.use("/holds", holdsRouter);
app.use("/admin/capacity", capacityRouter);

// 404 + error handlers (must be after all routes)
app.use(notFoundHandler);
app.use(errorHandler);

// HTTP + Socket.IO server
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: corsOrigin,
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// Setup ride-tracking sockets (location + ETA)
setupTrackingSockets(io);

const PORT = process.env.PORT || 4000;

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
