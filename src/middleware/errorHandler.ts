// src/middleware/errorHandler.ts
import type { Request, Response, NextFunction } from "express";
import { fail } from "../lib/apiResponse";

/**
 * 404 handler – MUST be registered after all routes.
 */
export function notFoundHandler(
  req: Request,
  res: Response,
  _next: NextFunction
) {
  return res.status(404).json(
    fail(
      "NOT_FOUND",
      `Route ${req.method} ${req.originalUrl} was not found on this server.`
    )
  );
}

/**
 * Global error handler – catches thrown errors and ensures a consistent ApiError shape.
 */
export function errorHandler(
  err: any,
  req: Request,
  res: Response,
  _next: NextFunction
) {
  // eslint-disable-next-line no-console
  console.error(
    "[error]",
    req.method,
    req.originalUrl,
    "-",
    err && err.stack ? err.stack : err
  );

  if (res.headersSent) {
    return;
  }

  const statusCodeRaw =
    typeof err?.statusCode === "number"
      ? err.statusCode
      : typeof err?.status === "number"
      ? err.status
      : 500;

  const statusCode =
    statusCodeRaw >= 400 && statusCodeRaw <= 599 ? statusCodeRaw : 500;

  const code =
    typeof err?.code === "string" && err.code.trim().length > 0
      ? err.code
      : "INTERNAL_ERROR";

  const message =
    statusCode === 500
      ? "Something went wrong. Please try again."
      : err?.message || "Request failed.";

  return res.status(statusCode).json(fail(code, message, statusCode));
}
