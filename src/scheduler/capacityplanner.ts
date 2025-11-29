/**
 * Capacity Planner
 * 
 * Computes safe capacity for Premium and Non-Premium riders:
 * - Premium: Fixed at 20 subscribers max (can book any time)
 * - Non-Premium: Dynamic, computed based on:
 *   - Current Premium commitments
 *   - Travel time distributions
 *   - Reliability targets
 * 
 * The planner ensures we never accept rides that could make
 * any rider late, prioritizing Premium reliability.
 */

import type {
  DailyCapacitySummary,
  TimeSlot,
  HourlyCapacityBreakdown,
  SlotType,
} from '../shared/schedulingTypes';
import { DEFAULT_SCHEDULING_CONFIG } from '../shared/schedulingTypes';
import { pool } from '../db/pool';
import {
  getSlotsForDate,
  initializeSlotsForDate,
  getSlotSummaryForDate,
  updateSlotMaxNonPremium,
  isInPeakWindow,
} from './timeSlots';

// =============================================================================
// Constants
// =============================================================================

const MAX_PREMIUM_SUBSCRIBERS = DEFAULT_SCHEDULING_CONFIG.MAX_PREMIUM_SUBSCRIBERS;
const MAX_RIDES_PER_HOUR = DEFAULT_SCHEDULING_CONFIG.MAX_RIDES_PER_HOUR;
const MAX_RIDES_PER_DAY = DEFAULT_SCHEDULING_CONFIG.MAX_RIDES_PER_DAY;

// Base non-premium capacity per off-peak slot
const BASE_NON_PREMIUM_PER_SLOT = 2;

// Reduction factors based on premium load
const PREMIUM_LOAD_REDUCTION_THRESHOLDS = [
  { threshold: 0.8, reduction: 0.5 },   // 80%+ premium load → 50% reduction
  { threshold: 0.6, reduction: 0.25 },  // 60%+ premium load → 25% reduction
  { threshold: 0.4, reduction: 0.1 },   // 40%+ premium load → 10% reduction
];

// =============================================================================
// Premium Subscriber Management
// =============================================================================

/**
 * Get current premium subscriber count
 */
export async function getPremiumSubscriberCount(): Promise<number> {
  const result = await pool.query(`
    SELECT current_count FROM premium_subscriber_count LIMIT 1
  `);
  
  return result.rows[0]?.current_count ?? 0;
}

/**
 * Check if premium subscription is available
 */
export async function canAddPremiumSubscriber(): Promise<boolean> {
  const count = await getPremiumSubscriberCount();
  return count < MAX_PREMIUM_SUBSCRIBERS;
}

/**
 * Increment premium subscriber count (when new premium sub is created)
 */
export async function incrementPremiumCount(): Promise<boolean> {
  const result = await pool.query(`
    UPDATE premium_subscriber_count
    SET current_count = current_count + 1, updated_at = now()
    WHERE current_count < max_count
    RETURNING current_count
  `);
  
  return (result.rowCount ?? 0) > 0;
}

/**
 * Decrement premium subscriber count (when premium sub is cancelled)
 */
export async function decrementPremiumCount(): Promise<void> {
  await pool.query(`
    UPDATE premium_subscriber_count
    SET current_count = GREATEST(0, current_count - 1), updated_at = now()
  `);
}

// =============================================================================
// Daily Capacity Computation
// =============================================================================

/**
 * Get booked counts for a date
 */
async function getBookedCountsForDate(date: string): Promise<{
  premiumBooked: number;
  nonPremiumBooked: number;
}> {
  const result = await pool.query(
    `
    SELECT 
      COUNT(*) FILTER (WHERE plan_type = 'premium') as premium_booked,
      COUNT(*) FILTER (WHERE plan_type IN ('standard', 'off_peak')) as non_premium_booked
    FROM rides
    WHERE 
      DATE(pickup_time) = $1
      AND status NOT IN ('cancelled', 'cancelled_by_user', 'cancelled_by_admin', 'cancelled_by_driver', 'no_show')
    `,
    [date]
  );
  
  return {
    premiumBooked: parseInt(result.rows[0]?.premium_booked || '0', 10),
    nonPremiumBooked: parseInt(result.rows[0]?.non_premium_booked || '0', 10),
  };
}

