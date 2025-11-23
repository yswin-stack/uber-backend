// src/services/predictiveEngine.ts

import { AiConfig, getAiConfig } from "./aiConfig";

export type TravelEstimateContext = {
  when: Date;
  isSnow?: boolean;
};

export type TravelEstimateResult = {
  travel_minutes: number;
  eta_multiplier: number;
  config: AiConfig;
  reasons: string[];
};

function isWinterSeason(date: Date): boolean {
  const m = date.getMonth(); // 0=Jan
  // Very simple: Dec, Jan, Feb treated as winter
  return m === 11 || m === 0 || m === 1;
}

function isRushHour(date: Date): boolean {
  const h = date.getHours();
  // Rough Winnipeg-style commute peaks
  return (h >= 7 && h <= 9) || (h >= 15 && h <= 18);
}

/**
 * Core predictive delay engine:
 * - takes distance in km
 * - uses AI config + time-of-day + season to adjust ETA
 */
export function estimateTravelMinutesKm(
  distanceKm: number,
  context: TravelEstimateContext
): TravelEstimateResult {
  const cfg = getAiConfig();
  const reasons: string[] = [];

  let etaMultiplier = 1;
  let speedKmh = cfg.travel_speed_kmh;

  // Snow mode can be forced via env, or inferred from season, or context
  const modeEnv = process.env.AI_MODE;
  const forcedSnow = modeEnv === "snow";
  const isSnowNow =
    Boolean(context.isSnow) || forcedSnow || isWinterSeason(context.when);

  if (isSnowNow) {
    if (cfg.winter_speed_kmh > 0) {
      speedKmh = cfg.winter_speed_kmh;
    } else {
      etaMultiplier *= 1 + cfg.snow_penalty_percent / 100;
    }
    reasons.push("snow");
  }

  // Rush hour adds a small slowdown
  if (isRushHour(context.when)) {
    etaMultiplier *= 1.15;
    reasons.push("rush_hour");
  }

  // Safety minimums
  const effectiveSpeed = Math.max(5, speedKmh);
  const baseMinutes = (distanceKm / effectiveSpeed) * 60 * etaMultiplier;

  const travelMinutes = Math.max(6, Math.ceil(baseMinutes)); // never < 6 min

  return {
    travel_minutes: travelMinutes,
    eta_multiplier: etaMultiplier,
    config: cfg,
    reasons,
  };
}
