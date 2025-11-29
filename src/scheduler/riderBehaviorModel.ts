/**
 * Rider Behavior Model
 * 
 * Models rider behavior patterns for:
 * - Ready delay (how long after pickup window they're actually ready)
 * - No-show probability
 * - Reliability scoring
 * 
 * V1: Uses static defaults
 * Future: Will incorporate historical data
 */

import type {
  RiderBehaviorStats,
  TimeContext,
} from '../shared/schedulingTypes';
import { pool } from '../db/pool';

// =============================================================================
// Default Statistics
// =============================================================================

// FIXED: Added minimum walk time for building exit (elevators, walking to curb)
const MIN_RIDER_WALK_TIME = 1.5;  // minutes

const DEFAULT_RIDER_STATS: RiderBehaviorStats = {
  expectedReadyDelayMinutes: 2 + MIN_RIDER_WALK_TIME,  // FIXED: Added walk time
  stdReadyDelayMinutes: 1.5,         // Standard deviation
  p95ReadyDelayMinutes: 5 + MIN_RIDER_WALK_TIME,  // FIXED: Added walk time
  noShowProbability: 0.05,           // 5% no-show rate
  reliabilityScore: 0.9,             // 90% base reliability
};

// Time-of-day adjustments for rider behavior
const TIME_OF_DAY_DELAY_ADJUSTMENTS: Record<string, number> = {
  // Morning rush - people tend to be more punctual
  'early_morning': -0.5,  // 05:00-07:00
  'morning_rush': 0,      // 07:00-10:00
  // Mid-day - slightly less punctual
  'mid_day': 0.5,         // 10:00-15:00
  // Evening rush - more variable
  'evening_rush': 1.0,    // 15:00-18:00
  // Evening - less punctual
  'evening': 1.5,         // 18:00-22:00
  'late_night': 2.0,      // 22:00-05:00
};

// =============================================================================
// Time Period Classification
// =============================================================================

function getTimePeriod(hour: number): string {
  if (hour >= 5 && hour < 7) return 'early_morning';
  if (hour >= 7 && hour < 10) return 'morning_rush';
  if (hour >= 10 && hour < 15) return 'mid_day';
  if (hour >= 15 && hour < 18) return 'evening_rush';
  if (hour >= 18 && hour < 22) return 'evening';
  return 'late_night';
}

// =============================================================================
// Core Functions
// =============================================================================

/**
 * Get rider behavior statistics
 * 
 * V1: Returns static defaults with time-of-day adjustments
 * Future: Will incorporate historical rider data
 */
export async function getRiderBehaviorStats(
  riderId: string,
  ctx: TimeContext
): Promise<RiderBehaviorStats> {
  // Try to get historical stats from database
  const historicalStats = await getHistoricalRiderStats(riderId);
  
  // Start with defaults or historical data
  const baseStats = historicalStats || { ...DEFAULT_RIDER_STATS };
  
  // Apply time-of-day adjustments
  const hour = parseInt(ctx.time.split(':')[0], 10);
  const period = getTimePeriod(hour);
  const delayAdjustment = TIME_OF_DAY_DELAY_ADJUSTMENTS[period] ?? 0;
  
  return {
    ...baseStats,
    expectedReadyDelayMinutes: Math.max(0, baseStats.expectedReadyDelayMinutes + delayAdjustment),
    p95ReadyDelayMinutes: Math.max(0, baseStats.p95ReadyDelayMinutes + delayAdjustment),
  };
}

/**
 * Get static default rider behavior stats (no async, no DB call)
 */
export function getDefaultRiderBehaviorStats(ctx: TimeContext): RiderBehaviorStats {
  const hour = parseInt(ctx.time.split(':')[0], 10);
  const period = getTimePeriod(hour);
  const delayAdjustment = TIME_OF_DAY_DELAY_ADJUSTMENTS[period] ?? 0;
  
  return {
    ...DEFAULT_RIDER_STATS,
    expectedReadyDelayMinutes: Math.max(0, DEFAULT_RIDER_STATS.expectedReadyDelayMinutes + delayAdjustment),
    p95ReadyDelayMinutes: Math.max(0, DEFAULT_RIDER_STATS.p95ReadyDelayMinutes + delayAdjustment),
  };
}

// =============================================================================
// Historical Data Functions
// =============================================================================

/**
 * Get historical rider stats from database
 */
async function getHistoricalRiderStats(riderId: string): Promise<RiderBehaviorStats | null> {
  try {
    const result = await pool.query(
      `
      SELECT 
        avg_ready_delay_minutes,
        std_ready_delay_minutes,
        reliability_score,
        no_shows::float / NULLIF(total_rides, 0) as no_show_rate,
        total_rides
      FROM rider_behavior_stats
      WHERE rider_id = $1
      `,
      [riderId]
    );
    
    if (result.rowCount === 0) {
      return null;
    }
    
    const row = result.rows[0];
    
    // Need at least 5 rides for meaningful stats
    if (row.total_rides < 5) {
      return null;
    }
    
    const avgDelay = row.avg_ready_delay_minutes || DEFAULT_RIDER_STATS.expectedReadyDelayMinutes;
    const stdDelay = row.std_ready_delay_minutes || DEFAULT_RIDER_STATS.stdReadyDelayMinutes;
    
    return {
      expectedReadyDelayMinutes: avgDelay,
      stdReadyDelayMinutes: stdDelay,
      p95ReadyDelayMinutes: avgDelay + 1.645 * stdDelay, // Approximate P95
      noShowProbability: row.no_show_rate || DEFAULT_RIDER_STATS.noShowProbability,
      reliabilityScore: row.reliability_score || DEFAULT_RIDER_STATS.reliabilityScore,
    };
  } catch (err) {
    console.error('Failed to get historical rider stats:', err);
    return null;
  }
}

