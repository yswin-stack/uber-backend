/**
 * Availability API Routes
 * 
 * Endpoints for getting available time windows for booking.
 */

import { Router, Request, Response } from 'express';
import { ok, fail } from '../lib/apiResponse';
import { requireAuth } from '../middleware/auth';
import {
  getAvailableArrivalWindows,
  getAvailableWindowsForRider,
  isSlotAvailableForRider,
  getAvailabilitySummary,
  getNextAvailableSlot,
  inferDirection,
} from '../scheduler';
import type { PlanType, Location } from '../shared/schedulingTypes';
import { getActiveSubscription } from '../services/subscriptionService';

const availabilityRouter = Router();

/**
 * GET /availability
 * 
 * Get available arrival windows for a ride
 * 
 * Query params:
 * - date: YYYY-MM-DD
 * - originLat, originLng: pickup coordinates
 * - destLat, destLng: dropoff coordinates
 * - planType: premium | standard | off_peak (optional, detected from subscription)
 * - desiredArrival: HH:mm (optional)
 */
availabilityRouter.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json(fail('AUTH_REQUIRED', 'Please log in'));
    }

    const {
      date,
      originLat,
      originLng,
      destLat,
      destLng,
      planType: planTypeParam,
      desiredArrival,
    } = req.query;

    // Validate required params
    if (!date || !originLat || !originLng || !destLat || !destLng) {
      return res.status(400).json(
        fail('MISSING_PARAMS', 'date, originLat, originLng, destLat, destLng are required')
      );
    }

    // Parse coordinates
    const originLocation: Location = {
      lat: parseFloat(originLat as string),
      lng: parseFloat(originLng as string),
    };
    const destinationLocation: Location = {
      lat: parseFloat(destLat as string),
      lng: parseFloat(destLng as string),
    };

    if (isNaN(originLocation.lat) || isNaN(originLocation.lng) ||
        isNaN(destinationLocation.lat) || isNaN(destinationLocation.lng)) {
      return res.status(400).json(fail('INVALID_COORDS', 'Invalid coordinates'));
    }

    // Determine plan type
    let planType: PlanType = 'standard';
    if (planTypeParam && ['premium', 'standard', 'off_peak'].includes(planTypeParam as string)) {
      planType = planTypeParam as PlanType;
    } else {
      // Detect from subscription
      const active = await getActiveSubscription(user.id);
      if (active?.plan.peak_access) {
        planType = 'premium';
      }
    }

    // Get available windows
    const options = await getAvailableWindowsForRider(user.id.toString(), {
      date: date as string,
      originLocation,
      destinationLocation,
      planType,
      desiredArrival: desiredArrival as string | undefined,
    });

    return res.json(ok({
      timeOptions: options,
      planType,
      direction: inferDirection(originLocation, destinationLocation),
    }));
  } catch (err) {
    console.error('Error in GET /availability:', err);
    return res.status(500).json(fail('AVAILABILITY_ERROR', 'Failed to get availability'));
  }
});

/**
 * GET /availability/slot/:slotId
 * 
 * Check if a specific slot is available for the current user
 */
availabilityRouter.get('/slot/:slotId', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json(fail('AUTH_REQUIRED', 'Please log in'));
    }

    const { slotId } = req.params;
    const { date, originLat, originLng, destLat, destLng, planType: planTypeParam } = req.query;

    if (!date || !originLat || !originLng || !destLat || !destLng) {
      return res.status(400).json(
        fail('MISSING_PARAMS', 'date and coordinates are required')
      );
    }

    const originLocation: Location = {
      lat: parseFloat(originLat as string),
      lng: parseFloat(originLng as string),
    };
    const destinationLocation: Location = {
      lat: parseFloat(destLat as string),
      lng: parseFloat(destLng as string),
    };

    // Determine plan type
    let planType: PlanType = 'standard';
    if (planTypeParam && ['premium', 'standard', 'off_peak'].includes(planTypeParam as string)) {
      planType = planTypeParam as PlanType;
    } else {
      const active = await getActiveSubscription(user.id);
      if (active?.plan.peak_access) {
        planType = 'premium';
      }
    }

    const result = await isSlotAvailableForRider(user.id.toString(), slotId, {
      date: date as string,
      originLocation,
      destinationLocation,
      planType,
    });

    return res.json(ok(result));
  } catch (err) {
    console.error('Error in GET /availability/slot/:slotId:', err);
    return res.status(500).json(fail('AVAILABILITY_ERROR', 'Failed to check slot'));
  }
});

/**
 * GET /availability/summary
 * 
 * Get availability summary for a date
 */
availabilityRouter.get('/summary', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json(fail('AUTH_REQUIRED', 'Please log in'));
    }

    const { date, planType: planTypeParam } = req.query;

    if (!date) {
      return res.status(400).json(fail('MISSING_DATE', 'date is required'));
    }

    // Determine plan type
    let planType: PlanType = 'standard';
    if (planTypeParam && ['premium', 'standard', 'off_peak'].includes(planTypeParam as string)) {
      planType = planTypeParam as PlanType;
    } else {
      const active = await getActiveSubscription(user.id);
      if (active?.plan.peak_access) {
        planType = 'premium';
      }
    }

    const summary = await getAvailabilitySummary(date as string, planType);

    return res.json(ok(summary));
  } catch (err) {
    console.error('Error in GET /availability/summary:', err);
    return res.status(500).json(fail('SUMMARY_ERROR', 'Failed to get summary'));
  }
});

/**
 * GET /availability/next
 * 
 * Find the next available slot after a given time
 */
availabilityRouter.get('/next', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json(fail('AUTH_REQUIRED', 'Please log in'));
    }

    const { date, afterTime, planType: planTypeParam, direction } = req.query;

    if (!date || !afterTime) {
      return res.status(400).json(fail('MISSING_PARAMS', 'date and afterTime are required'));
    }

    // Determine plan type
    let planType: PlanType = 'standard';
    if (planTypeParam && ['premium', 'standard', 'off_peak'].includes(planTypeParam as string)) {
      planType = planTypeParam as PlanType;
    } else {
      const active = await getActiveSubscription(user.id);
      if (active?.plan.peak_access) {
        planType = 'premium';
      }
    }

    const nextSlot = await getNextAvailableSlot(
      date as string,
      afterTime as string,
      planType,
      (direction as any) || 'other'
    );

    return res.json(ok({ nextSlot }));
  } catch (err) {
    console.error('Error in GET /availability/next:', err);
    return res.status(500).json(fail('NEXT_SLOT_ERROR', 'Failed to find next slot'));
  }
});

export { availabilityRouter };
export default availabilityRouter;

