import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/auth";
import { ok, fail } from "../lib/apiResponse";
import { getCreditsSummaryForUser } from "../services/subscriptionService";
import { pool } from "../db/pool";

export const meRouter = Router();

/**
 * --------------------------------------------------
 *  GET /me/credits
 *  Returns the user's current ride credits summary
 * --------------------------------------------------
 */
meRouter.get("/credits", requireAuth, async (req: Request, res: Response) => {
  const authUser = req.user;
  if (!authUser) {
    return res
      .status(401)
      .json(fail("UNAUTHENTICATED", "Please log in to view credits."));
  }

  const userId = authUser.id;

  try {
    const summary = await getCreditsSummaryForUser(userId);
    return res.json(ok(summary));
  } catch (err) {
    console.error("Error in GET /me/credits:", err);
    return res
      .status(500)
      .json(
        fail(
          "CREDITS_FETCH_FAILED",
          "Failed to load your credit summary. Please try again."
        )
      );
  }
});

/**
 * --------------------------------------------------
 *  GET /me/profile
 *  Returns the logged-in user's basic profile info.
 * --------------------------------------------------
 */
meRouter.get("/profile", requireAuth, async (req: Request, res: Response) => {
  const authUser = req.user;
  if (!authUser) {
    return res
      .status(401)
      .json(fail("UNAUTHENTICATED", "Please log in to view your profile."));
  }

  const userId = authUser.id;

  try {
    const result = await pool.query(
      `
      SELECT
        id,
        name,
        phone,
        email,
        role
      FROM users
      WHERE id = $1
      LIMIT 1
      `,
      [userId]
    );

    if (!result.rowCount) {
      return res
        .status(404)
        .json(fail("USER_NOT_FOUND", "User profile not found."));
    }

    const row = result.rows[0];

    return res.json(
      ok({
        id: row.id,
        name: row.name,
        phone: row.phone,
        email: row.email,
        role: row.role,
      })
    );
  } catch (err) {
    console.error("Error in GET /me/profile:", err);
    return res
      .status(500)
      .json(
        fail(
          "PROFILE_FETCH_FAILED",
          "Failed to load your profile. Please try again."
        )
      );
  }
});

/**
 * --------------------------------------------------
 *  Types for schedule & locations
 * --------------------------------------------------
 */
type SavedLocationLabel = "home" | "work" | "school" | "other";

type SavedLocation = {
  id: number;
  user_id: number;
  label: SavedLocationLabel;
  address: string;
  created_at: string;
};

/**
 * --------------------------------------------------
 *  GET /me/locations
 *  Returns saved locations for the logged-in user.
 * --------------------------------------------------
 */
meRouter.get("/locations", requireAuth, async (req: Request, res: Response) => {
  const authUser = req.user;
  if (!authUser) {
    return res
      .status(401)
      .json(fail("UNAUTHENTICATED", "Please log in to view locations."));
  }

  const userId = authUser.id;

  try {
    const result = await pool.query(
      `
      SELECT id, user_id, label, address, created_at
      FROM saved_locations
      WHERE user_id = $1
      ORDER BY created_at ASC
      `,
      [userId]
    );

    const locations: SavedLocation[] = result.rows.map((row) => ({
      id: row.id,
      user_id: row.user_id,
      label: row.label,
      address: row.address,
      created_at: row.created_at,
    }));

    return res.json(ok({ locations }));
  } catch (err) {
    console.error("Error in GET /me/locations:", err);
    return res
      .status(500)
      .json(
        fail(
          "LOCATIONS_FETCH_FAILED",
          "Failed to load your locations. Please try again."
        )
      );
  }
});

/**
 * --------------------------------------------------
 *  POST /me/locations
 *  Create or update a saved location for the user.
 *
 *  Body:
 *    {
 *      label: "home" | "work" | "school" | "other";
 *      address: string;
 *    }
 *
 *  - If label already exists → updates that row.
 *  - Otherwise → inserts new row.
 * --------------------------------------------------
 */
