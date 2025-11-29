/**
 * Monte Carlo Simulation Engine
 * 
 * Runs thousands of simulations to:
 * - Validate reliability guarantees (99% Premium on-time)
 * - Compute safe non-Premium capacity
 * - Identify schedule fragility
 * - Generate capacity adjustment recommendations
 */

import { v4 as uuidv4 } from 'uuid';
import type {
  SimulationScenario,
  SimulationRideResult,
  SimulationRunResult,
  MonteCarloSummary,
  ScheduledRide,
  Location,
  PlanType,
  TimeContext,
} from '../shared/schedulingTypes';
import { DEFAULT_SCHEDULING_CONFIG } from '../shared/schedulingTypes';
import { pool } from '../db/pool';
import {
  getScheduleStateForDate,
  sortRidesByArrival,
  SCHEDULE_BLOCKS,
} from './scheduleState';
import {
  sampleTravelTimeMinutes,
  createTimeContextFromStrings,
} from './travelTimeModel';
import {
  sampleRiderReadyDelay,
  getDefaultRiderBehaviorStats,
} from './riderBehaviorModel';
import { getSlotsForDate } from './timeSlots';

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_RUN_COUNT = DEFAULT_SCHEDULING_CONFIG.MONTE_CARLO_DEFAULT_RUNS;
const ARRIVE_EARLY_MINUTES = DEFAULT_SCHEDULING_CONFIG.ARRIVE_EARLY_MINUTES;
const PREMIUM_ON_TIME_TARGET = DEFAULT_SCHEDULING_CONFIG.PREMIUM_ON_TIME_TARGET;
const NON_PREMIUM_ON_TIME_TARGET = DEFAULT_SCHEDULING_CONFIG.NON_PREMIUM_ON_TIME_TARGET;

// Driver home base
const DRIVER_HOME_BASE: Location = { lat: 49.8075, lng: -97.1325 };

// =============================================================================
// Single Simulation Run
// =============================================================================

/**
 * Run a single simulation of the day's schedule
 */
export function runSingleSimulation(
  rides: ScheduledRide[],
  date: string,
  scenario: SimulationScenario
): SimulationRunResult {
  // Filter out rides with missing required data
  const validRides = rides.filter(ride => 
    ride.arrivalStart && 
    ride.arrivalEnd && 
    ride.originLocation?.lat != null && 
    ride.originLocation?.lng != null &&
    ride.destinationLocation?.lat != null &&
    ride.destinationLocation?.lng != null
  );
  
  if (validRides.length === 0) {
    return {
      runIndex: 0,
      rides: [],
      premiumOnTimeCount: 0,
      premiumTotalCount: 0,
      nonPremiumOnTimeCount: 0,
      nonPremiumTotalCount: 0,
      maxLatenessMinutes: 0,
    };
  }
  
  const sortedRides = sortRidesByArrival(validRides);
  const varianceLevel = scenario.trafficVariance || 'medium';
  const riderDelayVariance = scenario.riderDelayVariance || 'medium';
  
  const results: SimulationRideResult[] = [];
  let currentLocation = DRIVER_HOME_BASE;
  let currentTimeMinutes = 6 * 60; // Start at 6:00 AM
  
  let premiumOnTime = 0;
  let premiumTotal = 0;
  let nonPremiumOnTime = 0;
  let nonPremiumTotal = 0;
  let maxLateness = 0;
  
  for (const ride of sortedRides) {
    // Get time context
    const ctx = createTimeContextFromStrings(date, minutesToTime(currentTimeMinutes), scenario.weather);
    
    // Sample travel to pickup
    const toPickupMinutes = sampleTravelTimeMinutes(
      currentLocation,
      ride.originLocation,
      ctx,
      varianceLevel
    );
    currentTimeMinutes += toPickupMinutes;
    
    // Sample rider delay
    const riderStats = getDefaultRiderBehaviorStats(ctx);
    const riderDelay = sampleRiderReadyDelay(riderStats, riderDelayVariance);
    
    if (riderDelay.isNoShow) {
      // Skip this ride (no-show)
      continue;
    }
    
    currentTimeMinutes += Math.max(0, riderDelay.delayMinutes);
    
    // Sample travel to dropoff
    const toDropoffMinutes = sampleTravelTimeMinutes(
      ride.originLocation,
      ride.destinationLocation,
      ctx,
      varianceLevel
    );
    currentTimeMinutes += toDropoffMinutes;
    
    // Calculate deadline (arrival_end - 5 min)
    const arrivalEndMinutes = timeToMinutes(ride.arrivalEnd);
    const deadlineMinutes = arrivalEndMinutes - ARRIVE_EARLY_MINUTES;
    
    // Check if on time
    const latenessMinutes = Math.max(0, currentTimeMinutes - deadlineMinutes);
    const wasOnTime = currentTimeMinutes <= deadlineMinutes;
    
    // Update counters
    if (ride.planType === 'premium') {
      premiumTotal++;
      if (wasOnTime) premiumOnTime++;
    } else {
      nonPremiumTotal++;
      if (wasOnTime) nonPremiumOnTime++;
    }
    
    maxLateness = Math.max(maxLateness, latenessMinutes);
    
    results.push({
      rideId: ride.id,
      plannedArrival: ride.arrivalEnd,
      simulatedArrival: minutesToTime(Math.round(currentTimeMinutes)),
      latenessMinutes,
      wasOnTime,
      planType: ride.planType,
    });
    
    // Update current location
    currentLocation = ride.destinationLocation;
  }
  
  return {
    runIndex: 0,
    rides: results,
    premiumOnTimeCount: premiumOnTime,
    premiumTotalCount: premiumTotal,
    nonPremiumOnTimeCount: nonPremiumOnTime,
    nonPremiumTotalCount: nonPremiumTotal,
    maxLatenessMinutes: maxLateness,
  };
}

