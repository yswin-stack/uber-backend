// Shared constants for both backend and frontend.

import type { RideStatus, SubscriptionStatus, PlanCode } from "./types";

export const APP_TIMEZONE = "America/Winnipeg" as const;

// Peak window definition (local time in APP_TIMEZONE).
export const PEAK_MORNING_START = "07:00";
export const PEAK_MORNING_END = "10:00";
export const PEAK_EVENING_START = "16:00";
export const PEAK_EVENING_END = "18:00";

export const ALL_RIDE_STATUSES: readonly RideStatus[] = [
  "pending",
  "requested",
  "scheduled",
  "driver_en_route",
  "arrived",
  "in_progress",
  "completed",
  "cancelled",
  "cancelled_by_user",
  "cancelled_by_admin",
  "cancelled_by_driver",
  "no_show",
] as const;

export const ALL_SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = [
  "pending",
  "active",
  "paused",
  "cancelled",
] as const;

export const ALL_PLAN_CODES: readonly PlanCode[] = [
  "premium",
  "standard",
  "light",
] as const;

// Optional route helpers your frontend can reuse later.
export const API_ROUTES = {
  login: "/auth/login",
  register: "/auth/register",
  me: "/user/me",
  rides: "/rides",
  driverToday: "/driver/rides/today",
  adminUsers: "/admin/users",
} as const;
