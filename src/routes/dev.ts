import express from "express";
import { pool } from "../db/pool";
import { generateRidesForDate } from "../services/scheduler";

const devRouter = express.Router();

// Simple health check for dev routes
devRouter.get("/ping", (_req, res) => {
  res.json({ ok: true, message: "dev routes alive" });
});

/**
 * Seed a test user quickly (for local/dev)
 * You can call: POST /dev/seed-user with JSON { phone, pin, name?, email? }
 */
devRouter.post("/seed-user", async (req, res) => {
  const { phone, pin, name, email } = req.body || {};

  if (!phone || !pin) {
    return res.status(400).json({
      error: "phone and pin are required",
    });
  }

  try {
    const result = await pool.query(
      `
      INSERT INTO users (phone, pin, name, email, role)
      VALUES ($1, $2, $3, $4, 'subscriber')
      RETURNING id, phone, name, email, role
    `,
      [phone, pin, name || null, email || null]
    );

    res.json({ ok: true, user: result.rows[0] });
  } catch (err) {
    console.error("Error creating user:", err);
    res.status(500).json({ error: "Internal server error creating user" });
  }
});

/**
 * Manual scheduler trigger.
 *
 * Call:
 *   POST /dev/run-scheduler
 * With optional JSON:
 *   { "targetDate": "2025-11-22" }
 *
 * If targetDate omitted, uses "tomorrow" in UTC by default.
 */
devRouter.post("/run-scheduler", async (req, res) => {
  try {
    let target: Date;

    if (req.body?.targetDate) {
      // If caller provides YYYY-MM-DD, use that
      const parsed = new Date(req.body.targetDate);
      if (isNaN(parsed.getTime())) {
        return res.status(400).json({ error: "Invalid targetDate" });
      }
      target = parsed;
    } else {
      // Default: "tomorrow", to generate next day’s rides
      const now = new Date();
      target = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
      );
    }

    const { createdCount, skippedExisting, skippedFullSlots } =
      await generateRidesForDate(target);

    res.json({
      ok: true,
      targetDate: target.toISOString().slice(0, 10),
      createdCount,
      skippedExisting,
      skippedFullSlots,
    });
  } catch (err) {
    console.error("Error running scheduler:", err);
    res.status(500).json({ error: "Internal server error running scheduler" });
  }
});

export default devRouter;
