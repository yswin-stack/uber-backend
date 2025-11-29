/**
 * Feasibility Module
 * 
 * Checks if a new ride can be inserted into the schedule while
 * maintaining all timing guarantees, especially:
 * 
 * - 5-minute early dropoff rule (must arrive 5 min before deadline)
 * - Premium ride priority (Premium rides must never be made late)
 * - Sequential trip planning within blocks
 */

import type {
  RideRequest,
  FeasibilityResult,
  ScheduledRide,
  TimeSlot,
  Location,
  TimeContext,
  PlanType,
} from '../shared/schedulingTypes';
import { DEFAULT_SCHEDULING_CONFIG } from '../shared/schedulingTypes';
import {
  getScheduleStateForDate,
  getRidesInTimeBlock,
  getBlockForTime,
  sortRidesByArrival,
  SCHEDULE_BLOCKS,
} from './scheduleState';
import {
  getTravelTimeStats,
  createTimeContextFromStrings,
  estimateDistanceKm,
} from './travelTimeModel';
import {
  getDefaultRiderBehaviorStats,
  calculateRiderBuffer,
} from './riderBehaviorModel';
import { getSlotById, hasAvailability } from './timeSlots';

// =============================================================================
// Constants
// =============================================================================

const ARRIVE_EARLY_MINUTES = DEFAULT_SCHEDULING_CONFIG.ARRIVE_EARLY_MINUTES;
const MAX_RIDERS_PER_RIDE = DEFAULT_SCHEDULING_CONFIG.MAX_RIDERS_PER_RIDE;

// Campus location (driver starting point)
const DRIVER_HOME_BASE: Location = {
  lat: 49.8075,
  lng: -97.1325,
};

// =============================================================================
// Core Feasibility Check
// =============================================================================

/**
 * Check if a ride can be inserted into a specific slot
 */
export async function canInsertRideIntoSlot(
  request: RideRequest,
  slot: TimeSlot,
  existingRides?: ScheduledRide[]
): Promise<FeasibilityResult> {
  // 1. Check basic slot availability
  const isPremium = request.planType === 'premium';
  if (!hasAvailability(slot, isPremium)) {
    return {
      feasible: false,
      reason: isPremium 
        ? 'Slot has no premium capacity available'
        : 'Slot has no non-premium capacity available',
    };
  }
  
  // 2. Check peak window restrictions for non-premium
  if (!isPremium && slot.slotType === 'peak') {
    return {
      feasible: false,
      reason: 'Non-premium rides are not allowed during peak hours',
    };
  }
  
  // 3. Get existing rides in the block if not provided
  const block = getBlockForTime(slot.arrivalStart);
  const ridesInBlock = existingRides ?? await getRidesInTimeBlock(
    request.date,
    block.start,
    block.end
  );
  
  // 4. Create candidate ride
  const candidateRide: ScheduledRide = {
    id: 'candidate',
    riderId: request.riderId,
    date: request.date,
    slotId: slot.slotId,
    planType: request.planType,
    arrivalStart: slot.arrivalStart,
    arrivalEnd: slot.arrivalEnd,
    originLocation: request.originLocation,
    destinationLocation: request.destinationLocation,
    originAddress: request.originAddress,
    destinationAddress: request.destinationAddress,
  };
  
  // 5. Simulate the block schedule with the new ride
  const allRides = [...ridesInBlock, candidateRide];
  const simulation = simulateBlockSchedule(allRides, request.date, block.start);
  
  // 6. Check if all rides meet the 5-min-early rule
  for (const result of simulation) {
    if (!result.meetsDeadline) {
      // If a premium ride would be late, this is a hard failure
      if (result.planType === 'premium') {
        return {
          feasible: false,
          reason: `Would make Premium ride late by ${Math.round(result.latenessMinutes)} minutes`,
          riskLevel: 'high',
        };
      }
      
      // If the candidate non-premium ride would be late
      if (result.rideId === 'candidate') {
        return {
          feasible: false,
          reason: `Ride would arrive ${Math.round(result.latenessMinutes)} minutes late`,
          riskLevel: 'high',
        };
      }
      
      // If another non-premium ride would be made late
      return {
        feasible: false,
        reason: `Would make another ride late`,
        riskLevel: 'medium',
      };
    }
  }
  
  // 7. Find the candidate's result
  const candidateResult = simulation.find(r => r.rideId === 'candidate');
  if (!candidateResult) {
    return {
      feasible: false,
      reason: 'Internal error: candidate ride not found in simulation',
    };
  }
  
  // 8. Calculate risk level based on buffer
  const riskLevel = calculateRiskLevel(candidateResult.bufferMinutes);
  
  return {
    feasible: true,
    predictedArrival: candidateResult.predictedArrivalTime,
    bufferMinutes: candidateResult.bufferMinutes,
    riskLevel,
  };
}

