# Migrate hosting off Render → Vercel (app) + Neon (Postgres)

## Goal
Remove the Render dependency entirely. App moves to Vercel serverless
hosting; database moves to Neon Postgres. No behavior change for API
consumers — same routes, same auth, same response shapes.

## Why this is low-risk for this codebase
- `app.js`/`index.js` are already split (done for testability) — `app.js`
  exports the configured Express app with no `.listen()` call, which is
  exactly what a Vercel serverless entry point needs. No route/service code
  changes required.
- All SQL goes through `db/pool.js`'s single `pg.Pool` reading
  `DATABASE_URL` — swapping the connection string is enough; no ORM/driver
  rewrite needed. (Not switching to `@neondatabase/serverless` — that would
  mean touching every service file's queries for no functional gain here,
  since Neon accepts plain `pg` connections over TLS same as Render did.)
- File uploads (`multer`) already use memory storage, never touch disk —
  no serverless filesystem concerns.
- No background jobs, no websockets, no long-running requests beyond a
  bulk CSV/XLSX import — well within Vercel's default function duration.

## Steps

### 1. Provision Neon
- Create Neon Postgres via the Vercel Marketplace integration (once the
  Vercel project exists — step 2) rather than a standalone Neon account,
  so `DATABASE_URL` gets injected into the Vercel project automatically.
- Use the **pooled** connection string Neon/Vercel provisions as
  `DATABASE_URL` (matches what `db/pool.js` already reads — no code
  change). Neon's pooler (PgBouncer, transaction mode) is what makes a
  plain `pg.Pool` safe to use from serverless functions.

### 2. Add the Vercel entry point
- New `api/index.js`:
  ```js
  import { app } from '../app.js';
  export default app;
  ```
- New `vercel.json` at repo root:
  ```json
  {
    "rewrites": [{ "source": "/(.*)", "destination": "/api/index" }]
  }
  ```
  Express keeps doing its own internal routing — this just points every
  request at the one function.
- `index.js` (the `.listen()` entry) stays unchanged — still used for
  local `npm run dev`/`npm start`; Vercel never calls it.

### 3. Env vars on Vercel
- `DATABASE_URL` — from the Neon Marketplace integration (step 1).
- `JWT_SECRET` — copy the current value in (same secret, so existing
  issued tokens don't all invalidate on cutover — confirm with user
  whether that matters or a fresh secret is fine).
- `PORT` — not needed on Vercel (serverless has no explicit listen port);
  harmless to leave unset there.

### 4. Run migrations against Neon
- `npm run migrate` from a machine that can reach Neon (unlike Render's
  internal-only hostname, Neon's host is publicly reachable, so this
  finally removes the "can't migrate from a local machine" friction
  flagged repeatedly in PROGRESS.md).
- Confirms all 18 migrations apply cleanly to a fresh database.

### 5. Test against Neon
- Temporarily point local `.env` at the Neon connection string, `npm test`
  (same swap-and-restore convention already used in this repo for the
  docker DB), confirm all existing tests pass unchanged.

### 6. Deploy + cut over
- `vercel link` to create/connect the project, `vercel --prod` to deploy.
- Smoke-test: `GET /health`, login, one write endpoint.
- Update `Festival_Management_API.postman_collection.json`'s `baseUrl` to
  the new Vercel URL.
- Once confirmed working, decommission the Render web service + Postgres
  instance (user's call on timing — keep Render running in parallel for a
  short overlap window as a rollback option).

### 7. Docs
- `docs/BACKEND_ANALYSIS.md` §11 currently has a Render-specific
  deployment note (internal hostname, migration-reachability caveat) —
  update it to describe the Neon/Vercel setup instead.
- `PROGRESS.md` — new entry once done, noting the hosting change and that
  the long-standing "migrations can't reach Render's internal host"
  friction is resolved as a side effect.

## Decisions (confirmed with user)
- No data migration — current Render Postgres is test/seed data only,
  fine to recreate fresh via `npm run migrate` against Neon (same as every
  prior schema-wipe decision in this project's history).
- Decommission Render entirely (both the web service and its Postgres)
  once the Vercel + Neon setup is confirmed working — no parallel-run
  rollback window wanted.
- `JWT_SECRET`: reusing the existing value (no real users/tokens to
  invalidate, and it keeps one fewer moving part) unless the user says
  otherwise before deploy.

## Account-level steps only the user can do
Vercel project creation/GitHub linking and the Neon Marketplace
install both go through first-time browser/OAuth consent — not
something drivable headlessly from here. See chat for the exact
checklist handed to the user.
