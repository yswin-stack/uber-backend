// src/services/loadBalancer.ts

import { pool } from "../db/pool";
import { getAiConfig } from "./aiConfig";
import { estimateTravelMinutesKm } from "./predictiveEngine";
import { computeDistanceKm } from "../utils/distance";

type RideRow = {
  id: number;
  user_id: number;
  pickup_time: string;
  pickup_lat: number | null;
  pickup_lng: number | null;
  drop_lat: number | null;
  drop_lng: number | null;
  pickup_window_start?: string | null;
  pickup_window_end?: string | null;
  arrival_window_start?: string | null;
  arrival_window_end?: string | null;
  status?: string;
};

export type DailyLoadInsight = {
  id: number;
  day: string;
  generated_at: string;
  total_rides: number;
  recommended_start_time: string | null;
  overbooked_slots: any;
  at_risk_rides: any;
};

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

/**
 * Nightly predictive load balancer.
 *
 * - Computes expected travel times for all rides on a given day
 * - Flags overbooked hours (more than max_rides_per_hour)
 * - Flags back-to-back rides with not enough slack between them
 * - Stores a compact summary in daily_load_insights for admin / driver UIs
 */
export async function runPredictiveLoadBalancer(
  target: Date
): Promise<DailyLoadInsight> {
  const client = await pool.connect();

  try {
    // Ensure insights table exists (no separate migration required)
    await client.query(`
      CREATE TABLE IF NOT EXISTS daily_load_insights (
        id SERIAL PRIMARY KEY,
        day DATE NOT NULL,
        generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        total_rides INTEGER NOT NULL,
        recommended_start_time TIMESTAMPTZ,
        overbooked_slots JSONB,
        at_risk_rides JSONB
      )
    `);

    const cfg = getAiConfig();

    const dayUtc = new Date(
      Date.UTC(
        target.getUTCFullYear(),
        target.getUTCMonth(),
        target.getUTCDate(),
        0,
        0,
        0,
        0
      )
    );
    const dayStart = new Date(dayUtc);
    const dayEnd = new Date(dayUtc);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

    const dayStr = toIsoDate(dayUtc);

    // Load all active rides for that day (single-driver world for now)
    const ridesRes = await client.query<RideRow>(
      `
      SELECT
        id,
        user_id,
        pickup_time,
        pickup_lat,
        pickup_lng,
        drop_lat,
        drop_lng,
        pickup_window_start,
        pickup_window_end,
        arrival_window_start,
        arrival_window_end,
        status
      FROM rides
      WHERE pickup_time >= $1
        AND pickup_time < $2
        AND status NOT IN ('cancelled','cancelled_by_user','cancelled_by_admin','no_show')
      ORDER BY pickup_time ASC
      `,
      [dayStart.toISOString(), dayEnd.toISOString()]
    );

    const rides = ridesRes.rows;

    // If there are no rides, just store an empty snapshot
    if (rides.length === 0) {
      await client.query(`DELETE FROM daily_load_insights WHERE day = $1`, [
        dayStr,
      ]);

      const insertRes = await client.query<DailyLoadInsight>(
        `
        INSERT INTO daily_load_insights (
          day,
          total_rides,
          recommended_start_time,
          overbooked_slots,
          at_risk_rides
        )
        VALUES ($1, 0, NULL, '[]'::jsonb, '[]'::jsonb)
        RETURNING *
        `,
        [dayStr]
      );

      return insertRes.rows[0];
    }

    // 1) Overbooked slots (by hour)
    type SlotSummary = {
      hour_start: string;
      rides_count: number;
      max_rides_per_hour: number;
    };

    const slots: Record<string, SlotSummary> = {};

    rides.forEach((r) => {
      const t = new Date(r.pickup_time);
      const hourStart = new Date(t);
      hourStart.setUTCMinutes(0, 0, 0);
      const key = hourStart.toISOString();

      if (!slots[key]) {
        slots[key] = {
          hour_start: key,
          rides_count: 0,
          max_rides_per_hour: cfg.max_rides_per_hour,
        };
      }
      slots[key].rides_count += 1;
    });

    const overbookedSlots = Object.values(slots).filter(
      (s) => s.rides_count > cfg.max_rides_per_hour
    );

    // 2) Back-to-back risk analysis
    type RiskRow = {
      ride_id: number;
      next_ride_id: number;
      slack_minutes: number;
      reason: string;
    };

    const atRiskRides: RiskRow[] = [];

    for (let i = 0; i < rides.length - 1; i++) {
      const current = rides[i];
      const next = rides[i + 1];

      const currentPickup = new Date(current.pickup_time);
      const nextPickup = new Date(next.pickup_time);

      // Passenger leg (pickup → dropoff)
      let passengerMinutes = 8; // fallback
      if (
        current.pickup_lat != null &&
        current.pickup_lng != null &&
        current.drop_lat != null &&
        current.drop_lng != null
      ) {
        const legKm = computeDistanceKm(
          Number(current.pickup_lat),
          Number(current.pickup_lng),
          Number(current.drop_lat),
          Number(current.drop_lng)
        );
        const est = estimateTravelMinutesKm(legKm, { when: currentPickup });
        passengerMinutes = est.travel_minutes;
      }

      // Reposition leg (from current dropoff to next pickup)
      let repositionMinutes = 0;
      if (
        current.drop_lat != null &&
        current.drop_lng != null &&
        next.pickup_lat != null &&
        next.pickup_lng != null
      ) {
        const repositionKm = computeDistanceKm(
          Number(current.drop_lat),
          Number(current.drop_lng),
          Number(next.pickup_lat),
          Number(next.pickup_lng)
        );
        const estRe = estimateTravelMinutesKm(repositionKm, {
          when: nextPickup,
        });
        repositionMinutes = estRe.travel_minutes;
      }

      const earliestFree = addMinutes(
        currentPickup,
        passengerMinutes + repositionMinutes
      );
      const slackMinutes =
        (nextPickup.getTime() - earliestFree.getTime()) / 60_000;

      // If slack is small or negative, mark as at-risk
      if (slackMinutes < cfg.arrive_early_minutes) {
        atRiskRides.push({
          ride_id: current.id,
          next_ride_id: next.id,
          slack_minutes: Math.round(slackMinutes),
          reason:
            slackMinutes < 0
              ? "negative_slack"
              : "tight_back_to_back_window",
        });
      }
    }

    // 3) Recommended start time
    const firstPickup = new Date(rides[0].pickup_time);
    let startOffset = 0;

    const worstSlack = atRiskRides.reduce(
      (min, r) => Math.min(min, r.slack_minutes),
      Infinity
    );

    if (worstSlack === Infinity) {
      // Everything is comfortable → no earlier start needed
      startOffset = 0;
    } else if (worstSlack < 0) {
      // There is at least one impossible chain → start 15 min earlier
      startOffset = 15;
    } else if (worstSlack < cfg.arrive_early_minutes) {
      // Tight but not impossible → start 10 min earlier
      startOffset = 10;
    }

    const recommendedStartTime =
      startOffset > 0 ? addMinutes(firstPickup, -startOffset) : firstPickup;

    // 4) Upsert into daily_load_insights
    await client.query(`DELETE FROM daily_load_insights WHERE day = $1`, [
      dayStr,
    ]);

    const insertRes = await client.query<DailyLoadInsight>(
      `
      INSERT INTO daily_load_insights (
        day,
        total_rides,
        recommended_start_time,
        overbooked_slots,
        at_risk_rides
      )
      VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
      RETURNING *
      `,
      [
        dayStr,
        rides.length,
        recommendedStartTime.toISOString(),
        JSON.stringify(overbookedSlots),
        JSON.stringify(atRiskRides),
      ]
    );

    return insertRes.rows[0];
  } finally {
    client.release();
  }
}