// =============================================================================
// Monte Carlo Simulation
// =============================================================================

/**
 * Run full Monte Carlo simulation
 */
export async function runMonteCarlo(
  date: string,
  scenario: SimulationScenario = {},
  runCount: number = DEFAULT_RUN_COUNT
): Promise<MonteCarloSummary> {
  // Get schedule state
  const state = await getScheduleStateForDate(date);
  
  if (state.rides.length === 0) {
    return createEmptySummary(date, scenario, runCount);
  }
  
  const runs: SimulationRunResult[] = [];
  
  // Run simulations
  for (let i = 0; i < runCount; i++) {
    const result = runSingleSimulation(state.rides, date, scenario);
    result.runIndex = i;
    runs.push(result);
  }
  
  // Compute statistics
  return computeSummaryFromRuns(date, scenario, runs, state.rides);
}

/**
 * Create empty summary for when there are no rides
 */
function createEmptySummary(
  date: string,
  scenario: SimulationScenario,
  runCount: number
): MonteCarloSummary {
  return {
    jobId: `sim_${uuidv4()}`,
    date,
    runCount,
    scenario,
    premiumOnTimeRate: 1.0,
    premiumOnTimeRateP95: 1.0,
    premiumWorstRunRate: 1.0,
    nonPremiumOnTimeRate: 1.0,
    nonPremiumOnTimeRateP95: 1.0,
    nonPremiumWorstRunRate: 1.0,
    maxLatenessMinutes: 0,
    avgMaxLateness: 0,
    recommendations: [],
    suggestedCapacityAdjustments: [],
  };
}

/**
 * Compute summary statistics from simulation runs
 */
