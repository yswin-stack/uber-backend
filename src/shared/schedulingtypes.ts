/**
 * Shared TypeScript types for the Scheduling & Reliability Engine
 * 
 * This module defines all types for:
 * - Time slots and capacity management
 * - Premium vs Non-Premium riders
 * - Feasibility checking
 * - Monte Carlo simulation
 */

// =============================================================================
// Core Location Types
// =============================================================================

export interface Location {
  lat: number;
  lng: number;
}

export interface LocationWithAddress extends Location {
  address?: string;
}

// =============================================================================
// Time Context
// =============================================================================

export interface TimeContext {
  date: string;           // YYYY-MM-DD
  time: string;           // HH:mm
  dayOfWeek: number;      // 0-6 (Sunday = 0)
  weather?: WeatherCondition;
}

export type WeatherCondition = 'clear' | 'rain' | 'snow' | 'storm';

// =============================================================================
// Travel Time Model Types
// =============================================================================

export interface TravelTimeStats {
  meanMinutes: number;
  p95Minutes: number;
  stdMinutes: number;
}

export interface TravelTimeEstimate extends TravelTimeStats {
  distanceKm: number;
  trafficMultiplier: number;
}

// =============================================================================
// Rider Behavior Types
// =============================================================================

export interface RiderBehaviorStats {
  expectedReadyDelayMinutes: number;
  stdReadyDelayMinutes: number;
  p95ReadyDelayMinutes: number;
  noShowProbability: number;
  reliabilityScore: number; // 0-1
}

// =============================================================================
// Plan & Slot Types
// =============================================================================

export type Direction =
  | 'home_to_campus'
  | 'campus_to_home'
  | 'home_to_work'
  | 'work_to_home'
  | 'other';

export type SlotType = 'peak' | 'off_peak';

export type PlanType = 'premium' | 'standard' | 'off_peak';

export interface TimeSlot {
  slotId: string;
  date: string;             // YYYY-MM-DD
  direction: Direction;
  slotType: SlotType;
  arrivalStart: string;     // 'HH:mm'
  arrivalEnd: string;       // 'HH:mm'
  maxRidersPremium: number;
  usedRidersPremium: number;
  maxRidersNonPremium: number;
  usedRidersNonPremium: number;
  fragile: boolean;
}

export interface TimeSlotAvailability extends TimeSlot {
  availablePremium: number;
  availableNonPremium: number;
}

// =============================================================================
// Scheduled Ride Types
// =============================================================================

export interface ScheduledRide {
  id: string;
  riderId: string;
  date: string;
  slotId: string;
  planType: PlanType;
  arrivalStart: string;     // 'HH:mm'
  arrivalEnd: string;       // 'HH:mm'
  originLocation: Location;
  destinationLocation: Location;
  originAddress?: string;
  destinationAddress?: string;
  pickupTime?: string;      // ISO string
  predictedArrival?: string; // ISO string
}

export interface ScheduleState {
  date: string;
  rides: ScheduledRide[];
}

// =============================================================================
// Feasibility Types
// =============================================================================

export interface RideRequest {
  riderId: string;
  date: string;
  originLocation: Location;
  destinationLocation: Location;
  originAddress?: string;
  destinationAddress?: string;
  planType: PlanType;
  desiredArrival?: string;  // 'HH:mm'
}

export interface FeasibilityResult {
  feasible: boolean;
  reason?: string;
  predictedArrival?: string;
  bufferMinutes?: number;
  riskLevel?: 'low' | 'medium' | 'high';
}

// =============================================================================
// Availability Types
// =============================================================================

export interface AvailabilityQuery {
  date: string;
  originLocation: Location;
  destinationLocation: Location;
  planType: PlanType;
  desiredArrival?: string;  // 'HH:mm'
}

export interface TimeWindowOption {
  slotId: string;
  arrivalStart: string;     // 'HH:mm'
  arrivalEnd: string;       // 'HH:mm'
  risk: 'low' | 'medium' | 'high';
  estimatedPickupTime?: string; // 'HH:mm'
}

// =============================================================================
// Hold Types
// =============================================================================

export interface SlotHold {
  holdId: string;
  slotId: string;
  riderId: string;
  planType: PlanType;
  originLocation: Location;
  destinationLocation: Location;
  originAddress?: string;
  destinationAddress?: string;
  createdAt: string;        // ISO string
  expiresAt: string;        // ISO string
  status: 'active' | 'confirmed' | 'expired' | 'cancelled';
}

export interface CreateHoldRequest {
  slotId: string;
  riderId: string;
  planType: PlanType;
  originLocation: Location;
  destinationLocation: Location;
  originAddress?: string;
  destinationAddress?: string;
}

export interface ConfirmHoldResult {
  success: boolean;
  ride?: ScheduledRide;
  error?: string;
}

// =============================================================================
// Capacity Types
// =============================================================================

export interface DailyCapacitySummary {
  date: string;
  premiumCapacity: number;         // Always 20
  premiumBookedCount: number;
  premiumRemainingSlots: number;
  nonPremiumCapacityComputed: number;
  nonPremiumBookedCount: number;
  nonPremiumRemainingSlots: number;
  slots: TimeSlot[];
  reliabilityScore?: number;       // 0-1 from Monte Carlo
}

