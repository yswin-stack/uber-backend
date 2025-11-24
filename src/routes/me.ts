import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/auth";
import { ok, fail } from "../lib/apiResponse";
import { getCreditsSummaryForUser } from "../services/subscriptionService";

export const meRouter = Router();

/**
 * GET /me/credits
 *
 * Returns CreditsSummary for the current billing period:
 * {
 *   standard_total,
 *   standard_used,
 *   grocery_total,
 *   grocery_used
 * }
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