function computeSummaryFromRuns(
  date: string,
  scenario: SimulationScenario,
  runs: SimulationRunResult[],
  originalRides: ScheduledRide[]
): MonteCarloSummary {
  const jobId = `sim_${uuidv4()}`;
  
  // Calculate on-time rates for each run
  const premiumRates = runs.map(r => 
    r.premiumTotalCount > 0 ? r.premiumOnTimeCount / r.premiumTotalCount : 1.0
  );
  const nonPremiumRates = runs.map(r =>
    r.nonPremiumTotalCount > 0 ? r.nonPremiumOnTimeCount / r.nonPremiumTotalCount : 1.0
  );
  const maxLatenesses = runs.map(r => r.maxLatenessMinutes);
  
  // Sort for percentile calculations
  premiumRates.sort((a, b) => a - b);
  nonPremiumRates.sort((a, b) => a - b);
  maxLatenesses.sort((a, b) => a - b);
  
  // Calculate statistics
  const premiumOnTimeRate = average(premiumRates);
  const premiumOnTimeRateP95 = percentile(premiumRates, 5); // 5th percentile (worst 5%)
  const premiumWorstRunRate = Math.min(...premiumRates);
  
  const nonPremiumOnTimeRate = average(nonPremiumRates);
  const nonPremiumOnTimeRateP95 = percentile(nonPremiumRates, 5);
  const nonPremiumWorstRunRate = Math.min(...nonPremiumRates);
  
  const maxLatenessMinutes = Math.max(...maxLatenesses);
  const avgMaxLateness = average(maxLatenesses);
  
  // Generate recommendations
  const recommendations = generateRecommendations(
    premiumOnTimeRate,
    premiumWorstRunRate,
    nonPremiumOnTimeRate,
    maxLatenessMinutes,
    originalRides
  );
  
  // Generate capacity adjustment suggestions
  const suggestedCapacityAdjustments = generateCapacityAdjustments(
    date,
    runs,
    originalRides
  );
  
  return {
    jobId,
    date,
    runCount: runs.length,
    scenario,
    premiumOnTimeRate: round4(premiumOnTimeRate),
    premiumOnTimeRateP95: round4(premiumOnTimeRateP95),
    premiumWorstRunRate: round4(premiumWorstRunRate),
    nonPremiumOnTimeRate: round4(nonPremiumOnTimeRate),
    nonPremiumOnTimeRateP95: round4(nonPremiumOnTimeRateP95),
    nonPremiumWorstRunRate: round4(nonPremiumWorstRunRate),
    maxLatenessMinutes: Math.round(maxLatenessMinutes),
    avgMaxLateness: round2(avgMaxLateness),
    recommendations,
    suggestedCapacityAdjustments,
  };
}

// =============================================================================
// Recommendations Engine
// =============================================================================

function generateRecommendations(
  premiumRate: number,
  premiumWorst: number,
  nonPremiumRate: number,
  maxLateness: number,
  rides: ScheduledRide[]
): string[] {
  const recommendations: string[] = [];
  
  // Check Premium reliability
  if (premiumRate < PREMIUM_ON_TIME_TARGET) {
    recommendations.push(
      `Premium on-time rate (${(premiumRate * 100).toFixed(1)}%) is below target (${PREMIUM_ON_TIME_TARGET * 100}%). Consider reducing non-premium capacity.`
    );
  }
  
  if (premiumWorst < 0.9) {
    recommendations.push(
      `Worst-case Premium reliability (${(premiumWorst * 100).toFixed(1)}%) is concerning. Schedule may be too tight.`
    );
  }
  
  // Check Non-Premium reliability
  if (nonPremiumRate < NON_PREMIUM_ON_TIME_TARGET) {
    recommendations.push(
      `Non-premium on-time rate (${(nonPremiumRate * 100).toFixed(1)}%) is below target. Consider reducing non-premium capacity in congested hours.`
    );
  }
  
  // Check max lateness
  if (maxLateness > 15) {
    recommendations.push(
      `Maximum simulated lateness of ${maxLateness} minutes is high. Review slot density.`
    );
  }
  
  // Check ride density
  const premiumCount = rides.filter(r => r.planType === 'premium').length;
  const totalCount = rides.length;
  
  if (totalCount > 30 && premiumCount / totalCount < 0.5) {
    recommendations.push(
      `High non-premium ratio (${((totalCount - premiumCount) / totalCount * 100).toFixed(0)}%). Ensure Premium riders are prioritized.`
    );
  }
  
  if (recommendations.length === 0) {
    recommendations.push('Schedule looks healthy. All reliability targets are being met.');
  }
  
  return recommendations;
}

function generateCapacityAdjustments(
  date: string,
  runs: SimulationRunResult[],
  rides: ScheduledRide[]
): MonteCarloSummary['suggestedCapacityAdjustments'] {
  const adjustments: MonteCarloSummary['suggestedCapacityAdjustments'] = [];
  
  // Find rides that are frequently late
  const rideLateCounts = new Map<string, number>();
  
  for (const run of runs) {
    for (const result of run.rides) {
      if (!result.wasOnTime) {
        rideLateCounts.set(
          result.rideId,
          (rideLateCounts.get(result.rideId) || 0) + 1
        );
      }
    }
  }
  
  // Find slots with high late rates
  const slotLateCounts = new Map<string, { lateCount: number; totalCount: number }>();
  
  for (const [rideId, lateCount] of rideLateCounts) {
    const ride = rides.find(r => r.id === rideId);
    if (!ride || !ride.slotId) continue;
    
    if (!slotLateCounts.has(ride.slotId)) {
      slotLateCounts.set(ride.slotId, { lateCount: 0, totalCount: 0 });
    }
    
    const slot = slotLateCounts.get(ride.slotId)!;
    slot.lateCount += lateCount;
    slot.totalCount += runs.length;
  }
  
  // Generate adjustments for problematic slots
  for (const [slotId, counts] of slotLateCounts) {
    const lateRate = counts.lateCount / counts.totalCount;
    
    if (lateRate > 0.1) { // More than 10% late rate
      // Find the ride to get non-premium info
      const ride = rides.find(r => r.slotId === slotId && r.planType !== 'premium');
      
      if (ride) {
        adjustments.push({
          slot: slotId,
          currentNonPremium: 2, // Placeholder - would need actual value
          suggestedNonPremium: 1,
          reason: `${(lateRate * 100).toFixed(0)}% late rate in simulations`,
        });
      }
    }
  }
  
  return adjustments;
}

