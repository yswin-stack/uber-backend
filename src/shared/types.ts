// Shared domain & API types used by both backend and frontend.
// Keep this file free of any Node / Express imports so it can be reused.

export type UserRole = "rider" | "driver" | "admin";

// Ride lifecycle statuses used across the app.
// NOTE: Some legacy rows may still use "pending" or "requested" –
// keep them in the union for compatibility.
export type RideStatus =
  | "pending"
  | "requested"
  | "scheduled"
  | "driver_en_route"
  | "arrived"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "cancelled_by_user"
  | "cancelled_by_admin"
  | "cancelled_by_driver"
  | "no_show";

export type SubscriptionStatus = "pending" | "active" | "paused" | "cancelled";

// Logical plan codes. Backed by subscription_plans in V2.
export type PlanCode = "premium" | "standard" | "light";

export interface Ride {
  id: number;
  user_id: number;
  driver_id: number | null;
  pickup_location: string;
  dropoff_location: string;
  pickup_lat: number | null;
  pickup_lng: number | null;
  drop_lat: number | null;
  drop_lng: number | null;
  pickup_time: string; // UTC ISO string
  pickup_window_start: string | null; // UTC ISO
  pickup_window_end: string | null; // UTC ISO
  arrival_window_start: string | null; // UTC ISO
  arrival_window_end: string | null; // UTC ISO
  arrival_target_time: string | null; // UTC ISO
  ride_type: "standard" | "grocery";
  status: RideStatus;
  notes: string | null;
  created_at: string; // UTC ISO
}

export interface RideWithDetails extends Ride {
  user_name?: string | null;
  user_phone?: string | null;
  plan_code?: PlanCode | null;
}

export interface Subscription {
  id: number;
  user_id: number;
  plan_code: PlanCode;
  status: SubscriptionStatus;
  period_start: string; // ISO date (YYYY-MM-DD) in UTC
  period_end: string; // ISO date (YYYY-MM-DD) in UTC
  created_at: string; // UTC ISO
}

export interface CreditsSummary {
  standard_total: number;
  standard_used: number;
  grocery_total: number;
  grocery_used: number;
  period_start: string; // ISO date
  period_end: string; // ISO date
}

export type CommuteDirection = "to_work" | "to_home";

export interface ScheduleTemplate {
  id: number;
  user_id: number;
  day_of_week: number; // 0–6 (0 = Sunday)
  direction: CommuteDirection;
  arrival_time: string; // "HH:MM" in local time
}

// Standard API envelopes used across the app.
export type ApiError = {
  ok: false;
  code: string;
  message: string;
  // Legacy field so old frontend code that reads `error` still works.
  error?: string;
};

export type ApiSuccess<T> = {
  ok: true;
  data: T;
};

export type ApiResponse<T> = ApiSuccess<T> | ApiError;
