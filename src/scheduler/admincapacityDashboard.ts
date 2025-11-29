/**
 * Admin Capacity Dashboard Service
 * 
 * Provides comprehensive capacity views for admins:
 * - Daily capacity summaries
 * - Hourly breakdowns
 * - Peak vs off-peak analysis
 * - Simulation results integration
 */

import type {
  DailyCapacitySummary,
  AdminCapacityView,
  HourlyCapacityBreakdown,
  TimeSlot,
  MonteCarloSummary,
} from '../shared/schedulingTypes';
import { DEFAULT_SCHEDULING_CONFIG } from '../shared/schedulingTypes';
import {
  computeDailyCapacity,
  getHourlyCapacityBreakdown,
  getPremiumSubscriberCount,
} from './capacityPlanner';
import {
  getSlotsForDate,
  getSlotSummaryForDate,
} from './timeSlots';
import {
  getLatestSimulationForDate,
  runMonteCarlo,
  createSimulationJob,
  runAndSaveSimulation,
} from './monteCarlo';
import { pool } from '../db/pool';

// =============================================================================
// Constants
// =============================================================================

const PEAK_MORNING_START = DEFAULT_SCHEDULING_CONFIG.PEAK_MORNING_START;
const PEAK_MORNING_END = DEFAULT_SCHEDULING_CONFIG.PEAK_MORNING_END;
const PEAK_EVENING_START = DEFAULT_SCHEDULING_CONFIG.PEAK_EVENING_START;
const PEAK_EVENING_END = DEFAULT_SCHEDULING_CONFIG.PEAK_EVENING_END;

// =============================================================================
// Main Dashboard Functions
// =============================================================================

/**
 * Get full admin capacity view for a date
 */
export async function getAdminCapacityView(date: string): Promise<AdminCapacityView> {
  // Get basic summary
  const summary = await computeDailyCapacity(date);
  
  // Get hourly breakdown
  const hourlyBreakdown = await getHourlyCapacityBreakdown(date);
  
  // Get all slots
  const slots = await getSlotsForDate(date);
  
  // Organize into peak and off-peak blocks
  const peakBlocks = organizePeakBlocks(slots);
  const offPeakBlocks = organizeOffPeakBlocks(slots);
  
  // Get latest simulation
  const lastSimulation = await getLatestSimulationForDate(date);
  
  return {
    date,
    summary,
    hourlyBreakdown,
    peakBlocks,
    offPeakBlocks,
    lastSimulation: lastSimulation || undefined,
  };
}

/**
 * Organize slots into peak blocks
 */
function organizePeakBlocks(slots: TimeSlot[]): AdminCapacityView['peakBlocks'] {
  return {
    morning: {
      startTime: PEAK_MORNING_START,
      endTime: PEAK_MORNING_END,
      slots: slots.filter(s => 
        s.slotType === 'peak' && 
        timeToMinutes(s.arrivalStart) >= timeToMinutes(PEAK_MORNING_START) &&
        timeToMinutes(s.arrivalStart) < timeToMinutes(PEAK_MORNING_END)
      ),
    },
    evening: {
      startTime: PEAK_EVENING_START,
      endTime: PEAK_EVENING_END,
      slots: slots.filter(s =>
        s.slotType === 'peak' &&
        timeToMinutes(s.arrivalStart) >= timeToMinutes(PEAK_EVENING_START) &&
        timeToMinutes(s.arrivalStart) < timeToMinutes(PEAK_EVENING_END)
      ),
    },
  };
}

/**
 * Organize off-peak slots into contiguous blocks
 */
