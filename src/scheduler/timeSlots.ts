/**
 * Time Slots Module
 * 
 * Manages time slot generation and capacity tracking for:
 * - Peak windows (Premium only): 07:00-10:00, 15:00-18:00
 * - Off-peak windows (Premium + Non-Premium): all other hours
 * 
 * Slots are 5-minute arrival windows with capacity limits for
 * both Premium and Non-Premium riders.
 */

import type {
  TimeSlot,
  TimeSlotAvailability,
  Direction,
  SlotType,
} from '../shared/schedulingTypes';
import { DEFAULT_SCHEDULING_CONFIG } from '../shared/schedulingTypes';
import { pool } from '../db/pool';

// =============================================================================
// Constants
// =============================================================================

const SLOT_WINDOW_MINUTES = DEFAULT_SCHEDULING_CONFIG.SLOT_WINDOW_MINUTES; // 5 min
const PEAK_MORNING_START = DEFAULT_SCHEDULING_CONFIG.PEAK_MORNING_START;
const PEAK_MORNING_END = DEFAULT_SCHEDULING_CONFIG.PEAK_MORNING_END;
const PEAK_EVENING_START = DEFAULT_SCHEDULING_CONFIG.PEAK_EVENING_START;
const PEAK_EVENING_END = DEFAULT_SCHEDULING_CONFIG.PEAK_EVENING_END;

// Working hours
const WORKING_DAY_START = '06:00';
const WORKING_DAY_END = '22:00';

// Default capacity per slot
const DEFAULT_MAX_PREMIUM_PER_SLOT = 2;
const DEFAULT_MAX_NON_PREMIUM_PER_SLOT = 2; // Only for off-peak

// =============================================================================
// Time Utilities
// =============================================================================

/**
 * Parse "HH:mm" to minutes since midnight
 */
function timeToMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

/**
 * Convert minutes since midnight to "HH:mm"
 */
function minutesToTime(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
}

/**
 * Check if a time falls within peak hours
 */
export function isInPeakWindow(time: string): boolean {
  const mins = timeToMinutes(time);
  
  // Morning peak: 07:00-10:00
  const morningStart = timeToMinutes(PEAK_MORNING_START);
  const morningEnd = timeToMinutes(PEAK_MORNING_END);
  if (mins >= morningStart && mins < morningEnd) {
    return true;
  }
  
  // Evening peak: 15:00-18:00
  const eveningStart = timeToMinutes(PEAK_EVENING_START);
  const eveningEnd = timeToMinutes(PEAK_EVENING_END);
  if (mins >= eveningStart && mins < eveningEnd) {
    return true;
  }
  
  return false;
}

/**
 * Get slot type for a given time
 */
export function getSlotType(time: string): SlotType {
  return isInPeakWindow(time) ? 'peak' : 'off_peak';
}

// =============================================================================
// Slot ID Generation
// =============================================================================

/**
 * Generate a unique slot ID
 * Format: slot_YYYY-MM-DD_HH:mm_direction
 */
export function generateSlotId(
  date: string,
  arrivalStart: string,
  direction: Direction
): string {
  return `slot_${date}_${arrivalStart}_${direction}`;
}

/**
 * Parse a slot ID back to its components
 */
export function parseSlotId(slotId: string): {
  date: string;
  arrivalStart: string;
  direction: Direction;
} | null {
  const match = slotId.match(/^slot_(\d{4}-\d{2}-\d{2})_(\d{2}:\d{2})_(.+)$/);
  if (!match) return null;
  
  return {
    date: match[1],
    arrivalStart: match[2],
    direction: match[3] as Direction,
  };
}

// =============================================================================
// Slot Generation
// =============================================================================

/**
 * Generate all base time slots for a given date
 * This creates empty slots without DB persistence
 */
