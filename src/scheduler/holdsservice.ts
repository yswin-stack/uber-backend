/**
 * Holds Service
 * 
 * Manages temporary holds on time slots:
 * - 5-minute expiry window for user to confirm
 * - Reserves capacity in the slot
 * - Converts to confirmed ride on confirmation
 * - Auto-expires and releases capacity
 */

import { v4 as uuidv4 } from 'uuid';
import type {
  SlotHold,
  CreateHoldRequest,
  ConfirmHoldResult,
  ScheduledRide,
  PlanType,
  Location,
} from '../shared/schedulingTypes';
import { DEFAULT_SCHEDULING_CONFIG } from '../shared/schedulingTypes';
import { pool } from '../db/pool';
import {
  getSlotById,
  reserveSlotCapacity,
  releaseSlotCapacity,
} from './timeSlots';
import {
  canInsertRideIntoSlot,
  quickFeasibilityCheck,
} from './feasibility';
import {
  getTravelTimeEstimate,
  createTimeContextFromStrings,
  calculatePickupTime,
} from './travelTimeModel';

// =============================================================================
// Constants
// =============================================================================

const HOLD_EXPIRY_MINUTES = DEFAULT_SCHEDULING_CONFIG.HOLD_EXPIRY_MINUTES;
const ARRIVE_EARLY_MINUTES = DEFAULT_SCHEDULING_CONFIG.ARRIVE_EARLY_MINUTES;

// =============================================================================
// Hold Creation
// =============================================================================

/**
 * Create a hold on a slot
 */
export async function createHold(
  slotId: string,
  request: CreateHoldRequest
): Promise<SlotHold> {
  const { riderId, planType, originLocation, destinationLocation, originAddress, destinationAddress } = request;
  
  // 1. Get the slot
  const slot = await getSlotById(slotId);
  if (!slot) {
    throw new Error('Slot not found');
  }
  
  // 2. Quick feasibility check
  const quick = await quickFeasibilityCheck(slotId, planType);
  if (!quick.possible) {
    throw new Error(quick.reason || 'Slot not available');
  }
  
  // 3. Check if rider already has an active hold
  const existingHold = await getActiveHoldForRider(riderId);
  if (existingHold) {
    // Cancel the existing hold first
    await cancelHold(existingHold.holdId);
  }
  
  // 4. Full feasibility check
  const rideRequest = {
    riderId,
    date: slot.date,
    originLocation,
    destinationLocation,
    originAddress,
    destinationAddress,
    planType,
  };
  
  const feasibility = await canInsertRideIntoSlot(rideRequest, slot);
  if (!feasibility.feasible) {
    throw new Error(feasibility.reason || 'Slot not feasible');
  }
  
  // 5. Reserve capacity in the slot
  const isPremium = planType === 'premium';
  const reserved = await reserveSlotCapacity(slotId, isPremium);
  if (!reserved) {
    throw new Error('Failed to reserve capacity - slot may be full');
  }
  
  // 6. Create the hold record
  const holdId = `hold_${uuidv4()}`;
  const expiresAt = new Date(Date.now() + HOLD_EXPIRY_MINUTES * 60 * 1000);
  
  try {
    await pool.query(
      `
      INSERT INTO slot_holds (
        hold_id, slot_id, rider_id, plan_type,
        origin_lat, origin_lng, destination_lat, destination_lng,
        origin_address, destination_address,
        expires_at, status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'active')
      `,
      [
        holdId,
        slotId,
        riderId,
        planType,
        originLocation.lat,
        originLocation.lng,
        destinationLocation.lat,
        destinationLocation.lng,
        originAddress || null,
        destinationAddress || null,
        expiresAt.toISOString(),
      ]
    );
    
    return {
      holdId,
      slotId,
      riderId,
      planType,
      originLocation,
      destinationLocation,
      originAddress,
      destinationAddress,
      createdAt: new Date().toISOString(),
      expiresAt: expiresAt.toISOString(),
      status: 'active',
    };
  } catch (err) {
    // If insert fails, release the reserved capacity
    await releaseSlotCapacity(slotId, isPremium);
    throw err;
  }
}

// =============================================================================
// Hold Confirmation
// =============================================================================

/**
 * Confirm a hold and create the ride
 */