// =============================================================================
// Schedule Simulation
// =============================================================================

interface SimulatedRideResult {
  rideId: string;
  planType: PlanType;
  predictedArrivalTime: string;  // 'HH:mm'
  deadlineTime: string;          // 'HH:mm' (arrival_end - 5 min)
  meetsDeadline: boolean;
  bufferMinutes: number;
  latenessMinutes: number;
}

/**
 * Simulate a block of rides to check timing feasibility
 * 
 * This simulates the driver going through all rides sequentially,
 * calculating realistic arrival times using P95 travel estimates
 * and rider delay buffers.
 */
function simulateBlockSchedule(
  rides: ScheduledRide[],
  date: string,
  blockStart: string
): SimulatedRideResult[] {
  if (rides.length === 0) return [];
  
  // Sort rides by arrival time
  const sortedRides = sortRidesByArrival(rides);
  
  const results: SimulatedRideResult[] = [];
  
  // Start at driver's base at block start
  let currentLocation = DRIVER_HOME_BASE;
  let currentTime = timeToMinutes(blockStart);
  
  for (const ride of sortedRides) {
    const ctx = createTimeContextFromStrings(date, minutesToTime(currentTime));
    
    // 1. Travel to pickup
    const pickupTravel = getTravelTimeStats(
      currentLocation,
      ride.originLocation,
      ctx
    );
    currentTime += pickupTravel.p95Minutes;
    
    // 2. Add rider delay buffer (P95)
    const riderStats = getDefaultRiderBehaviorStats(ctx);
    currentTime += riderStats.p95ReadyDelayMinutes;
    
    // 3. Travel to dropoff
    const dropoffTravel = getTravelTimeStats(
      ride.originLocation,
      ride.destinationLocation,
      ctx
    );
    currentTime += dropoffTravel.p95Minutes;
    
    // 4. Calculate deadline (arrival_end - 5 minutes)
    const arrivalEnd = timeToMinutes(ride.arrivalEnd);
    const deadline = arrivalEnd - ARRIVE_EARLY_MINUTES;
    
    // 5. Check if on time
    const bufferMinutes = deadline - currentTime;
    const meetsDeadline = currentTime <= deadline;
    const latenessMinutes = meetsDeadline ? 0 : currentTime - deadline;
    
    results.push({
      rideId: ride.id,
      planType: ride.planType,
      predictedArrivalTime: minutesToTime(Math.round(currentTime)),
      deadlineTime: minutesToTime(Math.round(deadline)),
      meetsDeadline,
      bufferMinutes: Math.round(bufferMinutes),
      latenessMinutes: Math.round(latenessMinutes),
    });
    
    // Update current location to dropoff
    currentLocation = ride.destinationLocation;
  }
  
  return results;
}

// =============================================================================
// Quick Feasibility Checks
// =============================================================================

/**
 * Quick check: can this slot potentially accept a ride?
 * (Faster check without full simulation)
 */
export async function quickFeasibilityCheck(
  slotId: string,
  planType: PlanType
): Promise<{ possible: boolean; reason?: string }> {
  const slot = await getSlotById(slotId);
  
  if (!slot) {
    return { possible: false, reason: 'Slot not found' };
  }
  
  const isPremium = planType === 'premium';
  
  // Check capacity
  if (!hasAvailability(slot, isPremium)) {
    return { 
      possible: false, 
      reason: 'Slot at capacity' 
    };
  }
  
  // Check peak restriction
  if (!isPremium && slot.slotType === 'peak') {
    return {
      possible: false,
      reason: 'Non-premium not allowed during peak',
    };
  }
  
  // Check fragility flag
  if (slot.fragile && !isPremium) {
    return {
      possible: false,
      reason: 'Slot is marked fragile - premium only',
    };
  }
  
  return { possible: true };
}

/**
 * Check if ride request conflicts with existing rides for the same rider
 */
export async function checkRiderConflicts(
  riderId: string,
  date: string,
  arrivalTime: string,
  bufferMinutes: number = 30
): Promise<{ hasConflict: boolean; conflictingRide?: ScheduledRide }> {
  const state = await getScheduleStateForDate(date);
  
  const targetTime = timeToMinutes(arrivalTime);
  
  for (const ride of state.rides) {
    if (ride.riderId !== riderId) continue;
    
    const rideTime = timeToMinutes(ride.arrivalStart);
    if (Math.abs(rideTime - targetTime) < bufferMinutes) {
      return { hasConflict: true, conflictingRide: ride };
    }
  }
  
  return { hasConflict: false };
}

// =============================================================================
// Batch Feasibility Analysis
// =============================================================================