meRouter.post(
  "/locations",
  requireAuth,
  async (req: Request, res: Response) => {
    const authUser = req.user;
    if (!authUser) {
      return res
        .status(401)
        .json(fail("UNAUTHENTICATED", "Please log in to save locations."));
    }

    const userId = authUser.id;

    const { label, address } = req.body as {
      label?: SavedLocationLabel;
      address?: string;
    };

    if (!label || !address || typeof address !== "string") {
      return res
        .status(400)
        .json(
          fail(
            "INVALID_LOCATION_INPUT",
            "Please provide a valid label and address."
          )
        );
    }

    try {
      // Check if a row already exists for this user + label
      const existing = await pool.query(
        `
        SELECT id
        FROM saved_locations
        WHERE user_id = $1 AND label = $2
        LIMIT 1
        `,
        [userId, label]
      );

      let saved: SavedLocation;

      if (existing.rowCount && existing.rows.length > 0) {
        const id = existing.rows[0].id;

        await pool.query(
          `
          UPDATE saved_locations
          SET address = $1
          WHERE id = $2
          `,
          [address, id]
        );

        const updated = await pool.query(
          `
          SELECT id, user_id, label, address, created_at
          FROM saved_locations
          WHERE id = $1
          LIMIT 1
          `,
          [id]
        );

        const row = updated.rows[0];
        saved = {
          id: row.id,
          user_id: row.user_id,
          label: row.label,
          address: row.address,
          created_at: row.created_at,
        };
      } else {
        const inserted = await pool.query(
          `
          INSERT INTO saved_locations (user_id, label, address)
          VALUES ($1, $2, $3)
          RETURNING id, user_id, label, address, created_at
          `,
          [userId, label, address]
        );

        const row = inserted.rows[0];
        saved = {
          id: row.id,
          user_id: row.user_id,
          label: row.label,
          address: row.address,
          created_at: row.created_at,
        };
      }

      return res.json(ok({ location: saved }));
    } catch (err) {
      console.error("Error in POST /me/locations:", err);
      return res
        .status(500)
        .json(
          fail(
            "LOCATION_SAVE_FAILED",
            "Failed to save this location. Please try again."
          )
        );
    }
  }
);

/**
 * --------------------------------------------------
 *  Types & helpers for weekly schedule
 * --------------------------------------------------
 */

type WeeklyScheduleRow = {
  id: number;
  user_id: number;
  day_of_week: number; // 1-7 (Mon-Sun)
  direction: "to_work" | "to_home";
  arrival_time: string; // "HH:MM:SS" (TIME)
  active: boolean;
};

type WeeklyScheduleResponse = {
  rows: WeeklyScheduleRow[];
};

type SaveScheduleBody = {
  rows: {
    day_of_week: number;
    direction: "to_work" | "to_home";
    arrival_time: string;
    active: boolean;
  }[];
};

/**
 * Extra type: per-day origin/destination override
 * for schedule → generate-rides.
 */
type ScheduleRouteOverride = {
  day_of_week: number;
  direction: "to_work" | "to_home";
  origin_label?: SavedLocationLabel;
  destination_label?: SavedLocationLabel;
};

/**
 * --------------------------------------------------
 *  GET /me/schedule
 *  Returns weekly schedule rows for the logged-in user.
 * --------------------------------------------------
 */
meRouter.get("/schedule", requireAuth, async (req: Request, res: Response) => {
  const authUser = req.user;
  if (!authUser) {
    return res
      .status(401)
      .json(fail("UNAUTHENTICATED", "Please log in to view schedule."));
  }

  const userId = authUser.id;

  try {
    const result = await pool.query(
      `
      SELECT
        id,
        user_id,
        day_of_week,
        direction,
        arrival_time,
        active
      FROM user_weekly_schedule
      WHERE user_id = $1
      ORDER BY day_of_week ASC, direction ASC
      `,
      [userId]
    );

    const rows: WeeklyScheduleRow[] = result.rows.map((row) => ({
      id: row.id,
      user_id: row.user_id,
      day_of_week: row.day_of_week,
      direction: row.direction,
      arrival_time: row.arrival_time,
      active: row.active,
    }));

    const response: WeeklyScheduleResponse = { rows };

    return res.json(ok(response));
  } catch (err) {
    console.error("Error in GET /me/schedule:", err);
    return res
      .status(500)
      .json(
        fail(
          "SCHEDULE_FETCH_FAILED",
          "Failed to load your schedule. Please try again."
        )
      );
  }
});

/**
 * --------------------------------------------------
 *  POST /me/schedule
 *  Save/update weekly schedule for the user
 * --------------------------------------------------
 */
