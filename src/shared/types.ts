/**
 * Shared TypeScript types that can be imported by both backend and frontend.
 * Step 1/10 – foundation only, we can extend these as V2 grows.
 */

export type UserRole = "subscriber" | "rider" | "driver" | "admin";

export type RideStatus =
  | "pending"
  | "scheduled"
  | "driver_en_route"
  | "arrived"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "cancelled_by_user"
  | "cancelled_by_admin"
  | "cancelled_by_driver";

export type SubscriptionStatus = "pending" | "active" | "paused" | "cancelled";

export type PlanCode = "premium" | "standard" | "light";

/**
 * Core ride record as stored in the database.
 * We keep this intentionally loose for now and tighten it over time.
 */
export interface Ride {
  id: number;
  user_id: number;
  pickup_location: string;
  dropoff_location: string;
  pickup_time: string | null; // ISO string in UTC
  dropoff_time?: string | null; // ISO string in UTC
  status: RideStatus;
  ride_type?: string | null;
  driver_id?: number | null;
  is_fixed?: boolean;
  created_at: string; // ISO string in UTC
  [key: string]: any;
}

/**
 * Ride with a few joined user / driver fields for richer UIs.
 * Exact shape can evolve; frontend should treat the extra fields as optional.
 */
export interface RideWithDetails extends Ride {
  rider_name?: string | null;
  rider_phone?: string | null;
  driver_name?: string | null;
}

/**
 * Mirrors the existing CreditsSummary type in lib/credits.ts.
 */
export interface CreditsSummary {
  standard_total: number;
  standard_used: number;
  grocery_total: number;
  grocery_used: number;
}

export interface Subscription {
  id: number;
  user_id: number;
  plan_code: PlanCode;
  status: SubscriptionStatus;
  start_date: string; // ISO date string (UTC)
  end_date: string; // ISO date string (UTC)
}

/**
 * Weekly schedule template describing a user's routine.
 */
export type ScheduleKind = "to_work" | "from_work";

export interface ScheduleTemplate {
  id: number;
  user_id: number;
  day_of_week: number; // 0 (Sunday) – 6 (Saturday)
  kind: ScheduleKind;
  desired_arrival_time: string; // "HH:MM" in local time
  flex_minutes?: number | null;
  enabled: boolean;
}

/**
 * Standard API response shapes.
 */
export type ApiError = {
  ok: false;
  code: string;
  message: string;
};

export type ApiSuccess<T> = {
  ok: true;
  data: T;
};

export type ApiResponse<T> = ApiError | ApiSuccess<T>;