/**
 * Check feasibility for multiple slots at once
 */
export async function batchFeasibilityCheck(
  request: RideRequest,
  slots: TimeSlot[]
): Promise<Map<string, FeasibilityResult>> {
  const results = new Map<string, FeasibilityResult>();
  
  // Get existing rides once
  const state = await getScheduleStateForDate(request.date);
  
  for (const slot of slots) {
    // Get rides in this slot's block
    const block = getBlockForTime(slot.arrivalStart);
    const ridesInBlock = state.rides.filter((ride: ScheduledRide) => {
      const rideTime = timeToMinutes(ride.arrivalStart);
      const blockStart = timeToMinutes(block.start);
      const blockEnd = timeToMinutes(block.end);
      return rideTime >= blockStart && rideTime < blockEnd;
    });
    
    const result = await canInsertRideIntoSlot(request, slot, ridesInBlock);
    results.set(slot.slotId, result);
  }
  
  return results;
}

// =============================================================================
// Impact Analysis
// =============================================================================

/**
 * Analyze the impact of adding a ride on existing rides
 */
export async function analyzeRideImpact(
  request: RideRequest,
  slot: TimeSlot
): Promise<{
  affectedRides: Array<{
    rideId: string;
    currentBuffer: number;
    newBuffer: number;
    impact: 'positive' | 'neutral' | 'negative' | 'critical';
  }>;
  overallImpact: 'safe' | 'warning' | 'dangerous';
}> {
  const block = getBlockForTime(slot.arrivalStart);
  const existingRides = await getRidesInTimeBlock(request.date, block.start, block.end);
  
  // Simulate without the new ride
  const beforeSim = simulateBlockSchedule(existingRides, request.date, block.start);
  
  // Create candidate and simulate with it
  const candidateRide: ScheduledRide = {
    id: 'candidate',
    riderId: request.riderId,
    date: request.date,
    slotId: slot.slotId,
    planType: request.planType,
    arrivalStart: slot.arrivalStart,
    arrivalEnd: slot.arrivalEnd,
    originLocation: request.originLocation,
    destinationLocation: request.destinationLocation,
  };
  
  const afterSim = simulateBlockSchedule(
    [...existingRides, candidateRide],
    request.date,
    block.start
  );
  
  // Compare results
  const affectedRides: Array<{
    rideId: string;
    currentBuffer: number;
    newBuffer: number;
    impact: 'positive' | 'neutral' | 'negative' | 'critical';
  }> = [];
  
  let worstImpact: 'safe' | 'warning' | 'dangerous' = 'safe';
  
  for (const before of beforeSim) {
    const after = afterSim.find(a => a.rideId === before.rideId);
    if (!after) continue;
    
    const bufferDiff = after.bufferMinutes - before.bufferMinutes;
    
    let impact: 'positive' | 'neutral' | 'negative' | 'critical';
    if (bufferDiff > 0) {
      impact = 'positive';
    } else if (bufferDiff >= -2) {
      impact = 'neutral';
    } else if (after.meetsDeadline) {
      impact = 'negative';
      worstImpact = worstImpact === 'dangerous' ? 'dangerous' : 'warning';
    } else {
      impact = 'critical';
      worstImpact = 'dangerous';
    }
    
    affectedRides.push({
      rideId: before.rideId,
      currentBuffer: before.bufferMinutes,
      newBuffer: after.bufferMinutes,
      impact,
    });
  }
  
  return {
    affectedRides,
    overallImpact: worstImpact,
  };
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

function calculateRiskLevel(bufferMinutes: number): 'low' | 'medium' | 'high' {
  if (bufferMinutes >= 10) return 'low';
  if (bufferMinutes >= 5) return 'medium';
  return 'high';
}

/**
 * Estimate the latest safe pickup time for a given arrival deadline
 */
export function calculateLatestPickupTime(
  origin: Location,
  destination: Location,
  arrivalDeadline: string,  // 'HH:mm'
  date: string
): string {
  const ctx = createTimeContextFromStrings(date, arrivalDeadline);
  const travelStats = getTravelTimeStats(origin, destination, ctx);
  
  const deadlineMins = timeToMinutes(arrivalDeadline);
  const latestPickup = deadlineMins - travelStats.p95Minutes - ARRIVE_EARLY_MINUTES;
  
  return minutesToTime(Math.max(0, Math.round(latestPickup)));
}

/**
 * Calculate minimum travel time between two locations
 */
export function getMinTravelTime(
  origin: Location,
  destination: Location,
  date: string,
  time: string
): number {
  const ctx = createTimeContextFromStrings(date, time);
  const stats = getTravelTimeStats(origin, destination, ctx);
  return stats.meanMinutes;
}

