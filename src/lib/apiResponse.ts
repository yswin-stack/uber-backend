import type { ApiError, ApiSuccess } from "../shared/types";

/**
 * Helper to build a standard success payload.
 * We ignore the optional statusCode argument here and let route handlers
 * choose the HTTP status when calling res.status(...).
 */
export function ok<T>(
  data: T,
  _statusCode: number = 200
): ApiSuccess<T> {
  return {
    ok: true,
    data,
  };
}

/**
 * Helper to build a standard error payload.
 * Callers are expected to choose the HTTP status code on the Express response.
 */
export function fail(
  code: string,
  message: string,
  _statusCode: number = 400
): ApiError {
  return {
    ok: false,
    code,
    message,
  };
}
