/**
 * Availability Service
 * 
 * Returns only feasible, system-approved time windows to riders.
 * No free-form time selection - riders choose from pre-validated slots.
 * 
 * Key features:
 * - Filters by plan type (Premium gets peak, Non-Premium gets off-peak only)
 * - Runs feasibility checks on each candidate slot
 * - Returns slots sorted by proximity to desired arrival time
 */

import type {
  AvailabilityQuery,
  TimeWindowOption,
  TimeSlot,
  Direction,
  PlanType,
  Location,
} from '../shared/schedulingTypes';
import { DEFAULT_SCHEDULING_CONFIG } from '../shared/schedulingTypes';
import {
  getSlotsForDate,
  getSlotsWithAvailability,
  hasAvailability,
  isInPeakWindow,
} from './timeSlots';
import {
  canInsertRideIntoSlot,
  quickFeasibilityCheck,
  batchFeasibilityCheck,
  checkRiderConflicts,
} from './feasibility';
import {
  getScheduleStateForDate,
} from './scheduleState';
import {
  getTravelTimeEstimate,
  createTimeContextFromStrings,
  calculatePickupTime,
} from './travelTimeModel';

// =============================================================================
// Constants
// =============================================================================

const SEARCH_RANGE_MINUTES = 90;  // Search ±90 minutes from desired arrival
const MAX_OPTIONS_TO_RETURN = 10;
const MIN_OPTIONS_TO_RETURN = 3;

// =============================================================================
// Direction Detection
// =============================================================================

/**
 * Infer direction from origin/destination
 * This is a simplified heuristic - in production you'd use saved locations
 */
export function inferDirection(
  origin: Location,
  destination: Location
): Direction {
  // Campus center
  const CAMPUS = { lat: 49.8075, lng: -97.1325 };
  
  // Calculate distances
  const originToCampus = haversineDistance(origin, CAMPUS);
  const destToCampus = haversineDistance(destination, CAMPUS);
  
  // If going towards campus
  if (destToCampus < originToCampus && destToCampus < 2) {
    return 'home_to_campus';
  }
  
  // If leaving campus
  if (originToCampus < destToCampus && originToCampus < 2) {
    return 'campus_to_home';
  }
  
  return 'other';
}

