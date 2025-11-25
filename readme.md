## Backend V2 Overview

### Auth

- JWT-based auth (HS256) with `JWT_SECRET` and `JWT_EXPIRES_IN`.
- `POST /auth/login` returns `{ ok: true, data: { user, token } }`.
- `requireAuth` middleware populates `req.user = { id, role }`.

### Plans & Credits

- `subscription_plans`, `subscriptions`, and `ride_credits_monthly` tables.
- Admin flow:
  - Rider requests a plan via `POST /plans/request`.
  - Admin activates via `POST /admin/subscriptions/:userId/activate`.
- Credit enforcement on `/rides` booking:
  - Standard vs grocery credits.
  - Monthly reset job (cron) uses `ride_credits_monthly`.

### Scheduling & Rides

- Weekly schedule templates → nightly generator job (`src/jobs/generateUpcomingRides.ts`).
- AI config & predictive engine used for:
  - Pickup windows
  - Arrival windows
  - Capacity checks & overlap rules.

### Real-time Tracking

- Socket.IO under the same server.
- `setupTrackingSockets(io)` handles `location_update` and emits `ride_eta_update`.

### Analytics & Error Handling

- `src/services/analytics.ts`:
  - Events: `login`, `subscription_activate`, `ride_created`, `ride_completed`, `ride_cancelled`.
  - Logs structured JSON to stdout and optionally to `analytics_events` table.
- `src/middleware/errorHandler.ts`:
  - `notFoundHandler` returns `ApiError` shape for 404s.
  - `errorHandler` centralizes unhandled errors into `{ ok: false, code, message }`.