function organizeOffPeakBlocks(slots: TimeSlot[]): AdminCapacityView['offPeakBlocks'] {
  const offPeakSlots = slots.filter(s => s.slotType === 'off_peak');
  
  if (offPeakSlots.length === 0) return [];
  
  // Sort by time
  offPeakSlots.sort((a: TimeSlot, b: TimeSlot) => 
    timeToMinutes(a.arrivalStart) - timeToMinutes(b.arrivalStart)
  );
  
  // Group into contiguous blocks
  const blocks: AdminCapacityView['offPeakBlocks'] = [];
  let currentBlock: TimeSlot[] = [];
  let blockStart = '';
  
  for (const slot of offPeakSlots) {
    if (currentBlock.length === 0) {
      blockStart = slot.arrivalStart;
      currentBlock.push(slot);
    } else {
      const lastSlot = currentBlock[currentBlock.length - 1];
      const lastEnd = timeToMinutes(lastSlot.arrivalEnd);
      const currentStart = timeToMinutes(slot.arrivalStart);
      
      // If there's a gap (e.g., peak window in between)
      if (currentStart - lastEnd > 5) {
        // Save current block
        blocks.push({
          startTime: blockStart,
          endTime: lastSlot.arrivalEnd,
          slots: currentBlock,
        });
        // Start new block
        blockStart = slot.arrivalStart;
        currentBlock = [slot];
      } else {
        currentBlock.push(slot);
      }
    }
  }
  
  // Don't forget the last block
  if (currentBlock.length > 0) {
    blocks.push({
      startTime: blockStart,
      endTime: currentBlock[currentBlock.length - 1].arrivalEnd,
      slots: currentBlock,
    });
  }
  
  return blocks;
}

// =============================================================================
// Quick Summary Functions
// =============================================================================

/**
 * Get quick capacity stats for dashboard header
 */
export async function getQuickCapacityStats(date: string): Promise<{
  premiumSubscribers: number;
  maxPremiumSubscribers: number;
  premiumRidesToday: number;
  nonPremiumRidesToday: number;
  totalCapacity: number;
  usedCapacity: number;
  utilizationRate: number;
}> {
  const summary = await computeDailyCapacity(date);
  const subscriberCount = await getPremiumSubscriberCount();
  
  const totalCapacity = summary.premiumCapacity + summary.nonPremiumCapacityComputed;
  const usedCapacity = summary.premiumBookedCount + summary.nonPremiumBookedCount;
  
  return {
    premiumSubscribers: subscriberCount,
    maxPremiumSubscribers: DEFAULT_SCHEDULING_CONFIG.MAX_PREMIUM_SUBSCRIBERS,
    premiumRidesToday: summary.premiumBookedCount,
    nonPremiumRidesToday: summary.nonPremiumBookedCount,
    totalCapacity,
    usedCapacity,
    utilizationRate: totalCapacity > 0 ? usedCapacity / totalCapacity : 0,
  };
}

/**
 * Get multi-day capacity overview
 */
export async function getCapacityOverview(
  startDate: string,
  days: number = 7
): Promise<Array<{
  date: string;
  premiumBooked: number;
  premiumCapacity: number;
  nonPremiumBooked: number;
  nonPremiumCapacity: number;
  reliabilityScore?: number;
}>> {
  const results: Array<{
    date: string;
    premiumBooked: number;
    premiumCapacity: number;
    nonPremiumBooked: number;
    nonPremiumCapacity: number;
    reliabilityScore?: number;
  }> = [];
  
  const start = new Date(startDate);
  
  for (let i = 0; i < days; i++) {
    const date = new Date(start);
    date.setDate(date.getDate() + i);
    const dateStr = date.toISOString().slice(0, 10);
    
    const summary = await computeDailyCapacity(dateStr);
    
    results.push({
      date: dateStr,
      premiumBooked: summary.premiumBookedCount,
      premiumCapacity: summary.premiumCapacity,
      nonPremiumBooked: summary.nonPremiumBookedCount,
      nonPremiumCapacity: summary.nonPremiumCapacityComputed,
      reliabilityScore: summary.reliabilityScore,
    });
  }
  
  return results;
}

// =============================================================================
// Simulation Management
// =============================================================================

/**
 * Trigger a new simulation for a date
 */
