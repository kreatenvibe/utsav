# Progress

## Status: Core CRUD build order complete

## Build order
1. [x] Colony, Festival, Members tables
2. [x] Expected_Donations, Donations
3. [x] Expenses, Expense_Payments
4. [x] Tasks, Task_Assignments, Availability

## Currently working on
All four numbered build-order layers have routes/services, plus
`festival.current_balance` is derived, DELETE exists for
donations/expense_payments/expenses (soft) and tasks/availability (hard),
JWT auth guards all write endpoints, and colony membership/write-permission
is now enforced (see below). Next: not yet decided — candidates are DELETE
for colonies/festivals/members/donors/expected_donations (still deferred,
cascade behavior not decided), or the deferred gaps flagged under colony
membership below (walk-in donations, availability, self-leave). Ask user
before picking.

## Done
- **Colony membership / write-permission model** (see
  `plans/colony-membership.md`): new `colony_memberships` table
  (`migrations/009_colony_memberships.sql`: `colony_id`, `user_id`, `role`
  `'admin'|'member'`, unique per colony+user) — named to avoid confusion with
  the existing unrelated `members` table (festival volunteers, no relation to
  login identity). `services/colonyMembershipService.js` (new): membership/
  admin checks (`assertColonyMember`/`assertColonyAdmin`, 403), colony_id
  resolvers for each FK chain (`colonyIdForFestival`/`colonyIdForExpense`/
  `colonyIdForTask`/`colonyIdForExpectedDonation`), `listMyColonies`,
  `listColonyMembers`, `addMember` (409 on dup), `updateMemberRole` and
  `removeMember` (both reject shrinking a colony to zero admins, 400).
  `colonyService.createColony` now wraps the colony insert + auto-admin
  membership insert in one transaction (mirrors `db/migrate.js`'s
  BEGIN/COMMIT/ROLLBACK style — first multi-table invariant in the app).
  `colonyService.updateColony` is now **admin-only** (confirmed with user —
  treated like a WhatsApp group's settings, not regular member-writable
  content). New routes on `routes/colonies.js`: `GET /mine` (registered before
  `GET /:id`), `GET /:id/members`, `POST /:id/members`, `PATCH
  /:id/members/:userId`, `DELETE /:id/members/:userId` — the two GETs are the
  only reads in the whole app that require auth (membership rows expose other
  users' emails). Every other mutating service (festivals, expected_donations,
  donations, expenses, expense_payments, tasks, task_assignments) now takes an
  extra `actingUserId` param (never merged into the body object, always the
  verified `req.user.user_id`) and asserts colony membership before writing,
  resolved via the appropriate FK chain; create paths skip the check if the
  raw id doesn't resolve at all (existing FK-violation 400 still fires
  unchanged); update/delete paths already fetch the row first (existing
  `getX(id)` calls), so no skip logic needed there — not an info leak since
  every GET in this app is already fully public.
  **Deliberately left unscoped** (flagged, not silently decided): walk-in
  donations (`donations.expected_id IS NULL` — no festival/colony link
  possible under the current schema), `availability` (no `festival_id`/
  `colony_id` column at all), `members`/`donors` (global rosters, no
  `colony_id` column). **Also flagged**: no self-service "leave a colony" —
  only admins can remove members, including other admins (down to but not
  including the last one).
  Split `index.js` into `app.js` (exports the Express `app`, no `.listen()`)
  + a thin `index.js` (imports `app`, calls `.listen()`) so the app can be
  driven in-process by tests. Added `supertest` devDependency,
  `"test": "node --test"` (Node's built-in runner, no new test-runner dep).
  New `test/colonyMembership.test.js` (9 cases) — runs against a real
  Postgres (no mocking, matching this repo's existing manual-verification
  philosophy), covers: colony creation auto-admins the creator; non-members
  blocked (403) on colony/festival/expense/expense_payment/task/
  task_assignment/donation writes; non-admin blocked (403) from
  managing membership; sole-admin removal/demotion rejected (400);
  unauthenticated writes still 401; reads still public with no token; the
  expected_id→festival→colony donation chain is enforced but walk-in
  donations (no expected_id) remain unscoped by design.
  **DB caveat**: `.env`'s `DATABASE_URL` currently points at a Render Postgres
  instance using its *internal* hostname (`dpg-...-a` with no region suffix),
  which only resolves from inside Render's network — unreachable from this
  machine. Verified this feature (migration + full test suite, all 9 passing)
  against the local docker-compose Postgres instead (temporarily flipped
  which `DATABASE_URL` line was active, then restored `.env` to the Render
  line afterward). **`migrations/009_colony_memberships.sql` has NOT been
  applied to the Render DB** — that needs to happen through Render's own
  tooling (dashboard console, or `npm run migrate` from an environment that
  can reach the internal host) before this feature works against production.
- **JWT auth** (see `plans/auth.md`): new `users` table
  (`migrations/008_users.sql`, email + bcryptjs password hash, separate from
  `members` since login identity isn't festival/volunteer data), 
  `services/authService.js` (`registerUser`/`loginUser`, same
  throw-with-`.status` convention as other services), `middleware/auth.js`
  (`requireAuth` — verifies `Authorization: Bearer <jwt>`, 401 on
  missing/invalid/expired), `routes/auth.js` (`POST /auth/register` open to
  anyone — no roles system yet so any registered user is an "organizer";
  `POST /auth/login` returns `{ token }`, 7-day expiry). `index.js` applies
  `requireAuth` as one global middleware for POST/PUT/PATCH/DELETE (this app
  uses PATCH not PUT for updates, so PATCH is guarded too even though not
  explicitly named) mounted after `/auth` so register/login stay public; all
  GET routes remain open. New env var `JWT_SECRET` in `.env` (gitignored).
  New deps `bcryptjs` (pure JS, avoids native `bcrypt` build on Windows) and
  `jsonwebtoken`. No roles/permissions — deliberately deferred, flagged as a
  "next" candidate above. Manually verified against the docker Postgres +
  running server: register (201, no hash in response) + duplicate email
  (409) + missing field (400); login correct creds (200 + token) + wrong
  password (401) + unknown email (401, same message as wrong password so
  login doesn't leak which emails are registered); `POST /colonies` with no
  `Authorization` header (401), with a valid token (201, unchanged
  behavior), with a garbage token (401); `GET /colonies` with no header
  still works (reads unaffected).
- **DELETE endpoints** (see `plans/delete-endpoints.md`): user specified
  soft delete for the money-tracking tables, hard delete for lower-stakes
  ones.
  - Soft delete (`deleted_at TIMESTAMPTZ`, added by
    `migrations/007_soft_delete_money_tables.sql`) on `donations`,
    `expense_payments`, `expenses`. `DELETE` sets `deleted_at = now()`;
    list/get everywhere filter `deleted_at IS NULL`, so a soft-deleted row
    reads as 404/absent, same as a hard-deleted one would. This doesn't
    conflict with "money fields never edited after creation" (CLAUDE.md) —
    `amount`/`amount_planned` are never touched, only the new audit column.
    The derived sums that roll these up — `expected_donations.total_donated`,
    `expenses.total_paid`, and `festival.current_balance` — all exclude
    soft-deleted rows now (join conditions / subquery WHERE clauses updated
    in `expectedDonationService.js`, `expenseService.js`,
    `festivalService.js`). Not blocking creation of a new expense_payment
    against a soft-deleted expense (FK still intact) — flagged, not fixed,
    since it wasn't asked for.
  - Hard delete on `tasks` (`taskService.deleteTask`) and `availability`
    (`availabilityService.deleteAvailability`). Deleting a task with
    existing `task_assignments` hits a real FK violation (no `ON DELETE`
    clause in migration 004) — caught and returned as 400 ("remove those
    first") instead of a raw 500. `task_assignments` itself already had
    hard DELETE from the previous layer, unchanged.
  - Explicitly did NOT add DELETE for colonies/festivals/members/donors/
    expected_donations — cascade behavior (RESTRICT/CASCADE/SET NULL) was
    flagged as undecided back in the first build-order layer and still is;
    didn't want to guess silently on a schema-level FK behavior decision.
  - Manually verified against the docker Postgres: soft-deleted a donation
    → confirmed 404 on GET, gone from list, its expected_donation's
    total_donated dropped, festival's current_balance shifted correctly;
    same chain for an expense_payment (total_paid dropped, balance
    shifted) and a whole expense (disappeared from list, balance shifted
    again); double-DELETE on an already-deleted donation returned 404, not
    a crash; hard-deleted an availability row (204, then 404 on GET);
    attempted to hard-delete a task with a live task_assignment (400, not
    500), removed the assignment, delete succeeded (204).
- **`festival.current_balance` derivation** (see
  `plans/festival-current-balance.md`): resolved a conflict between the
  stored `festival.current_balance NUMERIC` column (migration 001) and the
  CLAUDE.md rule that totals — "balance" explicitly named — must be summed,
  not stored as counters. Confirmed with user: dropped the column
  (`migrations/006_drop_festival_current_balance.sql`), `festivalService.js`
  now computes it at query time on every GET (single or list) as
  `SUM(donations.amount via expected_donations.festival_id) −
  SUM(expense_payments.amount via expenses.festival_id)`, using two
  correlated subqueries (not a join) to avoid a fan-out double-count.
  **Scope decision**: only donations tied to an `expected_donations` row
  count toward a festival's balance — walk-in donations
  (`donations.expected_id IS NULL`) have no path to a `festival_id` under
  the current schema, so they're excluded (same tradeoff already accepted
  elsewhere for the nullable `expected_id`). `current_balance` stays
  read-only — not accepted on PATCH (silently ignored, same as before).
  Manually verified against the docker Postgres: existing test data (3500
  in matched donations − 3500 in expense_payments) computed to 0, then
  added a new expected_donation + donation and confirmed the balance
  shifted to 800.
- Tasks/Task_Assignments/Availability routes + services (see
  `plans/tasks-assignments-availability-routes.md`): `routes/tasks.js`,
  `routes/taskAssignments.js`, `routes/availability.js` with matching
  services. `tasks` gets POST/GET/GET:id/PATCH — `status` PATCH relies on
  the DB CHECK constraint from migration 005 (`planned`/`in_progress`/
  `done`), caught as a 400 rather than re-validated in JS (single source of
  truth). `task_assignments` is a junction table with **no PATCH** but
  **does have DELETE** (cancels a signup) — deliberate departure from the
  "no DELETE" pattern used elsewhere, justified because
  PROJECT_OVERVIEW.md describes signup as informal/unenforced, not a
  frozen fact or FK-referenced-elsewhere row. `availability` gets POST/GET/
  GET:id/PATCH — PATCH only accepts `is_available` (member_id/date are the
  row's identity, not editable). Manually verified against the docker
  Postgres: task create + bad-FK 400 + missing-field 400, status PATCH
  validation (bad value 400, `in_progress` accepted), task_assignment
  create/list/delete (204) + confirmed 404 on PATCH, availability create +
  date came back unshifted (confirms the pool.js DATE fix still applies)
  + PATCH flip of `is_available` + filtered list.
- Expenses/Expense_Payments routes + services (see
  `plans/expenses-expense-payments-routes.md`): `routes/expenses.js`,
  `routes/expensePayments.js` with matching services. Mirrors the
  Expected_Donations/Donations shape exactly — `expenses` gets
  POST/GET/GET:id/PATCH with a computed `total_paid` (summed from
  `expense_payments` at query time) and organizer-set `status`
  (open/settled, validated on PATCH); **expense_payments has no
  PATCH/DELETE at all** — `amount` is a frozen fact once inserted.
  `expense_payments.paid_by` is nullable. Manually verified against the
  docker Postgres: create expense, 2 partial payments summing to
  total_paid=3500, bad-FK 400, missing-required-field 400, status PATCH
  validation (rejects bad value, accepts 'settled'), no PATCH/DELETE route
  on expense_payments (404).
- **`db/pool.js` DATE fix**: `pg` parses `DATE` columns as JS `Date` objects
  at local midnight; serializing to JSON then converts to UTC, shifting the
  day back by one in any timezone ahead of UTC (bit us in IST while testing
  `donations.date`). Fixed globally with `types.setTypeParser(1082, val =>
  val)` in `db/pool.js`, so `DATE` columns come back as the raw `YYYY-MM-DD`
  string. Applies to every `DATE` column in the schema (`donations.date`,
  `expense_payments.date`, `tasks.planned_date`, `availability.date`), not
  just this feature — keep this in mind, don't re-introduce per-field date
  parsing later that fights this.
- Donors/Expected_Donations/Donations routes + services (see
  `plans/expected-donations-donations-routes.md`): `routes/donors.js`,
  `routes/expectedDonations.js`, `routes/donations.js` with matching
  services. Donors and expected_donations get full CRUD (minus DELETE);
  **donations has no PATCH/DELETE at all** — `amount` is a frozen fact once
  inserted. `expected_donations` GET responses include a computed
  `total_donated` (summed from `donations` at query time, not stored).
  `donations.expected_id` is nullable for walk-in donations not tied to an
  expectation. Manually verified: full flow (donor → expected_donation → 2
  partial donations → total_donated=3500), walk-in donation with no
  expected_id, status PATCH validation, bad-FK 400s, no route for
  donation PATCH (404).
- Colony/Festival/Members routes + services (see
  `plans/colony-festival-members-routes.md`): `routes/colonies.js`,
  `routes/festivals.js`, `routes/members.js` with matching
  `services/*Service.js`. POST/GET/GET:id/PATCH only — no DELETE (FK-referenced
  everywhere, cascade behavior not yet decided). `festival.current_balance` is
  intentionally not settable via PATCH — stays app-derived once
  donations/expenses routes exist. `index.js` now has `express.json()`, the
  three routers mounted, and a centralized error handler using `err.status`.
  Manually verified against the docker Postgres: full CRUD, `?colony_id=`
  filter on festivals, 404 on missing id, 400 on bad FK and missing required
  field. Left 1 test colony/festival/member row in the DB (ids 1/1/1) — not
  cleaned up, harmless dev data.
- DB foundation: `db/pool.js` (pg Pool from DATABASE_URL), `db/migrate.js`
  (plain-SQL migration runner, tracks applied files in `schema_migrations`),
  `migrations/001_colony_festival_members.sql` (colony, festival, members).
- `index.js`: minimal Express app with `GET /health` (checks DB connectivity).
- `npm run migrate` script added.
- `migrations/002_expected_donations_donations.sql`: donors (prerequisite
  table, not in the numbered build order but required by donor_id FKs),
  expected_donations, donations. `donations.expected_id` is nullable to
  allow walk-in donations not tied to a prior expectation — flagged to user,
  not yet confirmed.
- `migrations/003_expenses_expense_payments.sql`: expenses, expense_payments.
- `migrations/004_tasks_assignments_availability.sql`: tasks, task_assignments,
  availability.
- `migrations/005_tasks_status_check.sql`: confirmed with user — tasks.status
  now CHECK IN ('planned', 'in_progress', 'done'), default changed from
  'open' to 'planned' to match.

## Lessons learned
- **`.env`'s `DATABASE_URL` points at a Render Postgres instance by its
  internal hostname** (`dpg-...-a`, no region suffix) — this only resolves
  from inside Render's own network, not from a local machine. `npm run
  migrate` and `npm test` need a reachable DB: either swap in the local
  docker-compose line (commented out just above the Render line in `.env`)
  and `docker compose up -d` first, or use Render's *external* connection
  string if testing against that instance specifically. Remember to swap
  `.env` back afterward — don't leave it pointed at localhost.
- This machine has a **native Windows PostgreSQL service already listening on
  port 5432**, alongside Docker Desktop's port-forwarding — both bind
  `0.0.0.0:5432`. Node's `pg` client connects to the native one (wrong
  creds/db), while `docker exec` into the container works fine (which made it
  look like a docker config problem). Fix: mapped `docker-compose.yml` to
  `5433:5432` and updated `DATABASE_URL` in `.env` to port 5433, instead of
  touching the native service. If Postgres auth fails locally on this
  machine again, check `netstat -ano | grep 5432` for a second listener
  before assuming the container/creds are wrong.

## Testing with Postman
`Festival_Management_API.postman_collection.json` (repo root) covers every
route in `routes/`, organized into folders matching each resource, and is a
valid Postman v2.1 collection — import it directly (Postman: Import > File).

**Getting a token before testing protected routes:**
1. Import the collection and set the `baseUrl` collection variable (defaults
   to `http://localhost:3000`; point it at a deployed URL when needed).
2. Run `Auth > Register` once with any email/password to create a user (or
   skip this if you already registered one).
3. Run `Auth > Login` with the same email/password. The response body is
   `{ "token": "..." }`.
4. Copy that token into the collection's `token` variable (Collection >
   Variables tab, or edit it inline in the collection settings). Every
   protected request in the collection already sends
   `Authorization: Bearer {{token}}`, so this one paste unlocks all of them.
5. Tokens expire after 7 days (see `authService.js`) — re-run Login and
   re-paste when requests start failing with 401.

All GET endpoints are public and need no token. Only POST/PATCH/DELETE
requests need step 4 done first.
