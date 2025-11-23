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
import { initDb } from "./db/init";
import { setupTrackingSockets } from "./sockets/tracking";

dotenv.config();

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  },
});

setupTrackingSockets(io);

app.use(
  cors({
    origin: "*",
  })
);

app.use(express.json());

// --- Health check ---
app.get("/", (_req, res) => {
  res.json({ ok: true, message: "Backend is running" });
});

// --- Routers mounted here ---
//  - /auth/...
//  - /rides/...
//  - /schedule/...
//  - /admin/...
//  - /credits/...
//  - /dev/...
//  - /slots/...
//  - /user/...
//  - /driver/...
app.use("/auth", authRouter);
app.use("/rides", ridesRouter);
app.use("/schedule", scheduleRouter);
app.use("/admin", adminRouter);
app.use("/credits", creditsRouter);
app.use("/dev", devRouter);
app.use("/slots", slotsRouter);
app.use("/user", userRouter);
app.use("/driver", driverRouter);

const PORT = process.env.PORT || 10000;

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
