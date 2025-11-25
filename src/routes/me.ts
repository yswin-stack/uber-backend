import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/auth";
import { ok, fail } from "../lib/apiResponse";
import { getCreditsSummaryForUser } from "../services/subscriptionService";

export const meRouter = Router();

/**
 * --------------------------------------------------
 *  GET /me/credits
 *  Returns the user's current ride credits summary
 * --------------------------------------------------
 */
meRouter.get("/credits", requireAuth, async (req: Request, res: Response) => {
  const authUser = req.user;
  if (!authUser) {
    return res
      .status(401)
      .json(fail("AUTH_REQUIRED", "Please log in to view your credits."));
  }

  try {
    const summary = await getCreditsSummaryForUser(authUser.id);
    return res.json(ok(summary));
  } catch (err) {
    console.error("Error in GET /me/credits:", err);
    return res
      .status(500)
      .json(fail("CREDITS_FETCH_FAILED", "Failed to fetch credits summary."));
  }
});

/**
 * --------------------------------------------------
 *  GET /me/schedule
 *  Returns weekly schedule template
 * 
 *  For now:
 *  - Returns empty array (frontend merges defaults)
 *  - No DB persistence yet
 * --------------------------------------------------
 */
meRouter.get("/schedule", requireAuth, async (req: Request, res: Response) => {
  try {
    // Placeholder: return empty weekly template
    // The frontend merges this with BASE_DAYS.
    return res.json(ok([]));
  } catch (err) {
    console.error("Error in GET /me/schedule:", err);
    return res
      .status(500)
      .json(fail("SCHEDULE_FETCH_FAILED", "Failed to fetch schedule."));
  }
});

/**
 * --------------------------------------------------
 *  POST /me/schedule
 *  Saves weekly template
 * 
 *  For now:
 *  - Accept payload & return ok(true)
 *  - DB backing will be implemented in Backend Step 7+
 * --------------------------------------------------
 */
meRouter.post("/schedule", requireAuth, async (req: Request, res: Response) => {
  try {
    // Log the schedule payload so we know the structure
    console.log("[/me/schedule] Received schedule:", req.body);

    // TODO: Real DB save in next backend step
    return res.json(ok({ saved: true }));
  } catch (err) {
    console.error("Error in POST /me/schedule:", err);
    return res
      .status(500)
      .json(fail("SCHEDULE_SAVE_FAILED", "Failed to save schedule."));
  }
});

/**
 * --------------------------------------------------
 *  GET /me/setup
 *  Onboarding completion status for redirect logic
 * 
 *  For now:
 *  - Always returns true for all fields
 *  - Prevents onboarding redirect loops
 * --------------------------------------------------
 */
meRouter.get("/setup", requireAuth, async (req: Request, res: Response) => {
  try {
    // In future we will fetch home/work/schedule from DB.
    return res.json(
      ok({
        has_home: true,
        has_work: true,
        has_schedule: true
      })
    );
  } catch (err) {
    console.error("Error in GET /me/setup:", err);
    return res
      .status(500)
      .json(fail("SETUP_CHECK_FAILED", "Failed to check setup status."));
  }
});

export default meRouter;
