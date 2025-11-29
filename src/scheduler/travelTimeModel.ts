/**
 * Travel Time Model
 * 
 * Provides travel time estimation between locations with:
 * - Distance calculation (Haversine)
 * - Mean/P95/Std travel time stats
 * - Traffic multipliers based on time of day
 * - Monte Carlo sampling for simulations
 */

import type {
  Location,
  TimeContext,
  TravelTimeStats,
  TravelTimeEstimate,
  WeatherCondition,
} from '../shared/schedulingTypes';
import { DEFAULT_SCHEDULING_CONFIG } from '../shared/schedulingTypes';

// =============================================================================
// Constants
// =============================================================================

// Base speed assumptions (km/h)
// FIXED: Reduced from 35 to 28 km/h for more realistic city driving
const BASE_SPEED_KMH = 28;           // Average urban speed with stops/lights
const MIN_SPEED_KMH = 12;            // Heavy traffic
const MAX_SPEED_KMH = 45;            // Free-flowing traffic

// FIXED: Road distance factor - roads are ~1.3x longer than straight-line
const ROAD_DISTANCE_FACTOR = 1.3;

// FIXED: Pembina Highway corridor coordinates (heavy traffic zone)
const PEMBINA_HWY_CORRIDOR = {
  minLat: 49.80,
  maxLat: 49.90,
  minLng: -97.16,
  maxLng: -97.13,
};

// Traffic multipliers by hour (0-23)
// Higher = more travel time
// FIXED: Increased peak hour multipliers for Winnipeg reality
const HOURLY_TRAFFIC_MULTIPLIERS: Record<number, number> = {
  0: 0.8, 1: 0.8, 2: 0.8, 3: 0.8, 4: 0.8, 5: 0.85,
  6: 1.0, 7: 1.35, 8: 1.5, 9: 1.4,  // Morning rush - INCREASED
  10: 1.05, 11: 1.0, 12: 1.15, 13: 1.1, 14: 1.05,
  15: 1.25, 16: 1.45, 17: 1.55, 18: 1.4,  // Evening rush - INCREASED
  19: 1.15, 20: 1.0, 21: 0.95, 22: 0.9, 23: 0.85,
};

// Weather multipliers
const WEATHER_MULTIPLIERS: Record<WeatherCondition, number> = {
  clear: 1.0,
  rain: 1.2,
  snow: 1.5,
  storm: 1.8,
};

// Day of week multipliers (0 = Sunday)
const DAY_OF_WEEK_MULTIPLIERS: Record<number, number> = {
  0: 0.85,  // Sunday - less traffic
  1: 1.0,   // Monday
  2: 1.0,   // Tuesday
  3: 1.0,   // Wednesday
  4: 1.05,  // Thursday - slightly more
  5: 1.1,   // Friday - more traffic
  6: 0.9,   // Saturday - less traffic
};

// =============================================================================
// Distance Calculation
// =============================================================================

/**
 * Calculate straight-line distance using Haversine formula
 */
