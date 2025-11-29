/**
 * Admin Capacity API Routes
 * 
 * Endpoints for viewing and managing capacity (admin only)
 */

import { Router, Request, Response } from 'express';
import { ok, fail } from '../lib/apiResponse';
import { requireAuth, requireRole } from '../middleware/auth';
import {
  getAdminCapacityView,
  getQuickCapacityStats,
  getCapacityOverview,
  triggerSimulation,
  getSimulationHistory,
  getCapacityAlerts,
  exportCapacityData,
  computeDailyCapacity,
  getSimulationResults,
  getPremiumSubscriberCount,
  canAddPremiumSubscriber,
  expireHolds,
  getHoldStats,
} from '../scheduler';

const capacityRouter = Router();

/**
 * GET /admin/capacity/:date
 * 
 * Get full capacity view for a date
 */
capacityRouter.get(
  '/:date',
  requireAuth,
  requireRole('admin'),
  async (req: Request, res: Response) => {
    try {
      const { date } = req.params;

      if (!date.match(/^\d{4}-\d{2}-\d{2}$/)) {
        return res.status(400).json(fail('INVALID_DATE', 'Date must be YYYY-MM-DD'));
      }

      const view = await getAdminCapacityView(date);

      return res.json(ok(view));
    } catch (err) {
      console.error('Error in GET /admin/capacity/:date:', err);
      return res.status(500).json(fail('CAPACITY_ERROR', 'Failed to get capacity'));
    }
  }
);

/**
 * GET /admin/capacity/:date/summary
 * 
 * Get quick summary stats for a date
 */
capacityRouter.get(
  '/:date/summary',
  requireAuth,
  requireRole('admin'),
  async (req: Request, res: Response) => {
    try {
      const { date } = req.params;

      if (!date.match(/^\d{4}-\d{2}-\d{2}$/)) {
        return res.status(400).json(fail('INVALID_DATE', 'Date must be YYYY-MM-DD'));
      }

      const stats = await getQuickCapacityStats(date);

      return res.json(ok(stats));
    } catch (err) {
      console.error('Error in GET /admin/capacity/:date/summary:', err);
      return res.status(500).json(fail('SUMMARY_ERROR', 'Failed to get summary'));
    }
  }
);

/**
 * GET /admin/capacity/:date/alerts
 * 
 * Get capacity alerts for a date
 */
capacityRouter.get(
  '/:date/alerts',
  requireAuth,
  requireRole('admin'),
  async (req: Request, res: Response) => {
    try {
      const { date } = req.params;

      if (!date.match(/^\d{4}-\d{2}-\d{2}$/)) {
        return res.status(400).json(fail('INVALID_DATE', 'Date must be YYYY-MM-DD'));
      }

      const alerts = await getCapacityAlerts(date);

      return res.json(ok({ alerts }));
    } catch (err) {
      console.error('Error in GET /admin/capacity/:date/alerts:', err);
      return res.status(500).json(fail('ALERTS_ERROR', 'Failed to get alerts'));
    }
  }
);

/**
 * GET /admin/capacity/overview
 * 
 * Get multi-day capacity overview
 */
capacityRouter.get(
  '/overview/:startDate',
  requireAuth,
  requireRole('admin'),
  async (req: Request, res: Response) => {
    try {
      const { startDate } = req.params;
      const { days } = req.query;

      if (!startDate.match(/^\d{4}-\d{2}-\d{2}$/)) {
        return res.status(400).json(fail('INVALID_DATE', 'Date must be YYYY-MM-DD'));
      }

      const numDays = days ? parseInt(days as string, 10) : 7;
      const overview = await getCapacityOverview(startDate, numDays);

      return res.json(ok({ overview }));
    } catch (err) {
      console.error('Error in GET /admin/capacity/overview:', err);
      return res.status(500).json(fail('OVERVIEW_ERROR', 'Failed to get overview'));
    }
  }
);

/**
 * GET /admin/capacity/:date/export
 * 
 * Export capacity data as CSV
 */
capacityRouter.get(
  '/:date/export',
  requireAuth,
  requireRole('admin'),
  async (req: Request, res: Response) => {
    try {
      const { date } = req.params;

      if (!date.match(/^\d{4}-\d{2}-\d{2}$/)) {
        return res.status(400).json(fail('INVALID_DATE', 'Date must be YYYY-MM-DD'));
      }

      const data = await exportCapacityData(date);

      // Return as JSON (frontend can convert to CSV)
      return res.json(ok(data));
    } catch (err) {
      console.error('Error in GET /admin/capacity/:date/export:', err);
      return res.status(500).json(fail('EXPORT_ERROR', 'Failed to export data'));
    }
  }
);

