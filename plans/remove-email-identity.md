# Remove email from the identity model

Confirmed with user: database wipe is safe (test/seed data only), so this is
a destructive, non-backfilled schema change — no migration needs to preserve
existing `email` values.

## Schema
`migrations/016_drop_email.sql`: drop `users_email_or_phone_check`, drop
`users.email` (drops its implicit unique constraint/index along with it),
drop the partial `users_phone_unique` index, set `users.phone NOT NULL`, add
a plain `UNIQUE (phone)` constraint. Final `users` shape: `user_id`, `name`,
`phone` (required, unique), `password_hash`, `created_at`.

## Auth
- `POST /auth/register` deleted from `routes/auth.js`. `authService.registerUser`
  deleted too (no remaining caller — avoid leaving dead exports, same
  convention as retiring `assertColonyMember` in the members→users migration).
- `authService.loginUser` simplified to `{ phone, password }` only — no more
  exactly-one-of branching. JWT payload becomes `{ user_id, phone }`.
- `app.js` needs no change: it already just mounts `/auth` before the global
  write-gate; removing one route from that router doesn't leave a dead
  reference. Confirmed by reading it.

## Colony membership
- `colonyMembershipService.upsertMembership` body becomes
  `{ name, phone, password, role }` — phone always required (no more
  exactly-one-of). Response drops `email`.
- `bulkAddMembers`/roster CSV rows: drop the `email` column entirely (file
  columns become `name`, `phone`, `password`, `role`). `rosterParser.js`
  itself needs no change (it's column-agnostic — just stops being asked for
  `email`).
- `listColonyMembers` query drops `u.email`.

## Users directory
`userService.searchUsers` drops `email` from both the match (`name` OR
`phone` only) and the response shape.

## Consequential — not explicitly listed by the user, but required for the
column drop to not break existing queries
`donationService`, `expensePaymentService`, `taskAssignmentService`,
`availabilityService` all currently `SELECT u.email ...` to inline
`collector`/`payer`/`user` objects. These lose their `email` field too (same
`{ user_id, name, phone }` / `{ name, phone }` shape, minus `email`).

## Bootstrapping gap (flag, not fixed here)
With self-registration gone, there is no API path to create the very first
user account (every path — `POST /colonies/:id/members`, its bulk variant —
requires being a colony admin already, and `POST /colonies` requires being
an authenticated user already). This mirrors a real deployment concern: the
first admin account has to be provisioned directly against the database
(e.g. a one-off `INSERT INTO users ...` with a bcrypt hash), not through the
API. Flagging this rather than silently working around it. Tests bootstrap
their first admin the same way — a direct SQL insert — since that's now the
only way to get a first user.

## Tests
Both `test/colonyMembership.test.js` and `test/bulkImport.test.js` currently
bootstrap every user via `POST /auth/register`, which no longer exists.
Rewriting their shared helper to insert a user directly via SQL (bcrypt-hash
a known password, `INSERT INTO users`) then `POST /auth/login` with
`{ phone, password }`. `test/usersPhoneLogin.test.js` is subsumed — it was
entirely about the email/phone dual-login and email-column bulk-import
behavior, none of which exists anymore; deleting it and folding its one
still-relevant case (bulk-import phone row logs in successfully) into
`colonyMembership.test.js`.

## Docs
`docs/BACKEND_ANALYSIS.md` §3 (users entity), §4 (Auth/Users/Colonies
tables+bodies), §5 (auth flow description, JWT payload), §7 (error table
rows) updated to match. `PROGRESS.md` gets a new dated entry.
