/**
 * Time utilities.
 *
 * Convention: all timestamps persisted in the database are UTC ISO strings.
 * We keep presentation in the app localised to APP_TIMEZONE ("America/Winnipeg").
 */

/**
 * Convert a Date to a UTC ISO string suitable for storing in the DB.
 */
export function toUtcIso(date: Date): string {
  return new Date(date.getTime()).toISOString();
}

/**
 * Parse a UTC ISO timestamp coming from the DB.
 */
export function parseUtc(isoString: string): Date {
  return new Date(isoString);
}

/**
 * Convert a local Date (server-local timezone) to a new Date object representing
 * the same wall-clock time in UTC.
 *
 * NOTE: this is a simple helper that relies on the Node.js process timezone.
 * For more advanced timezone handling we can introduce a dedicated library later.
 */
export function localToUtc(localDate: Date): Date {
  const offsetMinutes = localDate.getTimezoneOffset();
  return new Date(localDate.getTime() - offsetMinutes * 60_000);
}

/**
 * Convert a UTC Date to the server-local timezone.
 */
export function utcToLocal(utcDate: Date): Date {
  const offsetMinutes = utcDate.getTimezoneOffset();
  return new Date(utcDate.getTime() + offsetMinutes * 60_000);
}
