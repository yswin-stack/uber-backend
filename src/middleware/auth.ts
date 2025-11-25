import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { fail } from "../lib/apiResponse";

type Role = "subscriber" | "driver" | "admin";

interface JwtPayload {
  id: number;
  role: string;
  phone?: string | null;
}

const JWT_SECRET = process.env.JWT_SECRET || "";

export function authMiddleware(required = false, allowedRoles?: Role[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      let user:
        | { id: number; userId: number; role: Role; phone?: string | null }
        | null = null;

      // 1) Try JWT in Authorization header
      const authHeader = req.headers.authorization;
      const token =
        authHeader && authHeader.startsWith("Bearer ")
          ? authHeader.slice("Bearer ".length)
          : undefined;

      if (token && JWT_SECRET) {
        try {
          const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
          const role = decoded.role as Role;

          if (
            role === "subscriber" ||
            role === "driver" ||
            role === "admin"
          ) {
            user = {
              id: decoded.id,
              userId: decoded.id,
              role,
              phone: decoded.phone ?? null,
            };
          }
        } catch (err) {
          console.warn("[auth] Invalid JWT:", err);
        }
      }

      // 2) Fallback: legacy x-user-id / x-user-role headers (V1 behaviour)
      if (!user) {
        const legacyId = req.header("x-user-id");
        if (legacyId) {
          const id = Number(legacyId);
          if (!Number.isNaN(id)) {
            let role: Role = "subscriber";
            const legacyRole = req.header("x-user-role");
            if (legacyRole === "driver") role = "driver";
            if (legacyRole === "admin") role = "admin";

            user = { id, userId: id, role };
          }
        }
      }

      // 3) No auth
      if (!user) {
        if (required) {
          return res
            .status(401)
            .json(
              fail(
                "AUTH_REQUIRED",
                "Please log in to access this resource."
              )
            );
        }
        return next();
      }

      // 4) Attach to req.user
      (req as any).user = user;

      // 5) Role gate
      if (allowedRoles && !allowedRoles.includes(user.role)) {
        return res
          .status(403)
          .json(
            fail(
              "AUTH_FORBIDDEN",
              "You do not have access to this resource."
            )
          );
      }

      return next();
    } catch (err) {
      console.error("[auth] Unexpected error:", err);
      if (required) {
        return res
          .status(500)
          .json(
            fail("AUTH_INTERNAL_ERROR", "Internal authorization error.")
          );
      }
      return next();
    }
  };
}