/**
 * Update rider behavior stats after a completed ride
 */
export async function updateRiderStats(
  riderId: string,
  actualReadyDelayMinutes: number,
  wasNoShow: boolean
): Promise<void> {
  try {
    await pool.query(
      `
      INSERT INTO rider_behavior_stats (rider_id, total_rides, no_shows, avg_ready_delay_minutes)
      VALUES ($1, 1, $2, $3)
      ON CONFLICT (rider_id) DO UPDATE SET
        total_rides = rider_behavior_stats.total_rides + 1,
        no_shows = rider_behavior_stats.no_shows + $2,
        on_time_pickups = CASE 
          WHEN $3 <= 2 THEN rider_behavior_stats.on_time_pickups + 1 
          ELSE rider_behavior_stats.on_time_pickups 
        END,
        late_pickups = CASE 
          WHEN $3 > 2 THEN rider_behavior_stats.late_pickups + 1 
          ELSE rider_behavior_stats.late_pickups 
        END,
        avg_ready_delay_minutes = (
          rider_behavior_stats.avg_ready_delay_minutes * rider_behavior_stats.total_rides + $3
        ) / (rider_behavior_stats.total_rides + 1),
        max_ready_delay_minutes = GREATEST(rider_behavior_stats.max_ready_delay_minutes, $3),
        reliability_score = CASE
          WHEN rider_behavior_stats.total_rides + 1 >= 5 THEN
            1.0 - (rider_behavior_stats.no_shows + $2::int)::float / (rider_behavior_stats.total_rides + 1)
          ELSE rider_behavior_stats.reliability_score
        END,
        updated_at = now()
      `,
      [riderId, wasNoShow ? 1 : 0, actualReadyDelayMinutes]
    );
  } catch (err) {
    console.error('Failed to update rider stats:', err);
  }
}

// =============================================================================
// Monte Carlo Sampling
// =============================================================================

/**
 * Box-Muller transform for normal distribution sampling
 */
function sampleNormal(mean: number, std: number): number {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + z * std;
}

/**
 * Sample rider ready delay for Monte Carlo simulation
 */
export function sampleRiderReadyDelay(
  stats: RiderBehaviorStats,
  varianceLevel: 'low' | 'medium' | 'high' = 'medium'
): { delayMinutes: number; isNoShow: boolean } {
  // Check for no-show
  if (Math.random() < stats.noShowProbability) {
    return { delayMinutes: 0, isNoShow: true };
  }
  
  // Variance multiplier based on scenario
  const varianceMultipliers: Record<string, number> = {
    low: 0.7,
    medium: 1.0,
    high: 1.5,
  };
  
  const adjustedStd = stats.stdReadyDelayMinutes * varianceMultipliers[varianceLevel];
  
  // Sample delay from normal distribution
  let delayMinutes = sampleNormal(stats.expectedReadyDelayMinutes, adjustedStd);
  
  // Clamp to reasonable bounds (can be early, but not infinitely late)
  delayMinutes = Math.max(-3, Math.min(15, delayMinutes));
  
  return {
    delayMinutes: Math.round(delayMinutes * 10) / 10,
    isNoShow: false,
  };
}

/**
 * Sample multiple rider delays for Monte Carlo analysis
 */
export function sampleRiderDelayBatch(
  stats: RiderBehaviorStats,
  count: number,
  varianceLevel: 'low' | 'medium' | 'high' = 'medium'
): { delayMinutes: number; isNoShow: boolean }[] {
  const samples: { delayMinutes: number; isNoShow: boolean }[] = [];
  for (let i = 0; i < count; i++) {
    samples.push(sampleRiderReadyDelay(stats, varianceLevel));
  }
  return samples;
}

// =============================================================================
// Premium vs Standard Rider Analysis
// =============================================================================

/**
 * Get rider reliability tier based on historical performance
 */
export async function getRiderReliabilityTier(
  riderId: string
): Promise<'excellent' | 'good' | 'average' | 'poor' | 'unknown'> {
  try {
    const result = await pool.query(
      `
      SELECT reliability_score, total_rides
      FROM rider_behavior_stats
      WHERE rider_id = $1
      `,
      [riderId]
    );
    
    if (result.rowCount === 0 || result.rows[0].total_rides < 5) {
      return 'unknown';
    }
    
    const score = result.rows[0].reliability_score;
    
    if (score >= 0.98) return 'excellent';
    if (score >= 0.92) return 'good';
    if (score >= 0.8) return 'average';
    return 'poor';
  } catch (err) {
    console.error('Failed to get rider reliability tier:', err);
    return 'unknown';
  }
}

/**
 * Calculate expected buffer needed for a rider
 * Higher buffer for less reliable riders
 */
export function calculateRiderBuffer(stats: RiderBehaviorStats): number {
  // Base buffer is P95 delay
  const baseBuffer = stats.p95ReadyDelayMinutes;
  
  // Add extra buffer for less reliable riders
  const reliabilityPenalty = (1 - stats.reliabilityScore) * 5; // Up to 5 extra minutes
  
  return Math.round((baseBuffer + reliabilityPenalty) * 10) / 10;
}