meRouter.post(
  "/schedule",
  requireAuth,
  async (req: Request, res: Response) => {
    const authUser = req.user;
    if (!authUser) {
      return res
        .status(401)
        .json(fail("UNAUTHENTICATED", "Please log in to save schedule."));
    }

    const userId = authUser.id;
    const body = req.body as SaveScheduleBody;

    if (
      !body ||
      !Array.isArray(body.rows) ||
      body.rows.some(
        (r) =>
          typeof r.day_of_week !== "number" ||
          !["to_work", "to_home"].includes(r.direction) ||
          typeof r.arrival_time !== "string"
      )
    ) {
      return res
        .status(400)
        .json(
          fail(
            "INVALID_SCHEDULE_INPUT",
            "Invalid schedule payload. Please check your inputs."
          )
        );
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      await client.query(
        `
        DELETE FROM user_weekly_schedule
        WHERE user_id = $1
        `,
        [userId]
      );

      for (const row of body.rows) {
        await client.query(
          `
          INSERT INTO user_weekly_schedule (
            user_id,
            day_of_week,
            direction,
            arrival_time,
            active
          )
          VALUES ($1, $2, $3, $4, $5)
          `,
          [
            userId,
            row.day_of_week,
            row.direction,
            row.arrival_time,
            row.active,
          ]
        );
      }

      await client.query("COMMIT");

      return res.json(ok({ success: true }));
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("Error in POST /me/schedule:", err);
      return res
        .status(500)
        .json(
          fail(
            "SCHEDULE_SAVE_FAILED",
            "Failed to save your schedule. Please try again."
          )
        );
    } finally {
      client.release();
    }
  }
);

/**
 * --------------------------------------------------
 *  POST /me/schedule/generate-rides
 *  Generate upcoming rides from weekly schedule
 * --------------------------------------------------
 */