export function generateBaseSlotsForDate(
  date: string,
  direction: Direction = 'other'
): TimeSlot[] {
  const slots: TimeSlot[] = [];
  
  const dayStart = timeToMinutes(WORKING_DAY_START);
  const dayEnd = timeToMinutes(WORKING_DAY_END);
  
  for (let mins = dayStart; mins < dayEnd; mins += SLOT_WINDOW_MINUTES) {
    const arrivalStart = minutesToTime(mins);
    const arrivalEnd = minutesToTime(mins + SLOT_WINDOW_MINUTES);
    const slotType = getSlotType(arrivalStart);
    
    const slot: TimeSlot = {
      slotId: generateSlotId(date, arrivalStart, direction),
      date,
      direction,
      slotType,
      arrivalStart,
      arrivalEnd,
      maxRidersPremium: DEFAULT_MAX_PREMIUM_PER_SLOT,
      usedRidersPremium: 0,
      // Non-Premium only allowed in off-peak
      maxRidersNonPremium: slotType === 'off_peak' ? DEFAULT_MAX_NON_PREMIUM_PER_SLOT : 0,
      usedRidersNonPremium: 0,
      fragile: false,
    };
    
    slots.push(slot);
  }
  
  return slots;
}

/**
 * Generate slots for all directions
 */
export function generateAllSlotsForDate(date: string): TimeSlot[] {
  const directions: Direction[] = [
    'home_to_campus',
    'campus_to_home',
    'home_to_work',
    'work_to_home',
    'other',
  ];
  
  return directions.flatMap(dir => generateBaseSlotsForDate(date, dir));
}

// =============================================================================
// Database Operations
// =============================================================================

/**
 * Initialize slots in database for a given date
 * Creates slots if they don't exist
 */
export async function initializeSlotsForDate(date: string): Promise<void> {
  const allSlots = generateAllSlotsForDate(date);
  
  // Use batch insert with ON CONFLICT DO NOTHING
  const values: any[] = [];
  const placeholders: string[] = [];
  let paramIndex = 1;
  
  for (const slot of allSlots) {
    placeholders.push(
      `($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`
    );
    values.push(
      slot.slotId,
      slot.date,
      slot.direction,
      slot.slotType,
      slot.arrivalStart,
      slot.arrivalEnd,
      slot.maxRidersPremium,
      slot.maxRidersNonPremium,
      slot.fragile
    );
  }
  
  if (placeholders.length === 0) return;
  
  const query = `
    INSERT INTO slot_capacity (
      slot_id, date, direction, slot_type, 
      arrival_start, arrival_end, 
      max_riders_premium, max_riders_non_premium, fragile
    )
    VALUES ${placeholders.join(', ')}
    ON CONFLICT (slot_id) DO NOTHING
  `;
  
  await pool.query(query, values);
}

/**
 * Get slots for a specific date from database
 */
export async function getSlotsForDate(
  date: string,
  direction?: Direction
): Promise<TimeSlot[]> {
  // First ensure slots are initialized
  await initializeSlotsForDate(date);
  
  let query = `
    SELECT 
      slot_id,
      date::text,
      direction,
      slot_type,
      arrival_start::text,
      arrival_end::text,
      max_riders_premium,
      used_riders_premium,
      max_riders_non_premium,
      used_riders_non_premium,
      fragile
    FROM slot_capacity
    WHERE date = $1
  `;
  
  const params: any[] = [date];
  
  if (direction) {
    query += ` AND direction = $2`;
    params.push(direction);
  }
  
  query += ` ORDER BY arrival_start ASC`;
  
  const result = await pool.query(query, params);
  
  return result.rows.map(row => ({
    slotId: row.slot_id,
    date: row.date,
    direction: row.direction as Direction,
    slotType: row.slot_type as SlotType,
    arrivalStart: row.arrival_start.slice(0, 5),
    arrivalEnd: row.arrival_end.slice(0, 5),
    maxRidersPremium: row.max_riders_premium,
    usedRidersPremium: row.used_riders_premium,
    maxRidersNonPremium: row.max_riders_non_premium,
    usedRidersNonPremium: row.used_riders_non_premium,
    fragile: row.fragile,
  }));
}

