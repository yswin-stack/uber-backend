import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { fail } from "../lib/apiResponse";

export type Role = "subscriber" | "rider" | "driver" | "admin";

interface JwtPayload {
  id: number;
  role: string;
  phone?: string | null;
}

const JWT_SECRET = process.env.JWT_SECRET || "";

/**
 * Core auth middleware.
 *
 * - Tries JWT from Authorization: Bearer <token>
 * - Falls back to legacy x-user-id / x-user-role headers
 * - If `required` is true and no user -> 401
 * - If `allowedRoles` is set and role not in it -> 403
 */
export function authMiddleware(
  required: boolean = false,
  allowedRoles?: Role[]
) {
  return (req: Request, res: Response, next: NextFunction) => {
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
          const decodedRole = decoded.role;

          if (
            decodedRole === "subscriber" ||
            decodedRole === "rider" ||
            decodedRole === "driver" ||
            decodedRole === "admin"
          ) {
            user = {
              id: decoded.id,
              userId: decoded.id,
              role: decodedRole,
              phone: decoded.phone ?? null,
            };
          } else {
            console.warn("[auth] Unknown role in JWT:", decodedRole);
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
            if (legacyRole === "rider") role = "rider";
            if (legacyRole === "driver") role = "driver";
            if (legacyRole === "admin") role = "admin";

            user = { id, userId: id, role };
          }
        }
      }

      // 3) No auth user resolved
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

      // 4) Attach to req.user so routes can read it
      (req as any).user = user;

      // 5) Role check if required
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

/**
 * requireAuth
 *
 * Simple version of authMiddleware:
 * - Requires a logged-in user of ANY role
 */
export const requireAuth = authMiddleware(true);

/**
 * requireRole
 *
 * Ensure the user is logged in and has one of the allowed roles.
 *
 * Usage examples:
 *   router.get("/admin", requireRole("admin"), handler)
 *   router.get("/driver", requireRole(["driver", "admin"]), handler)
 */
export function requireRole(roleOrRoles: Role | Role[]) {
  const roles = Array.isArray(roleOrRoles) ? roleOrRoles : [roleOrRoles];
  return authMiddleware(true, roles);
}
