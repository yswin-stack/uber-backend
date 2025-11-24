// Time helpers used across the backend (and safe for frontend reuse via build tooling).
// Convention: all timestamps persisted in the database are UTC ISO strings.

import { APP_TIMEZONE } from "../shared/constants";

/**
 * Convert a Date to a UTC ISO-8601 string (e.g. 2025-01-02T15:04:05.000Z).
 */
export function toUtcIso(date: Date): string {
  return date.toISOString();
}

/**
 * Parse a UTC ISO-8601 string into a Date.
 * NOTE: Date objects are always stored internally as UTC.
 */
export function parseUtc(dateString: string): Date {
  return new Date(dateString);
}

/**
 * Given a Date that represents local time in APP_TIMEZONE,
 * return the corresponding UTC ISO string for persistence.
 *
 * For now we assume the incoming Date already encodes the correct
 * local clock time and just store it as an instant in UTC.
 */
export function localToUtc(date: Date): string {
  return date.toISOString();
}

/**
 * Convert a UTC Date or ISO string into a JS Date.
 * Rendering in APP_TIMEZONE should be handled by the caller
 * (typically the frontend using Intl.DateTimeFormat with
 * timeZone: APP_TIMEZONE).
 */
export function utcToLocal(value: Date | string): Date {
  if (value instanceof Date) return value;
  return new Date(value);
}

/**
 * Utility to format a Date into "HH:MM" in APP_TIMEZONE.
 * This is mainly useful for debugging or logs.
 */
export function formatTimeLocal(date: Date): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: APP_TIMEZONE,
  });

  const parts = fmt.formatToParts(date);
  const hour = parts.find((p) => p.type === "hour")?.value ?? "00";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  return `${hour}:${minute}`;
}