/**
 * POST /admin/simulations
 * 
 * Run a Monte Carlo simulation
 */
capacityRouter.post(
  '/simulations',
  requireAuth,
  requireRole('admin'),
  async (req: Request, res: Response) => {
    try {
      const user = req.user;
      const { date, scenario } = req.body;

      if (!date || !date.match(/^\d{4}-\d{2}-\d{2}$/)) {
        return res.status(400).json(fail('INVALID_DATE', 'Date must be YYYY-MM-DD'));
      }

      const result = await triggerSimulation(date, scenario || {}, user?.id);

      return res.json(ok(result));
    } catch (err) {
      console.error('Error in POST /admin/simulations:', err);
      return res.status(500).json(fail('SIMULATION_ERROR', 'Failed to run simulation'));
    }
  }
);

/**
 * GET /admin/simulations/:jobId
 * 
 * Get simulation results
 */
capacityRouter.get(
  '/simulations/:jobId',
  requireAuth,
  requireRole('admin'),
  async (req: Request, res: Response) => {
    try {
      const { jobId } = req.params;

      const results = await getSimulationResults(jobId);

      if (!results) {
        return res.status(404).json(fail('NOT_FOUND', 'Simulation not found or not completed'));
      }

      return res.json(ok(results));
    } catch (err) {
      console.error('Error in GET /admin/simulations/:jobId:', err);
      return res.status(500).json(fail('SIMULATION_ERROR', 'Failed to get simulation'));
    }
  }
);

/**
 * GET /admin/simulations/history/:date
 * 
 * Get simulation history for a date
 */
capacityRouter.get(
  '/simulations/history/:date',
  requireAuth,
  requireRole('admin'),
  async (req: Request, res: Response) => {
    try {
      const { date } = req.params;

      if (!date.match(/^\d{4}-\d{2}-\d{2}$/)) {
        return res.status(400).json(fail('INVALID_DATE', 'Date must be YYYY-MM-DD'));
      }

      const history = await getSimulationHistory(date);

      return res.json(ok({ history }));
    } catch (err) {
      console.error('Error in GET /admin/simulations/history/:date:', err);
      return res.status(500).json(fail('HISTORY_ERROR', 'Failed to get history'));
    }
  }
);

/**
 * GET /admin/premium-subscribers
 * 
 * Get premium subscriber info
 */
capacityRouter.get(
  '/premium-subscribers',
  requireAuth,
  requireRole('admin'),
  async (_req: Request, res: Response) => {
    try {
      const count = await getPremiumSubscriberCount();
      const canAdd = await canAddPremiumSubscriber();

      return res.json(ok({
        currentCount: count,
        maxCount: 20,
        canAddMore: canAdd,
      }));
    } catch (err) {
      console.error('Error in GET /admin/premium-subscribers:', err);
      return res.status(500).json(fail('SUBSCRIBERS_ERROR', 'Failed to get subscriber info'));
    }
  }
);

/**
 * POST /admin/holds/expire
 * 
 * Manually trigger hold expiration (for testing/admin)
 */
capacityRouter.post(
  '/holds/expire',
  requireAuth,
  requireRole('admin'),
  async (_req: Request, res: Response) => {
    try {
      const expiredCount = await expireHolds();

      return res.json(ok({
        expiredCount,
        message: `Expired ${expiredCount} hold(s)`,
      }));
    } catch (err) {
      console.error('Error in POST /admin/holds/expire:', err);
      return res.status(500).json(fail('EXPIRE_ERROR', 'Failed to expire holds'));
    }
  }
);

/**
 * GET /admin/holds/stats
 * 
 * Get hold statistics
 */
capacityRouter.get(
  '/holds/stats',
  requireAuth,
  requireRole('admin'),
  async (_req: Request, res: Response) => {
    try {
      const stats = await getHoldStats();

      return res.json(ok(stats));
    } catch (err) {
      console.error('Error in GET /admin/holds/stats:', err);
      return res.status(500).json(fail('STATS_ERROR', 'Failed to get hold stats'));
    }
  }
);

export { capacityRouter };
export default capacityRouter;

