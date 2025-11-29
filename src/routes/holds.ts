/**
 * Holds API Routes
 * 
 * Endpoints for managing ride holds:
 * - Create a 5-minute hold on a slot
 * - Confirm a hold (create the ride)
 * - Cancel a hold
 */

import { Router, Request, Response } from 'express';
import { ok, fail } from '../lib/apiResponse';
import { requireAuth } from '../middleware/auth';
import {
  createHold,
  confirmHold,
  cancelHold,
  getHoldById,
  getActiveHoldForRider,
  getHoldStats,
} from '../scheduler';
import type { PlanType, Location } from '../shared/schedulingTypes';
import { getActiveSubscription } from '../services/subscriptionService';
import { sendRideStatusNotification } from '../services/notifications';

const holdsRouter = Router();

/**
 * POST /holds
 * 
 * Create a hold on a slot
 * 
 * Body:
 * - slotId: string
 * - originLat, originLng: pickup coordinates
 * - destLat, destLng: dropoff coordinates
 * - originAddress, destAddress: optional address strings
 * - planType: optional, detected from subscription if not provided
 */
holdsRouter.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json(fail('AUTH_REQUIRED', 'Please log in'));
    }

    const {
      slotId,
      originLat,
      originLng,
      destLat,
      destLng,
      originAddress,
      destAddress,
      planType: planTypeParam,
    } = req.body;

    // Validate required params
    if (!slotId) {
      return res.status(400).json(fail('MISSING_SLOT_ID', 'slotId is required'));
    }

    if (originLat === undefined || originLng === undefined ||
        destLat === undefined || destLng === undefined) {
      return res.status(400).json(
        fail('MISSING_COORDS', 'Origin and destination coordinates are required')
      );
    }

    // Parse coordinates
    const originLocation: Location = {
      lat: parseFloat(originLat),
      lng: parseFloat(originLng),
    };
    const destinationLocation: Location = {
      lat: parseFloat(destLat),
      lng: parseFloat(destLng),
    };

    if (isNaN(originLocation.lat) || isNaN(originLocation.lng) ||
        isNaN(destinationLocation.lat) || isNaN(destinationLocation.lng)) {
      return res.status(400).json(fail('INVALID_COORDS', 'Invalid coordinates'));
    }

    // Determine plan type
    let planType: PlanType = 'standard';
    if (planTypeParam && ['premium', 'standard', 'off_peak'].includes(planTypeParam)) {
      planType = planTypeParam as PlanType;
    } else {
      const active = await getActiveSubscription(user.id);
      if (active?.plan.peak_access) {
        planType = 'premium';
      }
    }

    // Create the hold
    const hold = await createHold(slotId, {
      slotId,
      riderId: user.id.toString(),
      planType,
      originLocation,
      destinationLocation,
      originAddress,
      destinationAddress: destAddress,
    });

    return res.status(201).json(ok({
      hold,
      expiresIn: 5 * 60, // 5 minutes in seconds
    }));
  } catch (err: any) {
    console.error('Error in POST /holds:', err);
    const message = err?.message || 'Failed to create hold';
    return res.status(400).json(fail('HOLD_CREATE_FAILED', message));
  }
});

/**
 * POST /holds/:holdId/confirm
 * 
 * Confirm a hold and create the ride
 */
holdsRouter.post('/:holdId/confirm', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json(fail('AUTH_REQUIRED', 'Please log in'));
    }

    const { holdId } = req.params;

    // Verify the hold belongs to this user
    const hold = await getHoldById(holdId);
    if (!hold) {
      return res.status(404).json(fail('HOLD_NOT_FOUND', 'Hold not found'));
    }

    if (hold.riderId !== user.id.toString()) {
      return res.status(403).json(fail('FORBIDDEN', 'This hold does not belong to you'));
    }

    // Confirm the hold
    const result = await confirmHold(holdId);

    if (!result.success) {
      return res.status(400).json(fail('CONFIRM_FAILED', result.error || 'Failed to confirm hold'));
    }

    // Send notification
    try {
      await sendRideStatusNotification(
        user.id,
        parseInt(result.ride!.id, 10),
        'booking_confirmed',
        result.ride!.pickupTime
      );
    } catch (notifyErr) {
      console.warn('Failed to send booking confirmation:', notifyErr);
    }

    return res.json(ok({
      ride: result.ride,
      message: 'Ride confirmed successfully',
    }));
  } catch (err) {
    console.error('Error in POST /holds/:holdId/confirm:', err);
    return res.status(500).json(fail('CONFIRM_ERROR', 'Failed to confirm hold'));
  }
});

/**
 * POST /holds/:holdId/cancel
 * 
 * Cancel a hold
 */
holdsRouter.post('/:holdId/cancel', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json(fail('AUTH_REQUIRED', 'Please log in'));
    }

    const { holdId } = req.params;

    // Verify the hold belongs to this user
    const hold = await getHoldById(holdId);
    if (!hold) {
      return res.status(404).json(fail('HOLD_NOT_FOUND', 'Hold not found'));
    }

    if (hold.riderId !== user.id.toString()) {
      return res.status(403).json(fail('FORBIDDEN', 'This hold does not belong to you'));
    }

    await cancelHold(holdId);

    return res.json(ok({ cancelled: true }));
  } catch (err) {
    console.error('Error in POST /holds/:holdId/cancel:', err);
    return res.status(500).json(fail('CANCEL_ERROR', 'Failed to cancel hold'));
  }
});

/**
 * GET /holds/active
 * 
 * Get the current user's active hold (if any)
 */
holdsRouter.get('/active', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json(fail('AUTH_REQUIRED', 'Please log in'));
    }

    const hold = await getActiveHoldForRider(user.id.toString());

    return res.json(ok({ hold }));
  } catch (err) {
    console.error('Error in GET /holds/active:', err);
    return res.status(500).json(fail('HOLDS_ERROR', 'Failed to get active hold'));
  }
});

/**
 * GET /holds/:holdId
 * 
 * Get a specific hold
 */
holdsRouter.get('/:holdId', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json(fail('AUTH_REQUIRED', 'Please log in'));
    }

    const { holdId } = req.params;
    const hold = await getHoldById(holdId);

    if (!hold) {
      return res.status(404).json(fail('HOLD_NOT_FOUND', 'Hold not found'));
    }

    // Only return if it belongs to the user or user is admin
    if (hold.riderId !== user.id.toString() && user.role !== 'admin') {
      return res.status(403).json(fail('FORBIDDEN', 'Access denied'));
    }

    return res.json(ok({ hold }));
  } catch (err) {
    console.error('Error in GET /holds/:holdId:', err);
    return res.status(500).json(fail('HOLD_ERROR', 'Failed to get hold'));
  }
});

export { holdsRouter };
export default holdsRouter;

