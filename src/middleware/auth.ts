import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-this";

export function decodeAuthToken(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const authHeader = req.header("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) {
    // No token, continue (we won't force auth here yet)
    return next();
  }

  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) {
    return next();
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET) as {
      userId: number;
      role: "subscriber" | "driver" | "admin";
    };
    req.user = {
      userId: payload.userId,
      role: payload.role,
    };
  } catch (err) {
    console.error("Invalid JWT:", err);
    // invalid token, just ignore for now
  }

  return next();
}

/**
 * For future use when we want to force auth on certain routes:
 * If no valid JWT, returns 401.
 */
export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
) {
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  return next();
}