export async function triggerSimulation(
  date: string,
  scenario: any = {},
  createdBy?: number
): Promise<{
  jobId: string;
  summary: MonteCarloSummary;
}> {
  // Create job
  const jobId = await createSimulationJob(date, scenario, createdBy);
  
  // Run simulation
  const summary = await runAndSaveSimulation(jobId);
  
  return { jobId, summary };
}

/**
 * Get simulation history for a date
 */
export async function getSimulationHistory(
  date: string,
  limit: number = 10
): Promise<Array<{
  jobId: string;
  status: string;
  createdAt: string;
  completedAt?: string;
  runCount: number;
  premiumOnTimeRate?: number;
}>> {
  const result = await pool.query(
    `
    SELECT 
      job_id,
      status,
      created_at,
      completed_at,
      run_count,
      results->'premiumOnTimeRate' as premium_on_time_rate
    FROM simulation_jobs
    WHERE date = $1
    ORDER BY created_at DESC
    LIMIT $2
    `,
    [date, limit]
  );
  
  return result.rows.map((row: any) => ({
    jobId: row.job_id,
    status: row.status,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    runCount: row.run_count,
    premiumOnTimeRate: row.premium_on_time_rate,
  }));
}

// =============================================================================
// Capacity Alerts
// =============================================================================

/**
 * Check for capacity issues and return alerts
 */
export async function getCapacityAlerts(date: string): Promise<Array<{
  level: 'info' | 'warning' | 'critical';
  message: string;
  slot?: string;
}>> {
  const alerts: Array<{ level: 'info' | 'warning' | 'critical'; message: string; slot?: string }> = [];
  
  const summary = await computeDailyCapacity(date);
  const slotSummary = await getSlotSummaryForDate(date);
  
  // Check overall capacity
  const totalUtilization = (summary.premiumBookedCount + summary.nonPremiumBookedCount) /
    (summary.premiumCapacity + summary.nonPremiumCapacityComputed);
  
  if (totalUtilization > 0.9) {
    alerts.push({
      level: 'warning',
      message: `High overall utilization (${(totalUtilization * 100).toFixed(0)}%). Consider limiting new bookings.`,
    });
  }
  
  // Check Premium capacity
  if (summary.premiumRemainingSlots <= 2) {
    alerts.push({
      level: 'warning',
      message: `Only ${summary.premiumRemainingSlots} Premium slots remaining for ${date}.`,
    });
  }
  
  // Check reliability
  if (summary.reliabilityScore !== undefined && summary.reliabilityScore < 0.95) {
    alerts.push({
      level: 'critical',
      message: `Reliability score (${(summary.reliabilityScore * 100).toFixed(1)}%) is below target. Run simulation for details.`,
    });
  }
  
  // Check for fragile slots
  const slots = await getSlotsForDate(date);
  const fragileSlots = slots.filter(s => s.fragile);
  
  if (fragileSlots.length > 0) {
    alerts.push({
      level: 'info',
      message: `${fragileSlots.length} slot(s) marked as fragile - Premium only recommended.`,
    });
  }
  
  return alerts;
}

// =============================================================================
// Export Helpers
// =============================================================================

/**
 * Export capacity data as CSV-ready format
 */
export async function exportCapacityData(date: string): Promise<{
  headers: string[];
  rows: string[][];
}> {
  const slots = await getSlotsForDate(date);
  
  const headers = [
    'Slot ID',
    'Time',
    'Type',
    'Premium Max',
    'Premium Used',
    'Non-Premium Max',
    'Non-Premium Used',
    'Fragile',
  ];
  
  const rows = slots.map(slot => [
    slot.slotId,
    `${slot.arrivalStart}-${slot.arrivalEnd}`,
    slot.slotType,
    slot.maxRidersPremium.toString(),
    slot.usedRidersPremium.toString(),
    slot.maxRidersNonPremium.toString(),
    slot.usedRidersNonPremium.toString(),
    slot.fragile ? 'Yes' : 'No',
  ]);
  
  return { headers, rows };
}

// =============================================================================
// Utility Functions
// =============================================================================

function timeToMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

