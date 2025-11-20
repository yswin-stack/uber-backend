import { Request, Response, NextFunction } from "express";

export interface AuthRequest extends Request {
  userId?: number;
}

// Simple mock auth: in real life you'd verify a JWT.
// Here we just read X-User-Id header or default to 1.
export function mockAuth(req: AuthRequest, _res: Response, next: NextFunction) {
  const header = req.header("x-user-id");
  if (header) {
    const parsed = parseInt(header, 10);
    if (!Number.isNaN(parsed)) {
      req.userId = parsed;
    }
  } else {
    req.userId = 1; // default demo user
  }
  next();
}