/**
 * Compute non-premium capacity based on premium load
 * 
 * This is a heuristic-based approach:
 * - Start with base capacity per slot
 * - Reduce based on current premium bookings
 * - Further reduce if approaching daily limits
 */
function computeNonPremiumCapacity(
  premiumBooked: number,
  totalPremiumSlots: number,
  offPeakSlotCount: number
): number {
  // Calculate premium load factor (0-1)
  const premiumLoad = totalPremiumSlots > 0 
    ? premiumBooked / totalPremiumSlots 
    : 0;
  
  // Apply reduction based on premium load
  let reductionFactor = 0;
  for (const { threshold, reduction } of PREMIUM_LOAD_REDUCTION_THRESHOLDS) {
    if (premiumLoad >= threshold) {
      reductionFactor = reduction;
      break;
    }
  }
  
  // Base capacity = slots * base per slot
  const baseCapacity = offPeakSlotCount * BASE_NON_PREMIUM_PER_SLOT;
  
  // Apply reduction
  const adjustedCapacity = Math.floor(baseCapacity * (1 - reductionFactor));
  
  // Cap at daily limit minus premium
  const dailyRemaining = MAX_RIDES_PER_DAY - premiumBooked;
  
  return Math.min(adjustedCapacity, dailyRemaining);
}

/**
 * Compute full daily capacity summary
 */
export async function computeDailyCapacity(date: string): Promise<DailyCapacitySummary> {
  // Ensure slots are initialized
  await initializeSlotsForDate(date);
  
  // Get slot summary
  const slotSummary = await getSlotSummaryForDate(date);
  
  // Get booked counts
  const { premiumBooked, nonPremiumBooked } = await getBookedCountsForDate(date);
  
  // Compute non-premium capacity
  const nonPremiumCapacity = computeNonPremiumCapacity(
    premiumBooked,
    slotSummary.totalPremiumCapacity,
    slotSummary.offPeakSlots
  );
  
  // Get all slots
  const slots = await getSlotsForDate(date);
  
  // Check for existing daily summary
  const existingResult = await pool.query(
    `SELECT reliability_score FROM daily_capacity_summary WHERE date = $1`,
    [date]
  );
  const reliabilityScore = existingResult.rows[0]?.reliability_score;
  
  const summary: DailyCapacitySummary = {
    date,
    premiumCapacity: MAX_PREMIUM_SUBSCRIBERS,
    premiumBookedCount: premiumBooked,
    premiumRemainingSlots: MAX_PREMIUM_SUBSCRIBERS - premiumBooked,
    nonPremiumCapacityComputed: nonPremiumCapacity,
    nonPremiumBookedCount: nonPremiumBooked,
    nonPremiumRemainingSlots: Math.max(0, nonPremiumCapacity - nonPremiumBooked),
    slots,
    reliabilityScore,
  };
  
  // Update/insert daily summary
  await pool.query(
    `
    INSERT INTO daily_capacity_summary (
      date, premium_capacity, premium_booked_count,
      non_premium_capacity_computed, non_premium_booked_count
    )
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (date) DO UPDATE SET
      premium_booked_count = $3,
      non_premium_capacity_computed = $4,
      non_premium_booked_count = $5,
      updated_at = now()
    `,
    [date, MAX_PREMIUM_SUBSCRIBERS, premiumBooked, nonPremiumCapacity, nonPremiumBooked]
  );
  
  return summary;
}

// =============================================================================
// Hourly Breakdown
// =============================================================================

/**
 * Get hourly capacity breakdown for a date
 */
