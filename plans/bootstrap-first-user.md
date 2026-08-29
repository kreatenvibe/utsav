# Bootstrap the first user account

Closes the gap flagged since migration 016 (dropping `email`/self-registration):
there was no API path to create the very first `users` row in a fresh
deployment — `POST /colonies/:id/members` needs an existing colony admin,
`POST /colonies` needs an existing authenticated user.

## Endpoint
`POST /auth/bootstrap` — no auth required (mounted on the `/auth` router,
same as `/login`, before the app-wide write gate).

Body: `{ name, phone, password }` (same shape `POST /colonies/:id/members`
uses to create a brand-new account). 400 `"name, phone, and password are
required"` if any is missing.

Only succeeds while the `users` table is empty. Runs inside one transaction:
`LOCK TABLE users IN EXCLUSIVE MODE` (serializes concurrent calls against
each other, since with zero rows there's nothing for a row-level lock to
contend on) → `SELECT COUNT(*)` → if non-zero, roll back and 403 `"setup
already completed"` → else insert the row and commit. Two near-simultaneous
calls can't both pass the check: the second one blocks on the table lock
until the first commits, then sees a non-empty table.

Response 201: `{ token }`, same shape and JWT payload (`{ user_id, phone }`)
as `POST /auth/login` — logs the new account straight in so a mobile
first-run screen can go directly from setup into the app.

## Not a platform role
The bootstrapped account is a plain `users` row — no special flag, no
platform-admin concept (this app doesn't have one). It just happens to be
first, so it's the one that calls `POST /colonies` and becomes admin of
whatever colony it creates. Every account after it is onboarded normally via
that colony's admin (`POST /colonies/:id/members`); bootstrap never runs
again once one user exists.

## Tests
`test/colonyMembership.test.js`: 400 on missing fields, 403 once a user
exists (the shared test DB always has users by the time this test runs, so
the empty-table success path isn't exercised in the suite — verified
manually instead, see below, since truncating the shared `users` table would
be destructive to other tests/developers).

Manually verified against a throwaway database in the same local docker
Postgres container (`utsav_bootstrap_check`, migrated fresh, dropped after):
missing-fields 400, first call 201 with a working token (logged in via
`/auth/login` and used to `POST /colonies` successfully), second call 403
"setup already completed".

## Docs
`docs/BACKEND_ANALYSIS.md` §4 (new Auth row), §5 (bootstrapping-gap notes
updated — no longer an open gap), §7 (new error rows) updated to match.