/**
 * Get a single slot by ID
 */
export async function getSlotById(slotId: string): Promise<TimeSlot | null> {
  const result = await pool.query(
    `
    SELECT 
      slot_id,
      date::text,
      direction,
      slot_type,
      arrival_start::text,
      arrival_end::text,
      max_riders_premium,
      used_riders_premium,
      max_riders_non_premium,
      used_riders_non_premium,
      fragile
    FROM slot_capacity
    WHERE slot_id = $1
    `,
    [slotId]
  );
  
  if (result.rowCount === 0) return null;
  
  const row = result.rows[0];
  return {
    slotId: row.slot_id,
    date: row.date,
    direction: row.direction as Direction,
    slotType: row.slot_type as SlotType,
    arrivalStart: row.arrival_start.slice(0, 5),
    arrivalEnd: row.arrival_end.slice(0, 5),
    maxRidersPremium: row.max_riders_premium,
    usedRidersPremium: row.used_riders_premium,
    maxRidersNonPremium: row.max_riders_non_premium,
    usedRidersNonPremium: row.used_riders_non_premium,
    fragile: row.fragile,
  };
}

// =============================================================================
// Capacity Management
// =============================================================================

/**
 * Update slot capacity
 * deltaPremium/deltaNonPremium can be positive (adding) or negative (removing)
 */
export async function updateSlotCapacity(
  slotId: string,
  deltaPremium: number,
  deltaNonPremium: number
): Promise<void> {
  await pool.query(
    `
    UPDATE slot_capacity
    SET 
      used_riders_premium = GREATEST(0, LEAST(max_riders_premium, used_riders_premium + $2)),
      used_riders_non_premium = GREATEST(0, LEAST(max_riders_non_premium, used_riders_non_premium + $3)),
      updated_at = now()
    WHERE slot_id = $1
    `,
    [slotId, deltaPremium, deltaNonPremium]
  );
}

/**
 * Reserve capacity in a slot
 * Returns true if successful, false if no capacity
 */
export async function reserveSlotCapacity(
  slotId: string,
  isPremium: boolean
): Promise<boolean> {
  const column = isPremium ? 'used_riders_premium' : 'used_riders_non_premium';
  const maxColumn = isPremium ? 'max_riders_premium' : 'max_riders_non_premium';
  
  const result = await pool.query(
    `
    UPDATE slot_capacity
    SET ${column} = ${column} + 1, updated_at = now()
    WHERE slot_id = $1 
      AND ${column} < ${maxColumn}
    RETURNING slot_id
    `,
    [slotId]
  );
  
  return (result.rowCount ?? 0) > 0;
}

/**
 * Release capacity in a slot
 */
export async function releaseSlotCapacity(
  slotId: string,
  isPremium: boolean
): Promise<void> {
  const column = isPremium ? 'used_riders_premium' : 'used_riders_non_premium';
  
  await pool.query(
    `
    UPDATE slot_capacity
    SET ${column} = GREATEST(0, ${column} - 1), updated_at = now()
    WHERE slot_id = $1
    `,
    [slotId]
  );
}

/**
 * Set slot fragility flag
 */
export async function setSlotFragility(
  slotId: string,
  fragile: boolean
): Promise<void> {
  await pool.query(
    `
    UPDATE slot_capacity
    SET fragile = $2, updated_at = now()
    WHERE slot_id = $1
    `,
    [slotId, fragile]
  );
}

/**
 * Update max non-premium capacity for a slot
 * Used by capacity planner to adjust based on simulations
 */
export async function updateSlotMaxNonPremium(
  slotId: string,
  maxNonPremium: number
): Promise<void> {
  await pool.query(
    `
    UPDATE slot_capacity
    SET max_riders_non_premium = $2, updated_at = now()
    WHERE slot_id = $1
    `,
    [slotId, Math.max(0, maxNonPremium)]
  );
}

