// src/lib/peak.ts

import {
  PEAK_MORNING_START,
  PEAK_MORNING_END,
  PEAK_EVENING_START,
  PEAK_EVENING_END,
} from "../shared/constants";

/**
 * Parse a "HH:MM" 24h string into hour/minute.
 */
function parseHm(hm: string): { hour: number; minute: number } | null {
  if (!hm) return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(hm.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/**
 * Return a "HH:MM" local time for a given Date.
 * We treat the server's local timezone as the app timezone (America/Winnipeg).
 */
export function toLocalHm(date: Date): string {
  const h = date.getHours();
  const m = date.getMinutes();
  const hh = h.toString().padStart(2, "0");
  const mm = m.toString().padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * Compare two "HH:MM" values (24h). Returns:
 *  - negative if a < b
 *  - 0 if equal
 *  - positive if a > b
 */
function compareHm(a: string, b: string): number {
  const pa = parseHm(a);
  const pb = parseHm(b);
  if (!pa || !pb) return 0;
  const va = pa.hour * 60 + pa.minute;
  const vb = pb.hour * 60 + pb.minute;
  return va - vb;
}

/**
 * Check if a given local time string ("HH:MM") is inside a window [start, end).
 */
function isBetweenInclusiveStartExclusiveEnd(
  timeHm: string,
  startHm: string,
  endHm: string
): boolean {
  return compareHm(timeHm, startHm) >= 0 && compareHm(timeHm, endHm) < 0;
}

/**
 * Check if a given local time ("HH:MM") is inside peak windows.
 */
export function isLocalTimeInPeakWindow(hm: string): boolean {
  if (!hm) return false;

  if (
    isBetweenInclusiveStartExclusiveEnd(hm, PEAK_MORNING_START, PEAK_MORNING_END)
  ) {
    return true;
  }

  if (
    isBetweenInclusiveStartExclusiveEnd(hm, PEAK_EVENING_START, PEAK_EVENING_END)
  ) {
    return true;
  }

  return false;
}

/**
 * Given a Date (pickup/arrival), check if it falls inside peak windows
 * based on local server time (assumed America/Winnipeg).
 */
export function isInPeakWindow(date: Date): boolean {
  const hm = toLocalHm(date);
  return isLocalTimeInPeakWindow(hm);
}
