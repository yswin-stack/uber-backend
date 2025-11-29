/**
 * Schedule State Module
 * 
 * Manages the current state of scheduled rides for a given date.
 * Provides the foundation for feasibility checking by tracking
 * all confirmed rides and their timing.
 */

import type {
  ScheduledRide,
  ScheduleState,
  Location,
  PlanType,
} from '../shared/schedulingTypes';
import { pool } from '../db/pool';

// =============================================================================
// Schedule State Loading
// =============================================================================

/**
 * Get all scheduled rides for a date
 */
export async function getScheduleStateForDate(date: string): Promise<ScheduleState> {
  const result = await pool.query(
    `
    SELECT 
      id::text,
      user_id::text as rider_id,
      DATE(pickup_time)::text as date,
      slot_id,
      COALESCE(plan_type, 'standard') as plan_type,
      COALESCE(TO_CHAR(arrival_window_start AT TIME ZONE 'America/Winnipeg', 'HH24:MI'), TO_CHAR(pickup_time AT TIME ZONE 'America/Winnipeg', 'HH24:MI')) as arrival_start,
      COALESCE(TO_CHAR(arrival_window_end AT TIME ZONE 'America/Winnipeg', 'HH24:MI'), TO_CHAR(pickup_time AT TIME ZONE 'America/Winnipeg', 'HH24:MI')) as arrival_end,
      COALESCE(pickup_lat, 49.8951) as origin_lat,
      COALESCE(pickup_lng, -97.1384) as origin_lng,
      COALESCE(drop_lat, 49.8075) as dest_lat,
      COALESCE(drop_lng, -97.1325) as dest_lng,
      pickup_location as origin_address,
      dropoff_location as dest_address,
      pickup_time,
      predicted_arrival
    FROM rides
    WHERE 
      DATE(pickup_time) = $1
      AND status NOT IN ('cancelled', 'cancelled_by_user', 'cancelled_by_admin', 'cancelled_by_driver', 'no_show')
    ORDER BY arrival_window_start ASC NULLS LAST
    `,
    [date]
  );
  
  const rides: ScheduledRide[] = result.rows.map(row => ({
    id: row.id,
    riderId: row.rider_id,
    date: row.date,
    slotId: row.slot_id,
    planType: row.plan_type as PlanType,
    arrivalStart: row.arrival_start || '09:00',
    arrivalEnd: row.arrival_end || '09:05',
    originLocation: {
      lat: parseFloat(row.origin_lat) || 49.8951,
      lng: parseFloat(row.origin_lng) || -97.1384,
    },
    destinationLocation: {
      lat: parseFloat(row.dest_lat) || 49.8075,
      lng: parseFloat(row.dest_lng) || -97.1325,
    },
    originAddress: row.origin_address,
    destinationAddress: row.dest_address,
    pickupTime: row.pickup_time,
    predictedArrival: row.predicted_arrival,
  }));
  
  return {
    date,
    rides,
  };
}

/**
 * Get rides within a specific time block
 */
export async function getRidesInTimeBlock(
  date: string,
  blockStart: string,  // 'HH:mm'
  blockEnd: string     // 'HH:mm'
): Promise<ScheduledRide[]> {
  const state = await getScheduleStateForDate(date);
  
  return state.rides.filter((ride: ScheduledRide) => {
    const rideStart = timeToMinutes(ride.arrivalStart);
    const rideEnd = timeToMinutes(ride.arrivalEnd);
    const blockStartMins = timeToMinutes(blockStart);
    const blockEndMins = timeToMinutes(blockEnd);
    
    // Ride overlaps with block if it starts before block ends and ends after block starts
    return rideStart < blockEndMins && rideEnd > blockStartMins;
  });
}

/**
 * Get rides for a specific slot
 */
export async function getRidesForSlot(slotId: string): Promise<ScheduledRide[]> {
  const result = await pool.query(
    `
    SELECT 
      id::text,
      user_id::text as rider_id,
      DATE(pickup_time)::text as date,
      slot_id,
      COALESCE(plan_type, 'standard') as plan_type,
      TO_CHAR(arrival_window_start AT TIME ZONE 'America/Winnipeg', 'HH24:MI') as arrival_start,
      TO_CHAR(arrival_window_end AT TIME ZONE 'America/Winnipeg', 'HH24:MI') as arrival_end,
      pickup_lat as origin_lat,
      pickup_lng as origin_lng,
      drop_lat as dest_lat,
      drop_lng as dest_lng,
      pickup_location as origin_address,
      dropoff_location as dest_address,
      pickup_time,
      predicted_arrival
    FROM rides
    WHERE 
      slot_id = $1
      AND status NOT IN ('cancelled', 'cancelled_by_user', 'cancelled_by_admin', 'cancelled_by_driver', 'no_show')
    ORDER BY arrival_window_start ASC
    `,
    [slotId]
  );
  
  return result.rows.map(row => ({
    id: row.id,
    riderId: row.rider_id,
    date: row.date,
    slotId: row.slot_id,
    planType: row.plan_type as PlanType,
    arrivalStart: row.arrival_start,
    arrivalEnd: row.arrival_end,
    originLocation: {
      lat: row.origin_lat,
      lng: row.origin_lng,
    },
    destinationLocation: {
      lat: row.dest_lat,
      lng: row.dest_lng,
    },
    originAddress: row.origin_address,
    destinationAddress: row.dest_address,
    pickupTime: row.pickup_time,
    predictedArrival: row.predicted_arrival,
  }));
}

/**
 * Get premium rides only for a date
 */