export interface HourlyCapacityBreakdown {
  hour: string;                    // 'HH:00'
  slotType: SlotType;
  premiumSlots: number;
  premiumUsed: number;
  nonPremiumSlots: number;
  nonPremiumUsed: number;
}

// =============================================================================
// Monte Carlo Simulation Types
// =============================================================================

export interface SimulationScenario {
  trafficVariance?: 'low' | 'medium' | 'high';
  riderDelayVariance?: 'low' | 'medium' | 'high';
  weather?: WeatherCondition;
  customMultipliers?: {
    travelTime?: number;
    riderDelay?: number;
  };
}

export interface SimulationRideResult {
  rideId: string;
  plannedArrival: string;
  simulatedArrival: string;
  latenessMinutes: number;
  wasOnTime: boolean;        // arrived <= arrivalEnd - 5min
  planType: PlanType;
}

export interface SimulationRunResult {
  runIndex: number;
  rides: SimulationRideResult[];
  premiumOnTimeCount: number;
  premiumTotalCount: number;
  nonPremiumOnTimeCount: number;
  nonPremiumTotalCount: number;
  maxLatenessMinutes: number;
}

export interface MonteCarloSummary {
  jobId: string;
  date: string;
  runCount: number;
  scenario: SimulationScenario;
  
  // Premium stats
  premiumOnTimeRate: number;      // 0-1
  premiumOnTimeRateP95: number;   // 95th percentile
  premiumWorstRunRate: number;    // worst single run
  
  // Non-Premium stats
  nonPremiumOnTimeRate: number;
  nonPremiumOnTimeRateP95: number;
  nonPremiumWorstRunRate: number;
  
  // Overall
  maxLatenessMinutes: number;
  avgMaxLateness: number;
  
  // Recommendations
  recommendations: string[];
  suggestedCapacityAdjustments?: {
    slot: string;
    currentNonPremium: number;
    suggestedNonPremium: number;
    reason: string;
  }[];
}

// =============================================================================
// Admin Dashboard Types
// =============================================================================

export interface AdminCapacityView {
  date: string;
  summary: DailyCapacitySummary;
  hourlyBreakdown: HourlyCapacityBreakdown[];
  peakBlocks: {
    morning: {
      startTime: string;
      endTime: string;
      slots: TimeSlot[];
    };
    evening: {
      startTime: string;
      endTime: string;
      slots: TimeSlot[];
    };
  };
  offPeakBlocks: {
    startTime: string;
    endTime: string;
    slots: TimeSlot[];
  }[];
  lastSimulation?: MonteCarloSummary;
}

// =============================================================================
// Configuration Constants (can be overridden in DB)
// =============================================================================

export interface SchedulingConfig {
  // Capacity limits
  MAX_PREMIUM_SUBSCRIBERS: number;
  MAX_RIDERS_PER_RIDE: number;
  MAX_RIDES_PER_HOUR: number;
  MAX_RIDES_PER_DAY: number;
  
  // Time windows
  PEAK_MORNING_START: string;
  PEAK_MORNING_END: string;
  PEAK_EVENING_START: string;
  PEAK_EVENING_END: string;
  
  // Timing rules
  ARRIVE_EARLY_MINUTES: number;      // 5 min early rule
  HOLD_EXPIRY_MINUTES: number;       // 5 min hold
  SLOT_WINDOW_MINUTES: number;       // 5 min slot windows
  
  // Planning parameters
  TRAVEL_TIME_SAFETY_MULTIPLIER: number;
  DEFAULT_RIDER_DELAY_MINUTES: number;
  
  // Reliability targets
  PREMIUM_ON_TIME_TARGET: number;    // 0.99
  NON_PREMIUM_ON_TIME_TARGET: number; // 0.95
  
  // Monte Carlo
  MONTE_CARLO_DEFAULT_RUNS: number;
}

export const DEFAULT_SCHEDULING_CONFIG: SchedulingConfig = {
  MAX_PREMIUM_SUBSCRIBERS: 20,
  MAX_RIDERS_PER_RIDE: 2,
  MAX_RIDES_PER_HOUR: 3,
  MAX_RIDES_PER_DAY: 40,
  
  PEAK_MORNING_START: '07:00',
  PEAK_MORNING_END: '10:00',
  PEAK_EVENING_START: '15:00',
  PEAK_EVENING_END: '18:00',
  
  ARRIVE_EARLY_MINUTES: 5,
  HOLD_EXPIRY_MINUTES: 5,
  SLOT_WINDOW_MINUTES: 5,
  
  TRAVEL_TIME_SAFETY_MULTIPLIER: 1.3,
  DEFAULT_RIDER_DELAY_MINUTES: 2,
  
  PREMIUM_ON_TIME_TARGET: 0.99,
  NON_PREMIUM_ON_TIME_TARGET: 0.95,
  
  MONTE_CARLO_DEFAULT_RUNS: 1000,
};

