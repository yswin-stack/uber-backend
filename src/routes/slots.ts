import { Router, Request, Response } from "express";
import { pool } from "../db/pool";

const slotsRouter = Router();

// How many rides you can realistically do in 15 minutes
const MAX_RIDES_PER_SLOT = 3;

// Slot size in minutes
const SLOT_MINUTES = 15;

// Statuses that count against capacity
const ACTIVE_STATUSES = [
  "pending",
  "confirmed",
  "driver_en_route",
  "arrived",
  "in_progress",
] as const;

/**
 * Given an ISO datetime string, compute the start/end Date of its slot.
 * Returns null if invalid date.
 */
function computeSlotBounds(iso: string): { start: Date; end: Date } | null {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;

  const rounded = new Date(d);
  const minutes = rounded.getMinutes();
  const remainder = minutes % SLOT_MINUTES;
  rounded.setMinutes(minutes - remainder, 0, 0); // round down to slot start

  const start = rounded;
  const end = new Date(rounded.getTime() + SLOT_MINUTES * 60 * 1000);

  return { start, end };
}

// Convert Date → "HH:MM" label in local time
function formatTimeLabel(d: Date): string {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * GET /slots/check?pickupTime=<ISO>
 *
 * Example:
 *   /slots/check?pickupTime=2025-11-22T08:15:00-06:00
 *
 * Response:
 * {
 *   ok: true,
 *   slot: { start, end, count, max },
 *   isFull: boolean,
 *   suggestions: [
 *     { start, end, count, max, label }
 *   ]
 * }
 */
slotsRouter.get("/check", async (req: Request, res: Response) => {
  try {
    const pickupTime = String(req.query.pickupTime || "").trim();
    if (!pickupTime) {
      return res
        .status(400)
        .json({ error: "pickupTime query parameter is required (ISO string)." });
    }

    const bounds = computeSlotBounds(pickupTime);
    if (!bounds) {
      return res
        .status(400)
        .json({ error: "Invalid pickupTime, could not parse date." });
    }

    const { start, end } = bounds;

    // Count rides in this slot
    const baseCountResult = await pool.query(
      `
      SELECT COUNT(*)::int AS count
      FROM rides
      WHERE pickup_time >= $1
        AND pickup_time < $2
        AND status = ANY($3)
    `,
      [start, end, ACTIVE_STATUSES]
    );

    const baseCount: number = baseCountResult.rows[0]?.count ?? 0;
    const isFull = baseCount >= MAX_RIDES_PER_SLOT;

    // Build suggestions by checking the next few slots (e.g. next 4)
    const suggestions: {
      start: string;
      end: string;
      count: number;
      max: number;
      label: string;
    }[] = [];

    let cursorStart = new Date(start);
    for (let i = 0; i < 4; i++) {
      cursorStart = new Date(cursorStart.getTime() + SLOT_MINUTES * 60 * 1000);
      const cursorEnd = new Date(
        cursorStart.getTime() + SLOT_MINUTES * 60 * 1000
      );

      const result = await pool.query(
        `
        SELECT COUNT(*)::int AS count
        FROM rides
        WHERE pickup_time >= $1
          AND pickup_time < $2
          AND status = ANY($3)
      `,
        [cursorStart, cursorEnd, ACTIVE_STATUSES]
      );

      const count = result.rows[0]?.count ?? 0;
      if (count < MAX_RIDES_PER_SLOT) {
        suggestions.push({
          start: cursorStart.toISOString(),
          end: cursorEnd.toISOString(),
          count,
          max: MAX_RIDES_PER_SLOT,
          label: formatTimeLabel(cursorStart),
        });
      }

      // Only need the first 3 available suggestions
      if (suggestions.length >= 3) break;
    }

    return res.json({
      ok: true,
      slot: {
        start: start.toISOString(),
        end: end.toISOString(),
        count: baseCount,
        max: MAX_RIDES_PER_SLOT,
      },
      isFull,
      suggestions,
    });
  } catch (err) {
    console.error("Error in GET /slots/check:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

export default slotsRouter;
