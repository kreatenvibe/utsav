# Plan: Colony, Festival, Members tables (build order step 1)

## Goal
Stand up the DB foundation: connection pooling + the first three tables, with a
plain-SQL migration runner. No routes yet — this is schema + connectivity only.

## Files to add
- `db/pool.js` — exports a pg `Pool` built from `DATABASE_URL` (dotenv-loaded).
- `db/migrate.js` — tiny runner: reads `migrations/*.sql` in filename order,
  tracks applied files in a `schema_migrations` table, runs any not yet applied.
- `migrations/001_colony_festival_members.sql` — CREATE TABLE statements:
  - `colony` (colony_id PK, name, location)
  - `festival` (festival_id PK, colony_id FK → colony, name, year,
    current_balance numeric default 0 — cached/derived, updated by app logic later)
  - `members` (member_id PK, name, phone) — organizers + volunteers, unified
- `index.js` — minimal Express app: loads dotenv, creates the pool, one
  `GET /health` route that does `SELECT 1` to confirm DB connectivity, starts
  server on `PORT`.
- `package.json` — add `"migrate": "node db/migrate.js"` script.

## Notes / rules followed
- No ORM — raw SQL via `pg`, matching plain-SQL-migrations choice.
- `current_balance` on `festival` is the one intentionally-cached total per
  PROJECT_OVERVIEW.md; everything else (donated/paid totals) will be derived
  by summing rows, not stored, when those tables arrive in later steps.
- No status fields in this step (Colony/Festival/Members don't have any).
- ES modules throughout, per CLAUDE.md.

## Out of scope (later steps)
- Routes/services for these tables.
- Expected_Donations, Donations, Expenses, Expense_Payments, Tasks,
  Task_Assignments, Availability.

## Verification
- `npm run migrate` against the docker-compose Postgres creates the 3 tables.
- `npm run dev`, hit `GET /health`, confirm it returns DB-connected OK.