export async function getPremiumRidesForDate(date: string): Promise<ScheduledRide[]> {
  const state = await getScheduleStateForDate(date);
  return state.rides.filter((r: ScheduledRide) => r.planType === 'premium');
}

/**
 * Get non-premium rides for a date
 */
export async function getNonPremiumRidesForDate(date: string): Promise<ScheduledRide[]> {
  const state = await getScheduleStateForDate(date);
  return state.rides.filter((r: ScheduledRide) => r.planType !== 'premium');
}

// =============================================================================
// Active Holds State
// =============================================================================

/**
 * Get active holds for a date (these count against capacity)
 */
export async function getActiveHoldsForDate(date: string): Promise<Array<{
  holdId: string;
  slotId: string;
  riderId: string;
  planType: PlanType;
  expiresAt: string;
}>> {
  const result = await pool.query(
    `
    SELECT 
      hold_id,
      slot_id,
      rider_id::text,
      plan_type,
      expires_at
    FROM slot_holds sh
    JOIN slot_capacity sc ON sh.slot_id = sc.slot_id
    WHERE 
      sc.date = $1
      AND sh.status = 'active'
      AND sh.expires_at > now()
    `,
    [date]
  );
  
  return result.rows.map(row => ({
    holdId: row.hold_id,
    slotId: row.slot_id,
    riderId: row.rider_id,
    planType: row.plan_type as PlanType,
    expiresAt: row.expires_at,
  }));
}

// =============================================================================
// Schedule Blocks
// =============================================================================

/**
 * Define time blocks for scheduling
 */
export interface TimeBlock {
  name: string;
  start: string;
  end: string;
  isPeak: boolean;
}

export const SCHEDULE_BLOCKS: TimeBlock[] = [
  { name: 'early_morning', start: '06:00', end: '07:00', isPeak: false },
  { name: 'morning_peak', start: '07:00', end: '10:00', isPeak: true },
  { name: 'mid_day', start: '10:00', end: '15:00', isPeak: false },
  { name: 'evening_peak', start: '15:00', end: '18:00', isPeak: true },
  { name: 'evening', start: '18:00', end: '22:00', isPeak: false },
];

/**
 * Get the block a time falls into
 */
export function getBlockForTime(time: string): TimeBlock {
  const mins = timeToMinutes(time);
  
  for (const block of SCHEDULE_BLOCKS) {
    const blockStart = timeToMinutes(block.start);
    const blockEnd = timeToMinutes(block.end);
    
    if (mins >= blockStart && mins < blockEnd) {
      return block;
    }
  }
  
  // Default to last block
  return SCHEDULE_BLOCKS[SCHEDULE_BLOCKS.length - 1];
}

/**
 * Get all rides in a specific block
 */
export async function getRidesInBlock(
  date: string,
  block: TimeBlock
): Promise<ScheduledRide[]> {
  return getRidesInTimeBlock(date, block.start, block.end);
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

/**
 * Sort rides by arrival time
 */
export function sortRidesByArrival(rides: ScheduledRide[]): ScheduledRide[] {
  return [...rides].sort((a, b) => {
    const aTime = timeToMinutes(a.arrivalStart);
    const bTime = timeToMinutes(b.arrivalStart);
    return aTime - bTime;
  });
}

/**
 * Group rides by slot
 */
export function groupRidesBySlot(rides: ScheduledRide[]): Map<string, ScheduledRide[]> {
  const map = new Map<string, ScheduledRide[]>();
  
  for (const ride of rides) {
    if (!ride.slotId) continue;
    
    if (!map.has(ride.slotId)) {
      map.set(ride.slotId, []);
    }
    map.get(ride.slotId)!.push(ride);
  }
  
  return map;
}

/**
 * Calculate schedule density (rides per hour)
 */
export function calculateScheduleDensity(
  rides: ScheduledRide[],
  blockStart: string,
  blockEnd: string
): number {
  const startMins = timeToMinutes(blockStart);
  const endMins = timeToMinutes(blockEnd);
  const durationHours = (endMins - startMins) / 60;
  
  if (durationHours <= 0) return 0;
  
  const ridesInBlock = rides.filter(ride => {
    const rideStart = timeToMinutes(ride.arrivalStart);
    return rideStart >= startMins && rideStart < endMins;
  });
  
  return ridesInBlock.length / durationHours;
}

// =============================================================================
// Conflict Detection
// =============================================================================

/**
 * Check if two rides might conflict (same rider, overlapping times)
 */
export function ridesConflict(
  ride1: ScheduledRide,
  ride2: ScheduledRide,
  bufferMinutes: number = 30
): boolean {
  // Same rider?
  if (ride1.riderId === ride2.riderId) {
    const start1 = timeToMinutes(ride1.arrivalStart);
    const start2 = timeToMinutes(ride2.arrivalStart);
    
    // Too close together?
    if (Math.abs(start1 - start2) < bufferMinutes) {
      return true;
    }
  }
  
  return false;
}

/**
 * Find conflicting rides for a new ride
 */
export async function findConflictingRides(
  date: string,
  riderId: string,
  arrivalStart: string,
  bufferMinutes: number = 30
): Promise<ScheduledRide[]> {
  const state = await getScheduleStateForDate(date);
  
  const targetTime = timeToMinutes(arrivalStart);
  
  return state.rides.filter((ride: ScheduledRide) => {
    if (ride.riderId !== riderId) return false;
    
    const rideTime = timeToMinutes(ride.arrivalStart);
    return Math.abs(rideTime - targetTime) < bufferMinutes;
  });
}

