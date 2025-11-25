// src/middleware/auth.ts

import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { fail } from "../lib/apiResponse";

const JWT_SECRET = process.env.JWT_SECRET || "";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";

export interface AuthUser {
  id: number;
  role: string;
  phone?: string | null;
}

interface JwtPayload {
  id: number;
  role: string;
  phone?: string | null;
  iat?: number;
  exp?: number;
}

// Declare req.user type globally for TypeScript
declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/**
 * authMiddleware:
 *  - Reads JWT from Authorization: Bearer <token> or auth_token cookie (if set later).
 *  - If valid, attaches req.user = { id, role, phone }.
 *  - Does NOT block the request; use requireAuth + requireRole to enforce.
 */
export function authMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction
) {
  if (!JWT_SECRET) {
    // If not configured, we skip JWT parsing but keep app running.
    console.warn("[authMiddleware] JWT_SECRET is not set – JWT auth disabled.");
    return next();
  }

  const authHeader = req.headers["authorization"];
  let token: string | null = null;

  if (authHeader && typeof authHeader === "string") {
    const [scheme, value] = authHeader.split(" ");
    if (scheme.toLowerCase() === "bearer" && value) {
      token = value;
    }
  }

  // Optional: check cookie named "auth_token"
  const cookies = (req as any).cookies as Record<string, string> | undefined;
  if (!token && cookies && typeof cookies.auth_token === "string") {
    token = cookies.auth_token;
  }

  if (!token) {
    return next();
  }

  try {
  const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
if (!decoded || typeof decoded.id !== "number" || !decoded.role) {
  return next();
}

const role = decoded.role;
if (role !== "subscriber" && role !== "driver" && role !== "admin") {
  // Unknown role in token – treat as unauthenticated.
  return next();
}

req.user = {
  id: decoded.id,
  userId: decoded.id,
  role,
  phone: decoded.phone ?? null,
};


    return next();
  } catch (err) {
    // Invalid token → just behave as unauthenticated, let requireAuth handle blocking.
    console.warn("[authMiddleware] Invalid JWT:", (err as Error).message);
    return next();
  }
}

/**
 * requireAuth:
 *  - Ensures req.user exists.
 *  - If not, responds with 401 ApiError.
 */
export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
) {
  if (!req.user) {
    return res
      .status(401)
      .json(fail("AUTH_REQUIRED", "Please log in to access this resource."));
  }
  return next();
}

/**
 * requireRole("driver" | "admin" | "rider" | "subscriber"):
 *  - Ensures req.user exists and has the given role.
 */
export function requireRole(requiredRole: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res
        .status(401)
        .json(fail("AUTH_REQUIRED", "Please log in to access this resource."));
    }

    if (req.user.role !== requiredRole) {
      return res.status(403).json(
        fail(
          "AUTH_FORBIDDEN",
          `You need ${requiredRole} access to use this endpoint.`
        )
      );
    }

    return next();
  };
}