// =============================================================================
// Availability Checking
// =============================================================================

/**
 * Get slots with availability info
 */
export async function getSlotsWithAvailability(
  date: string,
  direction?: Direction
): Promise<TimeSlotAvailability[]> {
  const slots = await getSlotsForDate(date, direction);
  
  return slots.map(slot => ({
    ...slot,
    availablePremium: slot.maxRidersPremium - slot.usedRidersPremium,
    availableNonPremium: slot.maxRidersNonPremium - slot.usedRidersNonPremium,
  }));
}

/**
 * Check if a slot has availability for a plan type
 */
export function hasAvailability(
  slot: TimeSlot,
  isPremium: boolean
): boolean {
  if (isPremium) {
    return slot.usedRidersPremium < slot.maxRidersPremium;
  }
  
  // Non-Premium not allowed in peak windows
  if (slot.slotType === 'peak') {
    return false;
  }
  
  return slot.usedRidersNonPremium < slot.maxRidersNonPremium;
}

/**
 * Get available slots for a plan type within a time range
 */
export async function getAvailableSlotsInRange(
  date: string,
  direction: Direction,
  isPremium: boolean,
  startTime: string,
  endTime: string
): Promise<TimeSlot[]> {
  const slots = await getSlotsForDate(date, direction);
  
  const startMins = timeToMinutes(startTime);
  const endMins = timeToMinutes(endTime);
  
  return slots.filter(slot => {
    const slotMins = timeToMinutes(slot.arrivalStart);
    
    // Check time range
    if (slotMins < startMins || slotMins >= endMins) {
      return false;
    }
    
    // Check availability
    return hasAvailability(slot, isPremium);
  });
}

// =============================================================================
// Bulk Operations
// =============================================================================

/**
 * Reset all slots for a date (for testing/admin)
 */
export async function resetSlotsForDate(date: string): Promise<void> {
  await pool.query(
    `
    UPDATE slot_capacity
    SET 
      used_riders_premium = 0,
      used_riders_non_premium = 0,
      fragile = false,
      updated_at = now()
    WHERE date = $1
    `,
    [date]
  );
}

/**
 * Delete all slots for a date (for cleanup)
 */
export async function deleteSlotsForDate(date: string): Promise<void> {
  await pool.query(
    `DELETE FROM slot_capacity WHERE date = $1`,
    [date]
  );
}

/**
 * Get summary counts for slots on a date
 */
export async function getSlotSummaryForDate(date: string): Promise<{
  totalSlots: number;
  peakSlots: number;
  offPeakSlots: number;
  totalPremiumCapacity: number;
  totalPremiumUsed: number;
  totalNonPremiumCapacity: number;
  totalNonPremiumUsed: number;
}> {
  const result = await pool.query(
    `
    SELECT 
      COUNT(*) as total_slots,
      COUNT(*) FILTER (WHERE slot_type = 'peak') as peak_slots,
      COUNT(*) FILTER (WHERE slot_type = 'off_peak') as off_peak_slots,
      SUM(max_riders_premium) as total_premium_capacity,
      SUM(used_riders_premium) as total_premium_used,
      SUM(max_riders_non_premium) as total_non_premium_capacity,
      SUM(used_riders_non_premium) as total_non_premium_used
    FROM slot_capacity
    WHERE date = $1
    `,
    [date]
  );
  
  const row = result.rows[0];
  return {
    totalSlots: parseInt(row.total_slots, 10),
    peakSlots: parseInt(row.peak_slots, 10),
    offPeakSlots: parseInt(row.off_peak_slots, 10),
    totalPremiumCapacity: parseInt(row.total_premium_capacity || '0', 10),
    totalPremiumUsed: parseInt(row.total_premium_used || '0', 10),
    totalNonPremiumCapacity: parseInt(row.total_non_premium_capacity || '0', 10),
    totalNonPremiumUsed: parseInt(row.total_non_premium_used || '0', 10),
  };
}

