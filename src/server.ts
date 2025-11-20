import express from "express";
import http from "http";
import cors from "cors";
import dotenv from "dotenv";
import { Server } from "socket.io";
import { ridesRouter } from "./routes/rides";
import { mockAuth } from "./middlewares/auth";
import { setupTrackingSockets } from "./sockets/tracking";
import { initDb } from "./db/init";
import authRouter from "./routes/auth";
import devRouter from "./routes/dev";



dotenv.config();

const app = express();
app.use(cors({ origin: "*", credentials: false }));
app.use(express.json());
app.use("/auth", authRouter);


// attach mock auth for all API routes
app.use(mockAuth);

app.get("/", (_req, res) => {
  res.json({ ok: true, message: "Backend is running" });
});

app.use("/rides", ridesRouter);

const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

setupTrackingSockets(io);

const PORT = process.env.PORT || 4000;

async function start() {
  try {
    // 🔥 This line creates tables if they don't exist
    await initDb();

    httpServer.listen(PORT, () => {
      console.log(`🚀 Server listening on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error("❌ Failed to initialize database", err);
    process.exit(1);
  }
}

start();