meRouter.post(
  "/schedule/generate-rides",
  requireAuth,
  async (req: Request, res: Response) => {
    const authUser = req.user;
    if (!authUser) {
      return res
        .status(401)
        .json(fail("UNAUTHENTICATED", "Please log in to generate rides."));
    }

    const userId = authUser.id;

    const body = req.body as {
      start_date?: string; // "YYYY-MM-DD"
      end_date?: string; // "YYYY-MM-DD"
      routes?: ScheduleRouteOverride[];
    };

    let startDate: Date;
    let endDate: Date;

    if (body.start_date && body.end_date) {
      startDate = new Date(body.start_date);
      endDate = new Date(body.end_date);
    } else {
      const now = new Date();
      startDate = new Date(now);
      startDate.setUTCHours(0, 0, 0, 0);
      endDate = new Date(startDate);
      endDate.setUTCDate(endDate.getUTCDate() + 14);
    }

    if (endDate <= startDate) {
      return res
        .status(400)
        .json(
          fail("INVALID_DATE_RANGE", "End date must be after the start date.")
        );
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const scheduleRes = await client.query(
        `
        SELECT
          id,
          user_id,
          day_of_week,
          direction,
          arrival_time,
          active
        FROM user_weekly_schedule
        WHERE user_id = $1
          AND active = true
        ORDER BY day_of_week ASC, direction ASC
        `,
        [userId]
      );

      const scheduleRows = scheduleRes.rows as {
        id: number;
        user_id: number;
        day_of_week: number;
        direction: string;
        arrival_time: string;
        active: boolean;
      }[];

      if (!scheduleRows.length) {
        await client.query("ROLLBACK");
        return res.json(
          ok({
            generated: 0,
            message: "No active schedule rows found.",
          })
        );
      }

      const locationsRes = await client.query(
        `
        SELECT id, user_id, label, address
        FROM saved_locations
        WHERE user_id = $1
        `,
        [userId]
      );

      const locationsByLabel: Record<string, string> = {};
      for (const row of locationsRes.rows) {
        locationsByLabel[row.label] = row.address;
      }

      function getAddress(label: SavedLocationLabel): string | null {
        return locationsByLabel[label] ?? null;
      }

      function getDefaultOriginAndDestination(
        direction: "to_work" | "to_home"
      ): { origin: string | null; destination: string | null } {
        const home = getAddress("home");
        const work = getAddress("work") ?? getAddress("school");

        if (!home || !work) {
          return { origin: null, destination: null };
        }

        if (direction === "to_work") {
          return { origin: home, destination: work };
        }

        return { origin: work, destination: home };
      }

      const scheduleOverrides = Array.isArray(body.routes)
        ? (body.routes as ScheduleRouteOverride[])
        : [];

      const routeOverrideMap = new Map<string, ScheduleRouteOverride>();
      for (const r of scheduleOverrides) {
        const key = `${r.day_of_week}-${r.direction}`;
        routeOverrideMap.set(key, r);
      }

      function getRouteFor(
        dayOfWeek: number,
        direction: "to_work" | "to_home"
      ): { origin: string | null; destination: string | null } {
        const key = `${dayOfWeek}-${direction}`;
        const override = routeOverrideMap.get(key);

        if (override) {
          const originLabel = override.origin_label ?? "home";
          const destinationLabel = override.destination_label ?? "work";
          const originAddress = getAddress(originLabel as SavedLocationLabel);
          const destinationAddress = getAddress(
            destinationLabel as SavedLocationLabel
          );
          return {
            origin: originAddress ?? null,
            destination: destinationAddress ?? null,
          };
        }

        return getDefaultOriginAndDestination(direction);
      }

      const dayMs = 24 * 60 * 60 * 1000;
      const scheduleByDay = new Map<number, WeeklyScheduleRow[]>();

      for (const r of scheduleRows) {
        const day = Number(r.day_of_week);
        if (!scheduleByDay.has(day)) {
          scheduleByDay.set(day, []);
        }

        const list = scheduleByDay.get(day)!;

        const direction: string = r.direction;
        const kind: "to_work" | "from_work" =
          direction === "to_work" ? "to_work" : "from_work";

        let arrival = String(r.arrival_time ?? "").trim();
        if (arrival.length === 5) {
          arrival = `${arrival}:00`;
        }

        list.push({
          id: r.id,
          user_id: r.user_id,
          day_of_week: day,
          direction: direction as "to_work" | "to_home",
          arrival_time: arrival,
          active: r.active,
        });
      }

      let generatedCount = 0;
      let deletedCount = 0;

      const deleteRes = await client.query(
        `
        DELETE FROM rides
        WHERE user_id = $1
          AND pickup_time >= $2
          AND pickup_time < $3
          AND is_fixed = true
        `,
        [userId, startDate.toISOString(), endDate.toISOString()]
      );

      deletedCount = deleteRes.rowCount ?? 0;

      for (
        let t = startDate.getTime();
        t < endDate.getTime();
        t += dayMs
      ) {
        const d = new Date(t);
        const dayOfWeek = d.getUTCDay() === 0 ? 7 : d.getUTCDay();

        const daySchedule = scheduleByDay.get(dayOfWeek);
        if (!daySchedule || daySchedule.length === 0) {
          continue;
        }

        for (const row of daySchedule) {
          const [h, m] = row.arrival_time.split(":");
          const arrivalDate = new Date(d);
          arrivalDate.setUTCHours(Number(h), Number(m), 0, 0);

          let pickupDate = new Date(arrivalDate);
          if (row.direction === "to_work") {
            pickupDate = new Date(arrivalDate.getTime() - 30 * 60000);
          } else {
            pickupDate = new Date(arrivalDate.getTime());
          }

          const route = getRouteFor(
            row.day_of_week,
            row.direction as "to_work" | "to_home"
          );
          if (!route.origin || !route.destination) {
            console.warn(
              "Skipping ride generation due to missing origin/destination:",
              {
                userId,
                dayOfWeek,
                direction: row.direction,
                route,
              }
            );
            continue;
          }

          await client.query(
            `
            INSERT INTO rides (
              user_id,
              pickup_location,
              dropoff_location,
              pickup_time,
              ride_type,
              is_fixed,
              status
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            `,
            [
              userId,
              route.origin,
              route.destination,
              pickupDate.toISOString(),
              "standard",
              true,
              "scheduled",
            ]
          );

          generatedCount += 1;
        }
      }

      await client.query("COMMIT");

      return res.json(
        ok({
          generated: generatedCount,
          deleted: deletedCount,
        })
      );
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("Error in POST /me/schedule/generate-rides:", err);
      return res
        .status(500)
        .json(
          fail(
            "GENERATE_RIDES_FAILED",
            "Failed to generate rides from your schedule."
          )
        );
    } finally {
      client.release();
    }
  }
);

