import { Router, Request, Response } from "express";
import { getCreditsSummary } from "../lib/credits";

export const creditsRouter = Router();

function getUserIdFromHeader(req: Request): number | null {
  const header = req.header("x-user-id");
  if (!header) return null;
  const id = parseInt(header, 10);
  return Number.isNaN(id) ? null : id;
}

creditsRouter.get("/", async (req: Request, res: Response) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) {
    return res.status(401).json({ error: "Missing or invalid x-user-id" });
  }

  try {
    const credits = await getCreditsSummary(userId);
    res.json({ credits });
  } catch (err: any) {
    console.error("Error in GET /credits", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