export async function getHourlyCapacityBreakdown(
  date: string
): Promise<HourlyCapacityBreakdown[]> {
  const slots = await getSlotsForDate(date);
  
  // Group by hour
  const hourlyMap = new Map<string, HourlyCapacityBreakdown>();
  
  for (const slot of slots) {
    const hour = slot.arrivalStart.slice(0, 2) + ':00';
    
    if (!hourlyMap.has(hour)) {
      hourlyMap.set(hour, {
        hour,
        slotType: slot.slotType,
        premiumSlots: 0,
        premiumUsed: 0,
        nonPremiumSlots: 0,
        nonPremiumUsed: 0,
      });
    }
    
    const breakdown = hourlyMap.get(hour)!;
    breakdown.premiumSlots += slot.maxRidersPremium;
    breakdown.premiumUsed += slot.usedRidersPremium;
    breakdown.nonPremiumSlots += slot.maxRidersNonPremium;
    breakdown.nonPremiumUsed += slot.usedRidersNonPremium;
  }
  
  return Array.from(hourlyMap.values()).sort((a, b) => 
    a.hour.localeCompare(b.hour)
  );
}

// =============================================================================
// Capacity Adjustment
// =============================================================================

/**
 * Adjust non-premium capacity for slots based on simulation results
 */
export async function adjustNonPremiumCapacity(
  date: string,
  adjustments: Array<{
    slotId: string;
    newMaxNonPremium: number;
    reason: string;
  }>
): Promise<void> {
  for (const adj of adjustments) {
    await updateSlotMaxNonPremium(adj.slotId, adj.newMaxNonPremium);
  }
  
  // Log adjustments
  console.log(`[CapacityPlanner] Adjusted ${adjustments.length} slots for ${date}`);
  for (const adj of adjustments) {
    console.log(`  - ${adj.slotId}: max_non_premium = ${adj.newMaxNonPremium} (${adj.reason})`);
  }
}

/**
 * Auto-balance non-premium capacity across off-peak slots
 * Called after simulations to optimize capacity distribution
 */
export async function autoBalanceNonPremiumCapacity(
  date: string,
  targetCapacity: number
): Promise<void> {
  const slots = await getSlotsForDate(date);
  const offPeakSlots = slots.filter(s => s.slotType === 'off_peak');
  
  if (offPeakSlots.length === 0) return;
  
  // Distribute capacity evenly, with slight preference for mid-day
  const basePerSlot = Math.floor(targetCapacity / offPeakSlots.length);
  const remainder = targetCapacity % offPeakSlots.length;
  
  // Sort slots by time to prefer mid-day for remainder
  const sortedSlots = [...offPeakSlots].sort((a, b) => {
    const aHour = parseInt(a.arrivalStart.slice(0, 2), 10);
    const bHour = parseInt(b.arrivalStart.slice(0, 2), 10);
    // Prefer hours 10-14 (mid-day)
    const aMidDay = aHour >= 10 && aHour < 15 ? 0 : 1;
    const bMidDay = bHour >= 10 && bHour < 15 ? 0 : 1;
    return aMidDay - bMidDay || aHour - bHour;
  });
  
  // Apply capacity
  for (let i = 0; i < sortedSlots.length; i++) {
    const slot = sortedSlots[i];
    const capacity = basePerSlot + (i < remainder ? 1 : 0);
    await updateSlotMaxNonPremium(slot.slotId, capacity);
  }
}

// =============================================================================
// Capacity Checks
// =============================================================================

/**
 * Check if adding a ride would exceed hourly limits
 */
export async function checkHourlyCapacity(
  date: string,
  hour: number
): Promise<boolean> {
  const result = await pool.query(
    `
    SELECT COUNT(*) as count
    FROM rides
    WHERE 
      DATE(pickup_time) = $1
      AND EXTRACT(HOUR FROM pickup_time) = $2
      AND status NOT IN ('cancelled', 'cancelled_by_user', 'cancelled_by_admin', 'cancelled_by_driver', 'no_show')
    `,
    [date, hour]
  );
  
  const count = parseInt(result.rows[0]?.count || '0', 10);
  return count < MAX_RIDES_PER_HOUR;
}