function haversineDistanceKm(origin: Location, destination: Location): number {
  const R = 6371; // Earth radius in km
  const toRad = (value: number) => (value * Math.PI) / 180;

  const dLat = toRad(destination.lat - origin.lat);
  const dLon = toRad(destination.lng - origin.lng);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(origin.lat)) *
      Math.cos(toRad(destination.lat)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Check if a route passes through the Pembina Highway corridor
 * This is a heavy traffic zone near University of Manitoba
 */
function isInPembinaCoridor(origin: Location, destination: Location): boolean {
  // Check if either endpoint is in the Pembina corridor
  const originInCorridor = 
    origin.lat >= PEMBINA_HWY_CORRIDOR.minLat &&
    origin.lat <= PEMBINA_HWY_CORRIDOR.maxLat &&
    origin.lng >= PEMBINA_HWY_CORRIDOR.minLng &&
    origin.lng <= PEMBINA_HWY_CORRIDOR.maxLng;
    
  const destInCorridor = 
    destination.lat >= PEMBINA_HWY_CORRIDOR.minLat &&
    destination.lat <= PEMBINA_HWY_CORRIDOR.maxLat &&
    destination.lng >= PEMBINA_HWY_CORRIDOR.minLng &&
    destination.lng <= PEMBINA_HWY_CORRIDOR.maxLng;
    
  return originInCorridor || destInCorridor;
}

/**
 * Calculate estimated road distance between two points
 * FIXED: Applies road factor to convert straight-line to actual road distance
 */
export function estimateDistanceKm(origin: Location, destination: Location): number {
  const straightLine = haversineDistanceKm(origin, destination);
  // Apply road distance factor (roads are ~1.3x longer than straight line)
  return straightLine * ROAD_DISTANCE_FACTOR;
}

// =============================================================================
// Traffic Multiplier Calculation
// =============================================================================

/**
 * Parse "HH:mm" time string to hour number
 */
function parseHour(time: string): number {
  const parts = time.split(':');
  return parseInt(parts[0], 10);
}

/**
 * Get combined traffic multiplier based on time context
 */
export function getTrafficMultiplier(ctx: TimeContext): number {
  const hour = parseHour(ctx.time);
  
  // Get hourly multiplier (default to 1.0 if not found)
  const hourlyMult = HOURLY_TRAFFIC_MULTIPLIERS[hour] ?? 1.0;
  
  // Get day of week multiplier
  const dayMult = DAY_OF_WEEK_MULTIPLIERS[ctx.dayOfWeek] ?? 1.0;
  
  // Get weather multiplier
  const weatherMult = ctx.weather ? WEATHER_MULTIPLIERS[ctx.weather] : 1.0;
  
  return hourlyMult * dayMult * weatherMult;
}

/**
 * Get traffic multiplier with location awareness
 * FIXED: Adds extra multiplier for Pembina Highway corridor during peak hours
 */
export function getTrafficMultiplierWithLocation(
  ctx: TimeContext,
  origin: Location,
  destination: Location
): number {
  const baseMult = getTrafficMultiplier(ctx);
  
  // Check if route is in Pembina Highway corridor
  if (isInPembinaCoridor(origin, destination)) {
    const hour = parseHour(ctx.time);
    // Add extra 0.2 multiplier during peak hours on Pembina
    if ((hour >= 7 && hour < 10) || (hour >= 15 && hour < 18)) {
      return baseMult + 0.2;
    }
  }
  
  return baseMult;
}

// =============================================================================
// Travel Time Statistics
// =============================================================================

/**
 * Get travel time statistics for a route
 */
export function getTravelTimeStats(
  origin: Location,
  destination: Location,
  ctx: TimeContext
): TravelTimeStats {
  const distanceKm = estimateDistanceKm(origin, destination);
  const trafficMult = getTrafficMultiplier(ctx);
  
  // Calculate effective speed based on traffic
  const effectiveSpeedKmh = BASE_SPEED_KMH / trafficMult;
  
  // Mean travel time in minutes
  const meanMinutes = (distanceKm / effectiveSpeedKmh) * 60;
  
  // Standard deviation (higher variance during peak hours)
  const baseStd = meanMinutes * 0.15; // 15% base variance
  const peakHourBoost = trafficMult > 1.2 ? 1.3 : 1.0; // More variance during peaks
  const stdMinutes = baseStd * peakHourBoost;
  
  // P95 uses configurable safety multiplier
  const p95Minutes = meanMinutes * DEFAULT_SCHEDULING_CONFIG.TRAVEL_TIME_SAFETY_MULTIPLIER;
  
  return {
    meanMinutes: Math.round(meanMinutes * 10) / 10,
    stdMinutes: Math.round(stdMinutes * 10) / 10,
    p95Minutes: Math.round(p95Minutes * 10) / 10,
  };
}

/**
 * Get detailed travel time estimate including distance and multiplier
 */
export function getTravelTimeEstimate(
  origin: Location,
  destination: Location,
  ctx: TimeContext
): TravelTimeEstimate {
  const stats = getTravelTimeStats(origin, destination, ctx);
  const distanceKm = estimateDistanceKm(origin, destination);
  const trafficMultiplier = getTrafficMultiplier(ctx);
  
  return {
    ...stats,
    distanceKm: Math.round(distanceKm * 100) / 100,
    trafficMultiplier: Math.round(trafficMultiplier * 100) / 100,
  };
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
 * Sample a single travel time for Monte Carlo simulation
 * 
 * @param origin - Origin location
 * @param destination - Destination location  
 * @param ctx - Time context
 * @param varianceLevel - How much additional variance to add
 */
export function sampleTravelTimeMinutes(
  origin: Location,
  destination: Location,
  ctx: TimeContext,
  varianceLevel: 'low' | 'medium' | 'high' = 'medium'
): number {
  const stats = getTravelTimeStats(origin, destination, ctx);
  
  // Variance multiplier based on scenario
  const varianceMultipliers: Record<string, number> = {
    low: 0.7,
    medium: 1.0,
    high: 1.5,
  };
  
  const adjustedStd = stats.stdMinutes * varianceMultipliers[varianceLevel];
  
  // Sample from normal distribution, but clamp to reasonable values
  let sampled = sampleNormal(stats.meanMinutes, adjustedStd);
  
  // Apply minimum and maximum bounds
  // Minimum: 60% of mean (can't go faster than free-flowing)
  // Maximum: 200% of mean (even worst traffic has limits)
  const minTime = stats.meanMinutes * 0.6;
  const maxTime = stats.meanMinutes * 2.0;
  
  sampled = Math.max(minTime, Math.min(maxTime, sampled));
  
  return Math.round(sampled * 10) / 10;
}

/**
 * Sample multiple travel times for Monte Carlo analysis
 */
export function sampleTravelTimeBatch(
  origin: Location,
  destination: Location,
  ctx: TimeContext,
  count: number,
  varianceLevel: 'low' | 'medium' | 'high' = 'medium'
): number[] {
  const samples: number[] = [];
  for (let i = 0; i < count; i++) {
    samples.push(sampleTravelTimeMinutes(origin, destination, ctx, varianceLevel));
  }
  return samples;
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Create TimeContext from a Date object
 */
export function createTimeContext(date: Date, weather?: WeatherCondition): TimeContext {
  const dateStr = date.toISOString().slice(0, 10);
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  
  return {
    date: dateStr,
    time: `${hours}:${minutes}`,
    dayOfWeek: date.getDay(),
    weather,
  };
}

/**
 * Create TimeContext from date string and time string
 */
export function createTimeContextFromStrings(
  dateStr: string,
  timeStr: string,
  weather?: WeatherCondition
): TimeContext {
  const date = new Date(`${dateStr}T${timeStr}`);
  return {
    date: dateStr,
    time: timeStr,
    dayOfWeek: date.getDay(),
    weather,
  };
}

/**
 * Calculate pickup time given arrival time and travel estimate
 */
export function calculatePickupTime(
  arrivalTime: Date,
  travelMinutes: number,
  bufferMinutes: number = DEFAULT_SCHEDULING_CONFIG.ARRIVE_EARLY_MINUTES
): Date {
  const totalMinutesEarly = travelMinutes + bufferMinutes;
  return new Date(arrivalTime.getTime() - totalMinutesEarly * 60 * 1000);
}

/**
 * Check if a predicted arrival meets the 5-minute-early rule
 */
export function meetsEarlyArrivalRule(
  predictedArrival: Date,
  arrivalWindowEnd: Date,
  earlyMinutes: number = DEFAULT_SCHEDULING_CONFIG.ARRIVE_EARLY_MINUTES
): boolean {
  const deadline = new Date(arrivalWindowEnd.getTime() - earlyMinutes * 60 * 1000);
  return predictedArrival <= deadline;
}

