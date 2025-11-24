import { PlanCode, RideStatus, SubscriptionStatus } from "./types";

/**
 * Shared constants (routes, enums, time rules) used across backend + frontend.
 */

// Timezone: all DB timestamps are stored as UTC, but we present times in this TZ.
export const APP_TIMEZONE = "America/Winnipeg";

// Peak window constants – purely declarative for now.
export const PEAK_MORNING_START = "07:00";
export const PEAK_MORNING_END = "10:00";

export const PEAK_EVENING_START = "16:00";
export const PEAK_EVENING_END = "18:00";

// Route helpers (frontend can re-use these when building links)
export const API_ROUTES = {
  LOGIN: "/auth/login",
  REGISTER: "/auth/register",
  ME: "/me",
  RIDES: "/rides",
  DRIVER_RIDES_TODAY: "/driver/rides/today",
  ADMIN_USERS: "/admin/users",
} as const;

// Enum-style collections for UI dropdowns / validations.
export const RIDE_STATUSES: RideStatus[] = [
  "pending",
  "scheduled",
  "driver_en_route",
  "arrived",
  "in_progress",
  "completed",
  "cancelled",
  "cancelled_by_user",
  "cancelled_by_admin",
  "cancelled_by_driver",
];

export const SUBSCRIPTION_STATUSES: SubscriptionStatus[] = [
  "pending",
  "active",
  "paused",
  "cancelled",
];

export const PLAN_CODES: PlanCode[] = ["premium", "standard", "light"];
