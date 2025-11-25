// src/services/aiConfig.ts

export type AiConfig = {
  // Base travel assumptions
  travel_speed_kmh: number;        // normal city driving
  winter_speed_kmh: number;        // slower in snow
  snow_penalty_percent: number;    // extra % on ETA if winter speed not used

  // Window sizes (in minutes, full width)
  pickup_window_size: number;      // e.g. 10 = ±5 min
  arrival_window_size: number;     // e.g. 10 = ±5 min

  // Capacity & safety rules
  max_rides_per_hour: number;      // e.g. 4
  overlap_buffer_minutes: number;  // e.g. 30

  // How early we try to arrive
  arrive_early_minutes: number;    // e.g. 5–8 min early

  // Cancellation / refund rules
  cancel_refund_cutoff_minutes: number; // min before pickup to refund credit
};


function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Central AI configuration.
 * Later we can move this to a DB table and keep the shape the same.
 */
export function getAiConfig(): AiConfig {
  return {
    travel_speed_kmh: numEnv("AI_TRAVEL_SPEED_KMH", 25),
    winter_speed_kmh: numEnv("AI_WINTER_SPEED_KMH", 14),
    snow_penalty_percent: numEnv("AI_SNOW_PENALTY_PERCENT", 18),

    pickup_window_size: numEnv("AI_PICKUP_WINDOW_MIN", 10),
    arrival_window_size: numEnv("AI_ARRIVAL_WINDOW_MIN", 10),

    max_rides_per_hour: numEnv("AI_MAX_RIDES_PER_HOUR", 4),
    overlap_buffer_minutes: numEnv("AI_OVERLAP_BUFFER_MIN", 30),

    arrive_early_minutes: numEnv("AI_ARRIVE_EARLY_MIN", 5),
    cancel_refund_cutoff_minutes: numEnv("AI_CANCEL_REFUND_CUTOFF_MIN", 30),
  };
}