/**
 * Check if adding a ride would exceed daily limits
 */
export async function checkDailyCapacity(date: string): Promise<boolean> {
  const result = await pool.query(
    `
    SELECT COUNT(*) as count
    FROM rides
    WHERE 
      DATE(pickup_time) = $1
      AND status NOT IN ('cancelled', 'cancelled_by_user', 'cancelled_by_admin', 'cancelled_by_driver', 'no_show')
    `,
    [date]
  );
  
  const count = parseInt(result.rows[0]?.count || '0', 10);
  return count < MAX_RIDES_PER_DAY;
}

/**
 * Check if a premium ride can be added
 */
export async function canAddPremiumRide(
  date: string,
  slotId: string
): Promise<{ allowed: boolean; reason?: string }> {
  // Check daily capacity
  if (!(await checkDailyCapacity(date))) {
    return { allowed: false, reason: 'Daily ride limit reached' };
  }
  
  // Check slot capacity
  const result = await pool.query(
    `
    SELECT used_riders_premium, max_riders_premium
    FROM slot_capacity
    WHERE slot_id = $1
    `,
    [slotId]
  );
  
  if (result.rowCount === 0) {
    return { allowed: false, reason: 'Slot not found' };
  }
  
  const { used_riders_premium, max_riders_premium } = result.rows[0];
  if (used_riders_premium >= max_riders_premium) {
    return { allowed: false, reason: 'Slot at premium capacity' };
  }
  
  return { allowed: true };
}

/**
 * Check if a non-premium ride can be added
 */
export async function canAddNonPremiumRide(
  date: string,
  slotId: string
): Promise<{ allowed: boolean; reason?: string }> {
  // Check daily capacity
  if (!(await checkDailyCapacity(date))) {
    return { allowed: false, reason: 'Daily ride limit reached' };
  }
  
  // Get slot info
  const result = await pool.query(
    `
    SELECT slot_type, used_riders_non_premium, max_riders_non_premium
    FROM slot_capacity
    WHERE slot_id = $1
    `,
    [slotId]
  );
  
  if (result.rowCount === 0) {
    return { allowed: false, reason: 'Slot not found' };
  }
  
  const { slot_type, used_riders_non_premium, max_riders_non_premium } = result.rows[0];
  
  // Non-premium not allowed in peak
  if (slot_type === 'peak') {
    return { allowed: false, reason: 'Non-premium rides not allowed during peak hours' };
  }
  
  // Check slot capacity
  if (used_riders_non_premium >= max_riders_non_premium) {
    return { allowed: false, reason: 'Slot at non-premium capacity' };
  }
  
  // Check overall non-premium daily capacity
  const summary = await computeDailyCapacity(date);
  if (summary.nonPremiumBookedCount >= summary.nonPremiumCapacityComputed) {
    return { allowed: false, reason: 'Daily non-premium capacity reached' };
  }
  
  return { allowed: true };
}

// =============================================================================
// Reporting
// =============================================================================

/**
 * Get capacity utilization report for a date range
 */
export async function getCapacityUtilizationReport(
  startDate: string,
  endDate: string
): Promise<Array<{
  date: string;
  premiumUtilization: number;
  nonPremiumUtilization: number;
  totalRides: number;
}>> {
  const result = await pool.query(
    `
    SELECT 
      date::text,
      premium_booked_count,
      premium_capacity,
      non_premium_booked_count,
      non_premium_capacity_computed
    FROM daily_capacity_summary
    WHERE date >= $1 AND date <= $2
    ORDER BY date ASC
    `,
    [startDate, endDate]
  );
  
  return result.rows.map(row => ({
    date: row.date,
    premiumUtilization: row.premium_capacity > 0 
      ? row.premium_booked_count / row.premium_capacity 
      : 0,
    nonPremiumUtilization: row.non_premium_capacity_computed > 0
      ? row.non_premium_booked_count / row.non_premium_capacity_computed
      : 0,
    totalRides: row.premium_booked_count + row.non_premium_booked_count,
  }));
}