function haversineDistance(a: Location, b: Location): number {
  const R = 6371;
  const toRad = (v: number) => (v * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

// =============================================================================
// Main Availability Function
// =============================================================================

/**
 * Get available arrival windows for a ride request
 */
export async function getAvailableArrivalWindows(
  query: AvailabilityQuery
): Promise<TimeWindowOption[]> {
  const { date, originLocation, destinationLocation, planType, desiredArrival } = query;
  
  // 1. Infer direction
  const direction = inferDirection(originLocation, destinationLocation);
  
  // 2. Get all slots for date and direction
  const slots = await getSlotsWithAvailability(date, direction);
  
  // 3. Filter by plan type
  const eligibleSlots = filterSlotsByPlanType(slots, planType);
  
  // 4. If desired arrival specified, filter to nearby slots
  const nearbySlots = desiredArrival
    ? filterNearbySlots(eligibleSlots, desiredArrival)
    : eligibleSlots;
  
  // 5. Check capacity availability
  const availableSlots = nearbySlots.filter(slot => 
    hasAvailability(slot, planType === 'premium')
  );
  
  if (availableSlots.length === 0) {
    return [];
  }
  
  // 6. Run feasibility checks
  const rideRequest = {
    riderId: 'availability_check', // Placeholder - actual rider checked later
    date,
    originLocation,
    destinationLocation,
    planType,
  };
  
  const feasibilityResults = await batchFeasibilityCheck(rideRequest, availableSlots);
  
  // 7. Build result options
  const options: TimeWindowOption[] = [];
  
  for (const slot of availableSlots) {
    const feasibility = feasibilityResults.get(slot.slotId);
    
    if (!feasibility?.feasible) continue;
    
    // Calculate estimated pickup time
    const ctx = createTimeContextFromStrings(date, slot.arrivalStart);
    const travelEstimate = getTravelTimeEstimate(originLocation, destinationLocation, ctx);
    
    const arrivalDate = dateFromTimeString(date, slot.arrivalEnd);
    const pickupTime = calculatePickupTime(arrivalDate, travelEstimate.p95Minutes);
    const estimatedPickupTime = formatTimeFromDate(pickupTime);
    
    options.push({
      slotId: slot.slotId,
      arrivalStart: slot.arrivalStart,
      arrivalEnd: slot.arrivalEnd,
      risk: feasibility.riskLevel || 'medium',
      estimatedPickupTime,
    });
  }
  
  // 8. Sort by proximity to desired arrival (if specified)
  if (desiredArrival) {
    sortByProximity(options, desiredArrival);
  }
  
  // 9. Limit results
  return options.slice(0, MAX_OPTIONS_TO_RETURN);
}

// =============================================================================
// Filter Functions
// =============================================================================

/**
 * Filter slots by plan type
 */
function filterSlotsByPlanType(slots: TimeSlot[], planType: PlanType): TimeSlot[] {
  const isPremium = planType === 'premium';
  
  return slots.filter(slot => {
    // Premium can access all slots
    if (isPremium) {
      return true;
    }
    
    // Non-premium (standard/off_peak) can only access off-peak slots
    return slot.slotType === 'off_peak';
  });
}

/**
 * Filter slots near the desired arrival time
 */
function filterNearbySlots(slots: TimeSlot[], desiredArrival: string): TimeSlot[] {
  const desiredMins = timeToMinutes(desiredArrival);
  const minMins = desiredMins - SEARCH_RANGE_MINUTES;
  const maxMins = desiredMins + SEARCH_RANGE_MINUTES;
  
  return slots.filter(slot => {
    const slotMins = timeToMinutes(slot.arrivalStart);
    return slotMins >= minMins && slotMins <= maxMins;
  });
}

/**
 * Sort options by proximity to desired time
 */
function sortByProximity(options: TimeWindowOption[], desiredArrival: string): void {
  const desiredMins = timeToMinutes(desiredArrival);
  const riskOrder: Record<'low' | 'medium' | 'high', number> = { low: 0, medium: 1, high: 2 };
  
  options.sort((a: TimeWindowOption, b: TimeWindowOption) => {
    const aDiff = Math.abs(timeToMinutes(a.arrivalStart) - desiredMins);
    const bDiff = Math.abs(timeToMinutes(b.arrivalStart) - desiredMins);
    
    // First sort by proximity
    if (aDiff !== bDiff) {
      return aDiff - bDiff;
    }
    
    // Then prefer lower risk
    return riskOrder[a.risk] - riskOrder[b.risk];
  });
}

// =============================================================================
// Extended Availability Queries
// =============================================================================

/**
 * Get availability for a specific rider (includes conflict checking)
 */
export async function getAvailableWindowsForRider(
  riderId: string,
  query: AvailabilityQuery
): Promise<TimeWindowOption[]> {
  // Get base availability
  const options = await getAvailableArrivalWindows(query);
  
  // Filter out slots that conflict with rider's existing rides
  const validOptions: TimeWindowOption[] = [];
  
  for (const option of options) {
    const { hasConflict } = await checkRiderConflicts(
      riderId,
      query.date,
      option.arrivalStart
    );
    
    if (!hasConflict) {
      validOptions.push(option);
    }
  }
  
  return validOptions;
}

/**
 * Check if a specific slot is available for a rider
 */
export async function isSlotAvailableForRider(
  riderId: string,
  slotId: string,
  query: AvailabilityQuery
): Promise<{ available: boolean; reason?: string; option?: TimeWindowOption }> {
  const { date, originLocation, destinationLocation, planType } = query;
  
  // Get the slot
  const slots = await getSlotsForDate(date);
  const slot = slots.find(s => s.slotId === slotId);
  
  if (!slot) {
    return { available: false, reason: 'Slot not found' };
  }
  
  // Quick checks
  const quick = await quickFeasibilityCheck(slotId, planType);
  if (!quick.possible) {
    return { available: false, reason: quick.reason };
  }
  
  // Check rider conflicts
  const { hasConflict, conflictingRide } = await checkRiderConflicts(
    riderId,
    date,
    slot.arrivalStart
  );
  
  if (hasConflict) {
    return {
      available: false,
      reason: `Conflicts with existing ride at ${conflictingRide?.arrivalStart}`,
    };
  }
  
  // Full feasibility check
  const rideRequest = {
    riderId,
    date,
    originLocation,
    destinationLocation,
    planType,
  };
  
  const feasibility = await canInsertRideIntoSlot(rideRequest, slot);
  
  if (!feasibility.feasible) {
    return { available: false, reason: feasibility.reason };
  }
  
  // Build option
  const ctx = createTimeContextFromStrings(date, slot.arrivalStart);
  const travelEstimate = getTravelTimeEstimate(originLocation, destinationLocation, ctx);
  
  const arrivalDate = dateFromTimeString(date, slot.arrivalEnd);
  const pickupTime = calculatePickupTime(arrivalDate, travelEstimate.p95Minutes);
  
  return {
    available: true,
    option: {
      slotId: slot.slotId,
      arrivalStart: slot.arrivalStart,
      arrivalEnd: slot.arrivalEnd,
      risk: feasibility.riskLevel || 'medium',
      estimatedPickupTime: formatTimeFromDate(pickupTime),
    },
  };
}

/**
 * Get availability summary for a date
 */
export async function getAvailabilitySummary(
  date: string,
  planType: PlanType
): Promise<{
  totalSlots: number;
  availableSlots: number;
  peakSlots: number;
  offPeakSlots: number;
  byHour: Array<{
    hour: string;
    available: number;
    total: number;
  }>;
}> {
  const slots = await getSlotsWithAvailability(date);
  const filtered = filterSlotsByPlanType(slots, planType);
  const isPremium = planType === 'premium';
  
  const available = filtered.filter(s => hasAvailability(s, isPremium));
  
  // Group by hour
  const byHourMap = new Map<string, { available: number; total: number }>();
  
  for (const slot of filtered) {
    const hour = slot.arrivalStart.slice(0, 2) + ':00';
    
    if (!byHourMap.has(hour)) {
      byHourMap.set(hour, { available: 0, total: 0 });
    }
    
    const entry = byHourMap.get(hour)!;
    entry.total++;
    if (hasAvailability(slot, isPremium)) {
      entry.available++;
    }
  }
  
  return {
    totalSlots: filtered.length,
    availableSlots: available.length,
    peakSlots: filtered.filter((s: TimeSlot) => s.slotType === 'peak').length,
    offPeakSlots: filtered.filter((s: TimeSlot) => s.slotType === 'off_peak').length,
    byHour: Array.from(byHourMap.entries())
      .map(([hour, data]) => ({ hour, ...data }))
      .sort((a, b) => a.hour.localeCompare(b.hour)),
  };
}

// =============================================================================
// Next Available Slot
// =============================================================================

/**
 * Find the next available slot after a given time
 */
export async function getNextAvailableSlot(
  date: string,
  afterTime: string,
  planType: PlanType,
  direction: Direction = 'other'
): Promise<TimeSlot | null> {
  const slots = await getSlotsWithAvailability(date, direction);
  const filtered = filterSlotsByPlanType(slots, planType);
  const isPremium = planType === 'premium';
  
  const afterMins = timeToMinutes(afterTime);
  
  for (const slot of filtered) {
    const slotMins = timeToMinutes(slot.arrivalStart);
    if (slotMins <= afterMins) continue;
    
    if (hasAvailability(slot, isPremium)) {
      return slot;
    }
  }
  
  return null;
}

// =============================================================================
// Utility Functions
// =============================================================================

function timeToMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

function minutesToTime(mins: number): string {
  const hours = Math.floor(mins / 60);
  const minutes = mins % 60;
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
}

function dateFromTimeString(dateStr: string, timeStr: string): Date {
  return new Date(`${dateStr}T${timeStr}:00`);
}

function formatTimeFromDate(date: Date): string {
  return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
}

