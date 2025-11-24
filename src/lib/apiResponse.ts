import { Response } from "express";
import type { ApiError, ApiSuccess } from "../shared/types";

/**
 * Helper to send a successful JSON response in the standard envelope:
 * { ok: true, data, ...data }
 *
 * We also spread the data at the top level so legacy callers that expect
 * just `{ rides: [...] }` or `{ user, token }` keep working.
 */
export function ok<T>(
  res: Response,
  data: T,
  statusCode = 200
): Response<ApiSuccess<T> & T> {
  const body: any = {
    ok: true as const,
    data,
  };

  if (data && typeof data === "object") {
    Object.assign(body, data);
  }

  return res.status(statusCode).json(body);
}

/**
 * Helper to send an error response in the standard envelope:
 * { ok: false, code, message, error }
 *
 * We keep `error` as an alias of `message` for older callers.
 */
export function fail(
  res: Response,
  code: string,
  message: string,
  statusCode = 400
): Response<ApiError> {
  const body: ApiError = {
    ok: false,
    code,
    message,
    error: message,
  };

  return res.status(statusCode).json(body);
}