export async function confirmHold(holdId: string): Promise<ConfirmHoldResult> {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // 1. Get and lock the hold
    const holdResult = await client.query(
      `
      SELECT 
        hold_id, slot_id, rider_id, plan_type,
        origin_lat, origin_lng, destination_lat, destination_lng,
        origin_address, destination_address,
        expires_at, status
      FROM slot_holds
      WHERE hold_id = $1
      FOR UPDATE
      `,
      [holdId]
    );
    
    if (holdResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: 'Hold not found' };
    }
    
    const hold = holdResult.rows[0];
    
    // 2. Check hold status
    if (hold.status !== 'active') {
      await client.query('ROLLBACK');
      return { success: false, error: `Hold is ${hold.status}` };
    }
    
    // 3. Check if hold has expired
    if (new Date(hold.expires_at) < new Date()) {
      await client.query('ROLLBACK');
      return { success: false, error: 'Hold has expired' };
    }
    
    // 4. Get slot info
    const slotResult = await client.query(
      `
      SELECT date::text, arrival_start::text, arrival_end::text
      FROM slot_capacity
      WHERE slot_id = $1
      `,
      [hold.slot_id]
    );
    
    if (slotResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: 'Slot not found' };
    }
    
    const slot = slotResult.rows[0];
    
    // 5. Calculate pickup time
    const ctx = createTimeContextFromStrings(slot.date, slot.arrival_start.slice(0, 5));
    const originLoc: Location = { lat: hold.origin_lat, lng: hold.origin_lng };
    const destLoc: Location = { lat: hold.destination_lat, lng: hold.destination_lng };
    const travelEstimate = getTravelTimeEstimate(originLoc, destLoc, ctx);
    
    const arrivalDate = new Date(`${slot.date}T${slot.arrival_end}`);
    const pickupTime = calculatePickupTime(arrivalDate, travelEstimate.p95Minutes);
    
    // Calculate windows
    const pickupWindowStart = new Date(pickupTime.getTime() - 5 * 60 * 1000);
    const pickupWindowEnd = new Date(pickupTime.getTime() + 5 * 60 * 1000);
    const arrivalWindowStart = new Date(`${slot.date}T${slot.arrival_start}`);
    const arrivalWindowEnd = arrivalDate;
    
    // 6. Create the ride
    const rideResult = await client.query(
      `
      INSERT INTO rides (
        user_id, slot_id, plan_type, hold_id,
        pickup_location, dropoff_location,
        pickup_lat, pickup_lng, drop_lat, drop_lng,
        pickup_time, arrival_target_time,
        pickup_window_start, pickup_window_end,
        arrival_window_start, arrival_window_end,
        predicted_arrival,
        ride_type, status
      )
      VALUES (
        $1, $2, $3, $4,
        $5, $6,
        $7, $8, $9, $10,
        $11, $12,
        $13, $14,
        $15, $16,
        $17,
        'standard', 'scheduled'
      )
      RETURNING id
      `,
      [
        hold.rider_id,
        hold.slot_id,
        hold.plan_type,
        holdId,
        hold.origin_address || 'Pickup',
        hold.destination_address || 'Dropoff',
        hold.origin_lat,
        hold.origin_lng,
        hold.destination_lat,
        hold.destination_lng,
        pickupTime.toISOString(),
        arrivalDate.toISOString(),
        pickupWindowStart.toISOString(),
        pickupWindowEnd.toISOString(),
        arrivalWindowStart.toISOString(),
        arrivalWindowEnd.toISOString(),
        arrivalDate.toISOString(),
      ]
    );
    
    const rideId = rideResult.rows[0].id;
    
    // 7. Update hold status
    await client.query(
      `
      UPDATE slot_holds
      SET status = 'confirmed', confirmed_at = now(), confirmed_ride_id = $2
      WHERE hold_id = $1
      `,
      [holdId, rideId]
    );
    
    await client.query('COMMIT');
    
    const ride: ScheduledRide = {
      id: rideId.toString(),
      riderId: hold.rider_id.toString(),
      date: slot.date,
      slotId: hold.slot_id,
      planType: hold.plan_type as PlanType,
      arrivalStart: slot.arrival_start.slice(0, 5),
      arrivalEnd: slot.arrival_end.slice(0, 5),
      originLocation: originLoc,
      destinationLocation: destLoc,
      originAddress: hold.origin_address,
      destinationAddress: hold.destination_address,
      pickupTime: pickupTime.toISOString(),
      predictedArrival: arrivalDate.toISOString(),
    };
    
    return { success: true, ride };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error confirming hold:', err);
    return { success: false, error: 'Failed to confirm hold' };
  } finally {
    client.release();
  }
}

// =============================================================================
// Hold Cancellation
// =============================================================================

/**
 * Cancel a hold and release capacity
 */
