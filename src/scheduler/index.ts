/**
 * Scheduler Module Index
 * 
 * Export all scheduling engine components
 */

// Types
export type {
  Location,
  LocationWithAddress,
  TimeContext,
  WeatherCondition,
  TravelTimeStats,
  TravelTimeEstimate,
  RiderBehaviorStats,
  Direction,
  SlotType,
  PlanType,
  TimeSlot,
  TimeSlotAvailability,
  ScheduledRide,
  ScheduleState,
  RideRequest,
  FeasibilityResult,
  AvailabilityQuery,
  TimeWindowOption,
  SlotHold,
  CreateHoldRequest,
  ConfirmHoldResult,
  DailyCapacitySummary,
  HourlyCapacityBreakdown,
  SimulationScenario,
  SimulationRideResult,
  SimulationRunResult,
  MonteCarloSummary,
  AdminCapacityView,
  SchedulingConfig,
} from '../shared/schedulingTypes';

export { DEFAULT_SCHEDULING_CONFIG } from '../shared/schedulingTypes';

// Travel Time Model
export {
  estimateDistanceKm,
  getTrafficMultiplier,
  getTravelTimeStats,
  getTravelTimeEstimate,
  sampleTravelTimeMinutes,
  sampleTravelTimeBatch,
  createTimeContext,
  createTimeContextFromStrings,
  calculatePickupTime,
  meetsEarlyArrivalRule,
} from './travelTimeModel';

// Rider Behavior Model
export {
  getRiderBehaviorStats,
  getDefaultRiderBehaviorStats,
  updateRiderStats,
  sampleRiderReadyDelay,
  sampleRiderDelayBatch,
  getRiderReliabilityTier,
  calculateRiderBuffer,
} from './riderBehaviorModel';

// Time Slots
export {
  isInPeakWindow,
  getSlotType,
  generateSlotId,
  parseSlotId,
  generateBaseSlotsForDate,
  generateAllSlotsForDate,
  initializeSlotsForDate,
  getSlotsForDate,
  getSlotById,
  updateSlotCapacity,
  reserveSlotCapacity,
  releaseSlotCapacity,
  setSlotFragility,
  updateSlotMaxNonPremium,
  getSlotsWithAvailability,
  hasAvailability,
  getAvailableSlotsInRange,
  resetSlotsForDate,
  deleteSlotsForDate,
  getSlotSummaryForDate,
} from './timeSlots';

// Capacity Planner
export {
  getPremiumSubscriberCount,
  canAddPremiumSubscriber,
  incrementPremiumCount,
  decrementPremiumCount,
  computeDailyCapacity,
  getHourlyCapacityBreakdown,
  adjustNonPremiumCapacity,
  autoBalanceNonPremiumCapacity,
  checkHourlyCapacity,
  checkDailyCapacity,
  canAddPremiumRide,
  canAddNonPremiumRide,
  getCapacityUtilizationReport,
} from './capacityPlanner';

// Schedule State
export {
  getScheduleStateForDate,
  getRidesInTimeBlock,
  getRidesForSlot,
  getPremiumRidesForDate,
  getNonPremiumRidesForDate,
  getActiveHoldsForDate,
  SCHEDULE_BLOCKS,
  getBlockForTime,
  getRidesInBlock,
  sortRidesByArrival,
  groupRidesBySlot,
  calculateScheduleDensity,
  ridesConflict,
  findConflictingRides,
} from './scheduleState';

// Feasibility
export {
  canInsertRideIntoSlot,
  quickFeasibilityCheck,
  checkRiderConflicts,
  batchFeasibilityCheck,
  analyzeRideImpact,
  calculateLatestPickupTime,
  getMinTravelTime,
} from './feasibility';

// Availability
export {
  inferDirection,
  getAvailableArrivalWindows,
  getAvailableWindowsForRider,
  isSlotAvailableForRider,
  getAvailabilitySummary,
  getNextAvailableSlot,
} from './availability';

// Holds Service
export {
  createHold,
  confirmHold,
  cancelHold,
  expireHolds,
  getHoldById,
  getActiveHoldForRider,
  getActiveHoldsForSlot,
  getHoldStats,
} from './holdsService';

// Monte Carlo Simulation
export {
  runSingleSimulation,
  runMonteCarlo,
  createSimulationJob,
  runAndSaveSimulation,
  getSimulationResults,
  getLatestSimulationForDate,
} from './monteCarlo';

// Admin Dashboard
export {
  getAdminCapacityView,
  getQuickCapacityStats,
  getCapacityOverview,
  triggerSimulation,
  getSimulationHistory,
  getCapacityAlerts,
  exportCapacityData,
} from './adminCapacityDashboard';