/**
 * --------------------------------------------------
 *  POST /me/rides/:id/cancel
 *  Cancel a scheduled/confirmed ride for the current user.
 * --------------------------------------------------
 */
meRouter.post(
  "/rides/:id/cancel",
  requireAuth,
  async (req: Request, res: Response) => {
    const authUser = req.user;
    if (!authUser) {
      return res
        .status(401)
        .json(fail("UNAUTHENTICATED", "Please log in to cancel rides."));
    }

    const userId = authUser.id;
    const rideId = Number(req.params.id);

    if (!rideId || Number.isNaN(rideId)) {
      return res
        .status(400)
        .json(fail("INVALID_RIDE_ID", "Invalid ride ID parameter."));
    }

    try {
      const rideRes = await pool.query(
        `
        SELECT pickup_time, status
        FROM rides
        WHERE id = $1 AND user_id = $2
        LIMIT 1
        `,
        [rideId, userId]
      );

      if (!rideRes.rowCount) {
        return res
          .status(404)
          .json(fail("RIDE_NOT_FOUND", "Ride not found for this user."));
      }

      const ride = rideRes.rows[0] as {
        pickup_time: string;
        status: string;
      };

      const pickupTime = new Date(ride.pickup_time);
      const now = new Date();
      const diffMs = pickupTime.getTime() - now.getTime();
      const diffHours = diffMs / (1000 * 60 * 60);

      if (diffHours < 1) {
        return res
          .status(400)
          .json(
            fail(
              "CANNOT_CANCEL",
              "Rides can only be cancelled at least 1 hour in advance."
            )
          );
      }

      await pool.query(
        `
        UPDATE rides
        SET status = 'cancelled_by_user'
        WHERE id = $1
        `,
        [rideId]
      );

      return res.json(ok({ success: true }));
    } catch (err) {
      console.error("Error in POST /me/rides/:id/cancel:", err);
      return res
        .status(500)
        .json(
          fail(
            "CANCEL_RIDE_FAILED",
            "Failed to cancel this ride. Please try again."
          )
        );
    }
  }
);

/**
 * --------------------------------------------------
 *  POST /me/rides/:id/cancel (fallback for different schema)
 *  This block is used when rider_id column exists instead of user_id.
 * --------------------------------------------------
 */
meRouter.post(
  "/rides/:id/cancel-fallback",
  requireAuth,
  async (req: Request, res: Response) => {
    const authUser = req.user;
    if (!authUser) {
      return res
        .status(401)
        .json(fail("UNAUTHENTICATED", "Please log in to cancel rides."));
    }

    const userId = authUser.id;
    const rideId = Number(req.params.id);

    if (!rideId || Number.isNaN(rideId)) {
      return res
        .status(400)
        .json(fail("INVALID_RIDE_ID", "Invalid ride ID parameter."));
    }

    try {
      let rideRes;
      try {
        rideRes = await pool.query(
          `
          SELECT pickup_time, status
          FROM rides
          WHERE id = $1 AND rider_id = $2
          LIMIT 1
          `,
          [rideId, userId]
        );
      } catch (err: any) {
        if (
          err &&
          (err.code === "42703" ||
            (typeof err.message === "string" &&
              err.message.includes("rider_id")))
        ) {
          rideRes = await pool.query(
            `
            SELECT pickup_time, status
            FROM rides
            WHERE id = $1 AND user_id = $2
            LIMIT 1
            `,
            [rideId, userId]
          );
        } else {
          throw err;
        }
      }

      if (!rideRes.rowCount) {
        return res
          .status(404)
          .json(fail("RIDE_NOT_FOUND", "Ride not found for this user."));
      }

      const ride = rideRes.rows[0] as {
        pickup_time: string;
        status: string;
      };

      const pickupTime = new Date(ride.pickup_time);
      const now = new Date();
      const diffMs = pickupTime.getTime() - now.getTime();
      const diffHours = diffMs / (1000 * 60 * 60);

      if (diffHours < 1) {
        return res
          .status(400)
          .json(
            fail(
              "CANNOT_CANCEL",
              "Rides can only be cancelled at least 1 hour in advance."
            )
          );
      }

      await pool.query(
        `
        UPDATE rides
        SET status = 'cancelled_by_user'
        WHERE id = $1
        `,
        [rideId]
      );

      return res.json(ok({ success: true }));
    } catch (err) {
      console.error("Error in POST /me/rides/:id/cancel-fallback:", err);
      return res
        .status(500)
        .json(
          fail(
            "CANCEL_RIDE_FAILED",
            "Failed to cancel this ride. Please try again."
          )
        );
    }
  }
);

