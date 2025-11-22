import { pool } from "./pool";

/**
 * Initialize DB:
 * - Ensure users table exists.
 * - Ensure name, work_address, school_address columns exist on users.
 *
 * This runs automatically on server start, so you don't need to run SQL manually.
 */
export async function initDb() {
  try {
    // 1) Make sure users table exists (if it's already there, this does nothing)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT NOT NULL,
        phone TEXT,
        pin TEXT NOT NULL,
        role TEXT DEFAULT 'subscriber'
      );
    `);

    // 2) Add extra columns if they don't exist yet
    await pool.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS name TEXT,
        ADD COLUMN IF NOT EXISTS work_address TEXT,
        ADD COLUMN IF NOT EXISTS school_address TEXT;
    `);

    console.log("✅ Database initialized (users + shortcut columns ensured).");
  } catch (err) {
    console.error("❌ Failed to initialize database", err);
    throw err;
  }
}

export default initDb;
