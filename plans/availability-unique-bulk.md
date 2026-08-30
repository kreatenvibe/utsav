# Availability: unique (user_id, date) + bulk create

## Problem
1. `availability` has no uniqueness constraint on `(user_id, date)` — the same
   date can be inserted multiple times for the same user, creating duplicate
   rows.
2. There's no way to submit multiple dates in one request (e.g. multi-day
   festivals like Navratri/Ganesh Utsav) — the mobile client would otherwise
   have to fire one `POST /availability` per day.

## Migration: `migrations/017_unique_user_availability_date.sql`
1. Deduplicate existing rows first, keeping the highest `availability_id` per
   `(user_id, date)`:
   ```sql
   DELETE FROM availability a
   USING availability b
   WHERE a.user_id = b.user_id
     AND a.date = b.date
     AND a.availability_id < b.availability_id;
   ```
2. Add the constraint:
   ```sql
   ALTER TABLE availability
   ADD CONSTRAINT uq_availability_user_date UNIQUE (user_id, date);
   ```

## Service changes (`services/availabilityService.js`)
- **`createAvailability`**: switch the INSERT to
  `ON CONFLICT (user_id, date) DO UPDATE SET is_available = EXCLUDED.is_available`
  so re-posting the same `(user_id, date)` updates the flag instead of
  throwing a duplicate-key error. Auth/validation unchanged (still
  `assertAdminOfAnyColony`, still requires `user_id`/`date`/boolean
  `is_available`).
- **New `bulkCreateAvailability({ user_id, dates, is_available }, actingUserId)`**:
  - Same auth gate as single create: `assertAdminOfAnyColony(actingUserId)`.
  - Validation: `user_id` required; `dates` must be a non-empty array of
    `YYYY-MM-DD` strings (regex check, reusing no new date library); a bad
    entry in the array is a 400 naming the offending value rather than
    silently dropping it; `is_available` must be a real boolean.
  - Query: single round-trip using `UNNEST`:
    ```sql
    INSERT INTO availability (user_id, date, is_available)
    SELECT $1, unnest($2::date[]), $3
    ON CONFLICT (user_id, date) DO UPDATE SET is_available = EXCLUDED.is_available
    RETURNING availability_id
    ```
    then re-fetch each row through the existing `BASE_SELECT`/`shape` so the
    response includes the inlined `user` object, consistent with every other
    GET in this service.
  - Same FK-violation → 400 translation as single create if `user_id` doesn't
    exist.
  - Returns the array of created/updated rows, ordered by `date`.

## Route (`routes/availability.js`)
- `POST /availability/bulk` — registered before nothing needs reordering
  (no `GET /:id`-style collision on POST). Same shape as every other route
  here: thin handler calling the service, `req.user.user_id` as
  `actingUserId`. 201 with the array. 400/403 bubble up from the service via
  the existing error handler (`err.status`) — no new auth middleware, since
  `assertAdminOfAnyColony` is already what every other write on this
  resource uses (the original prompt's "Colony Admin check" is this same
  gate under its actual name in this codebase).

## Not changing
- `updateAvailability`/`deleteAvailability`/`listAvailability`/`getAvailability`
  are untouched.
- No new npm dependency — `UNNEST` handles the multi-row insert without a
  batch-insert helper library.

## Verification
- Apply migration against the local docker Postgres; confirm
  `uq_availability_user_date` exists and any pre-existing duplicates were
  collapsed.
- `POST /availability` twice with the same `(user_id, date)` → second call
  updates `is_available` in place, no duplicate row, no 500.
- `POST /availability/bulk` with 3 dates → single 201 with 3 rows; re-running
  with an overlapping date set updates the overlap and adds the new ones.
- Bad input: empty `dates` array (400), a non-`YYYY-MM-DD` entry (400), bad
  `user_id` (400 FK), non-admin caller (403).
- `npm test` still green.

## Docs to update after implementation
- `docs/BACKEND_ANALYSIS.md`, `PROGRESS.md`,
  `Festival_Management_API.postman_collection.json` (new Bulk Create
  Availability request + updated Availability folder description).