/**
 * --------------------------------------------------
 *  POST /me/onboarding/skip
 *  Mark onboarding as skipped for the current user.
 * --------------------------------------------------
 */
meRouter.post(
  "/onboarding/skip",
  requireAuth,
  async (req: Request, res: Response) => {
    const authUser = req.user;
    if (!authUser) {
      return res
        .status(401)
        .json(
          fail("UNAUTHENTICATED", "Please log in to skip onboarding.")
        );
    }

    const userId = authUser.id;

    try {
      await pool.query(
        `
        UPDATE users
        SET onboarding_skipped = TRUE
        WHERE id = $1
        `,
        [userId]
      );

      return res.json(
        ok({
          onboarding_skipped: true,
        })
      );
    } catch (err) {
      console.error("Error in POST /me/onboarding/skip:", err);
      return res
        .status(500)
        .json(
          fail(
            "ONBOARDING_SKIP_FAILED",
            "Failed to skip onboarding for user."
          )
        );
    }
  }
);

/**
 * --------------------------------------------------
 *  GET /me/setup
 *  Simple onboarding flags.
 *
 *  {
 *    has_home: boolean;
 *    has_work: boolean;   // work OR school
 *    has_schedule: boolean;
 *    onboarding_completed: boolean;
 *    onboarding_skipped: boolean;
 *    driver_is_online: boolean;
 *  }
 * --------------------------------------------------
 */

// Helper to satisfy TypeScript for rowCount (number | null)
function hasAnyRows(
  result: { rowCount: number | null } | null | undefined
): boolean {
  return (
    !!result && typeof result.rowCount === "number" && result.rowCount > 0
  );
}

meRouter.get("/setup", requireAuth, async (req: Request, res: Response) => {
  const authUser = req.user;
  if (!authUser) {
    return res
      .status(401)
      .json(
        fail("UNAUTHENTICATED", "Please log in to view setup status.")
      );
  }

  const userId = authUser.id;

  try {
    const [homeRes, workRes, scheduleRes, userRes] = await Promise.all([
      pool.query(
        `
        SELECT 1
        FROM saved_locations
        WHERE user_id = $1 AND label = 'home'
        LIMIT 1
        `,
        [userId]
      ),
      pool.query(
        `
        SELECT 1
        FROM saved_locations
        WHERE user_id = $1 AND (label = 'work' OR label = 'school')
        LIMIT 1
        `,
        [userId]
      ),
      pool.query(
        `
        SELECT 1
        FROM user_schedules
        WHERE user_id = $1
        LIMIT 1
        `,
        [userId]
      ),
      pool.query(
        `
        SELECT
          onboarding_completed,
          onboarding_skipped,
          driver_is_online,
          driver_last_online_at
        FROM users
        WHERE id = $1
        LIMIT 1
        `,
        [userId]
      ),
    ]);

    const has_home = hasAnyRows(homeRes);
    const has_work = hasAnyRows(workRes);
    const has_schedule = hasAnyRows(scheduleRes);

    const userRow =
      userRes &&
      (userRes as any).rows &&
      Array.isArray((userRes as any).rows)
        ? (userRes as any).rows[0]
        : undefined;

    return res.json(
      ok({
        has_home,
        has_work,
        has_schedule,
        onboarding_completed: !!(
          userRow && userRow.onboarding_completed
        ),
        onboarding_skipped: !!(userRow && userRow.onboarding_skipped),
        driver_is_online: !!(userRow && userRow.driver_is_online),
      })
    );
  } catch (err) {
    console.error("Error in GET /me/setup:", err);
    return res
      .status(500)
      .json(
        fail(
          "SETUP_CHECK_FAILED",
          "Failed to check setup status."
        )
      );
  }
});

export default meRouter;