export async function cancelHold(holdId: string): Promise<void> {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Get hold info
    const holdResult = await client.query(
      `
      SELECT slot_id, plan_type, status
      FROM slot_holds
      WHERE hold_id = $1
      FOR UPDATE
      `,
      [holdId]
    );
    
    if (holdResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return;
    }
    
    const hold = holdResult.rows[0];
    
    // Only cancel active holds
    if (hold.status !== 'active') {
      await client.query('ROLLBACK');
      return;
    }
    
    // Update status
    await client.query(
      `UPDATE slot_holds SET status = 'cancelled' WHERE hold_id = $1`,
      [holdId]
    );
    
    // Release capacity
    const isPremium = hold.plan_type === 'premium';
    await releaseSlotCapacity(hold.slot_id, isPremium);
    
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// =============================================================================
// Hold Expiration
// =============================================================================

/**
 * Expire all holds that have passed their expiry time
 * This should be called by a scheduled job
 */
export async function expireHolds(): Promise<number> {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Find expired active holds
    const expiredResult = await client.query(
      `
      SELECT hold_id, slot_id, plan_type
      FROM slot_holds
      WHERE status = 'active' AND expires_at < now()
      FOR UPDATE
      `
    );
    
    const expired = expiredResult.rows;
    
    if (expired.length === 0) {
      await client.query('COMMIT');
      return 0;
    }
    
    // Update status
    const holdIds = expired.map(h => h.hold_id);
    await client.query(
      `UPDATE slot_holds SET status = 'expired' WHERE hold_id = ANY($1)`,
      [holdIds]
    );
    
    // Release capacity for each
    for (const hold of expired) {
      const isPremium = hold.plan_type === 'premium';
      await releaseSlotCapacity(hold.slot_id, isPremium);
    }
    
    await client.query('COMMIT');
    
    return expired.length;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// =============================================================================
// Hold Queries
// =============================================================================

/**
 * Get a hold by ID
 */
export async function getHoldById(holdId: string): Promise<SlotHold | null> {
  const result = await pool.query(
    `
    SELECT 
      hold_id, slot_id, rider_id::text, plan_type,
      origin_lat, origin_lng, destination_lat, destination_lng,
      origin_address, destination_address,
      created_at, expires_at, status
    FROM slot_holds
    WHERE hold_id = $1
    `,
    [holdId]
  );
  
  if (result.rowCount === 0) return null;
  
  const row = result.rows[0];
  return {
    holdId: row.hold_id,
    slotId: row.slot_id,
    riderId: row.rider_id,
    planType: row.plan_type as PlanType,
    originLocation: { lat: row.origin_lat, lng: row.origin_lng },
    destinationLocation: { lat: row.destination_lat, lng: row.destination_lng },
    originAddress: row.origin_address,
    destinationAddress: row.destination_address,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    status: row.status,
  };
}

/**
 * Get active hold for a rider
 */
export async function getActiveHoldForRider(riderId: string): Promise<SlotHold | null> {
  const result = await pool.query(
    `
    SELECT 
      hold_id, slot_id, rider_id::text, plan_type,
      origin_lat, origin_lng, destination_lat, destination_lng,
      origin_address, destination_address,
      created_at, expires_at, status
    FROM slot_holds
    WHERE rider_id = $1 AND status = 'active' AND expires_at > now()
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [riderId]
  );
  
  if (result.rowCount === 0) return null;
  
  const row = result.rows[0];
  return {
    holdId: row.hold_id,
    slotId: row.slot_id,
    riderId: row.rider_id,
    planType: row.plan_type as PlanType,
    originLocation: { lat: row.origin_lat, lng: row.origin_lng },
    destinationLocation: { lat: row.destination_lat, lng: row.destination_lng },
    originAddress: row.origin_address,
    destinationAddress: row.destination_address,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    status: row.status,
  };
}

/**
 * Get all active holds for a slot
 */
export async function getActiveHoldsForSlot(slotId: string): Promise<SlotHold[]> {
  const result = await pool.query(
    `
    SELECT 
      hold_id, slot_id, rider_id::text, plan_type,
      origin_lat, origin_lng, destination_lat, destination_lng,
      origin_address, destination_address,
      created_at, expires_at, status
    FROM slot_holds
    WHERE slot_id = $1 AND status = 'active' AND expires_at > now()
    `,
    [slotId]
  );
  
  return result.rows.map(row => ({
    holdId: row.hold_id,
    slotId: row.slot_id,
    riderId: row.rider_id,
    planType: row.plan_type as PlanType,
    originLocation: { lat: row.origin_lat, lng: row.origin_lng },
    destinationLocation: { lat: row.destination_lat, lng: row.destination_lng },
    originAddress: row.origin_address,
    destinationAddress: row.destination_address,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    status: row.status,
  }));
}

/**
 * Get hold statistics
 */
export async function getHoldStats(): Promise<{
  activeHolds: number;
  confirmedToday: number;
  expiredToday: number;
  cancelledToday: number;
}> {
  const result = await pool.query(`
    SELECT 
      COUNT(*) FILTER (WHERE status = 'active' AND expires_at > now()) as active_holds,
      COUNT(*) FILTER (WHERE status = 'confirmed' AND DATE(confirmed_at) = CURRENT_DATE) as confirmed_today,
      COUNT(*) FILTER (WHERE status = 'expired' AND DATE(expires_at) = CURRENT_DATE) as expired_today,
      COUNT(*) FILTER (WHERE status = 'cancelled' AND DATE(created_at) = CURRENT_DATE) as cancelled_today
    FROM slot_holds
  `);
  
  const row = result.rows[0];
  return {
    activeHolds: parseInt(row.active_holds || '0', 10),
    confirmedToday: parseInt(row.confirmed_today || '0', 10),
    expiredToday: parseInt(row.expired_today || '0', 10),
    cancelledToday: parseInt(row.cancelled_today || '0', 10),
  };
}