// =============================================================================
// Database Operations
// =============================================================================

/**
 * Create a simulation job
 */
export async function createSimulationJob(
  date: string,
  scenario: SimulationScenario,
  createdBy?: number
): Promise<string> {
  const jobId = `job_${uuidv4()}`;
  
  await pool.query(
    `
    INSERT INTO simulation_jobs (job_id, date, scenario, status, created_by)
    VALUES ($1, $2, $3, 'pending', $4)
    `,
    [jobId, date, JSON.stringify(scenario), createdBy]
  );
  
  return jobId;
}

/**
 * Run and save simulation job
 */
export async function runAndSaveSimulation(
  jobId: string,
  runCount: number = DEFAULT_RUN_COUNT
): Promise<MonteCarloSummary> {
  // Update status to running
  await pool.query(
    `UPDATE simulation_jobs SET status = 'running', started_at = now() WHERE job_id = $1`,
    [jobId]
  );
  
  try {
    // Get job info
    const jobResult = await pool.query(
      `SELECT date::text, scenario FROM simulation_jobs WHERE job_id = $1`,
      [jobId]
    );
    
    if (jobResult.rowCount === 0) {
      throw new Error('Job not found');
    }
    
    const { date, scenario } = jobResult.rows[0];
    
    // Run simulation
    const summary = await runMonteCarlo(date, scenario, runCount);
    summary.jobId = jobId;
    
    // Save results
    await pool.query(
      `
      UPDATE simulation_jobs 
      SET status = 'completed', completed_at = now(), results = $2, run_count = $3
      WHERE job_id = $1
      `,
      [jobId, JSON.stringify(summary), runCount]
    );
    
    // Update daily capacity summary with reliability score
    await pool.query(
      `
      UPDATE daily_capacity_summary
      SET reliability_score = $2, last_simulation_id = (
        SELECT id FROM simulation_jobs WHERE job_id = $1
      )
      WHERE date = $3
      `,
      [jobId, summary.premiumOnTimeRate, date]
    );
    
    return summary;
  } catch (err) {
    // Update status to failed
    await pool.query(
      `
      UPDATE simulation_jobs 
      SET status = 'failed', error_message = $2
      WHERE job_id = $1
      `,
      [jobId, err instanceof Error ? err.message : 'Unknown error']
    );
    throw err;
  }
}

/**
 * Get simulation results
 */
export async function getSimulationResults(jobId: string): Promise<MonteCarloSummary | null> {
  const result = await pool.query(
    `
    SELECT job_id, date::text, scenario, status, results, run_count, error_message
    FROM simulation_jobs
    WHERE job_id = $1
    `,
    [jobId]
  );
  
  if (result.rowCount === 0) return null;
  
  const row = result.rows[0];
  
  if (row.status !== 'completed' || !row.results) {
    return null;
  }
  
  return row.results as MonteCarloSummary;
}

/**
 * Get latest simulation for a date
 */
export async function getLatestSimulationForDate(date: string): Promise<MonteCarloSummary | null> {
  const result = await pool.query(
    `
    SELECT results
    FROM simulation_jobs
    WHERE date = $1 AND status = 'completed'
    ORDER BY completed_at DESC
    LIMIT 1
    `,
    [date]
  );
  
  if (result.rowCount === 0) return null;
  
  return result.rows[0].results as MonteCarloSummary;
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

function average(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function percentile(sortedArr: number[], p: number): number {
  if (sortedArr.length === 0) return 0;
  const index = Math.ceil((p / 100) * sortedArr.length) - 1;
  return sortedArr[Math.max(0, index)];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

