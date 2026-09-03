# Replace bootstrap with self-service registration

Supersedes `plans/bootstrap-first-user.md`. Bootstrap was a one-time,
self-limiting first-account workaround; this replaces it with a normal,
always-available registration endpoint, closing the same gap in a way that
doesn't need a "first run" concept at all.

## Remove
- `POST /auth/bootstrap` route (`routes/auth.js`)
- `authService.bootstrapFirstUser` (the `LOCK TABLE users`-guarded
  empty-check + 403 "setup already completed" path)
- No more "first account" concept anywhere in the API.

## Add
`POST /auth/register` — public, no auth, mounted on the `/auth` router
(same place `/login` and the old `/bootstrap` were, ahead of the app-wide
write gate).

Body: `{ name, phone, password }`, all required — 400 `"name, phone, and
password are required"` if any missing (same message bootstrap used).
Hashes with `bcrypt.hash(password, SALT_ROUNDS)` — the exact call already
used in this same file (`changePassword`) and in
`colonyMembershipService.upsertMembership`'s create branch; no separate
helper exists to import, so this isn't a new hashing implementation.
`phone` uniqueness is the existing DB constraint — a violation is caught
and translated to 409 `{ "error": "phone already registered" }` (unlike
login, disclosing that a phone is taken on a *registration* form is normal).
201 on success: `{ token }`, same shape/payload (`{ user_id, phone }`) as
`/auth/login` and the old bootstrap response.
Created account is a plain `users` row — no role flag, zero colonies,
identical to one created via `POST /colonies/:id/members`. Works on every
call, repeatedly — that's the entire difference from bootstrap.

**Abuse mitigation: none**, per explicit decision — matches every other
endpoint in this API today (no rate limiting anywhere), revisit if abuse
is observed.

## Unchanged (verified, not touched)
- `POST /colonies` (create-for-self flow)
- `POST /colonies/:id/members` (admin create-or-link flow) — once register
  exists, admins will mostly hit the link branch; existing tests already
  cover linking a self-registered-style user (phone resolves to an existing
  account)
- `GET /users?search=`
- No join-request/pending-membership table — joining stays an offline,
  admin-mediated arrangement by design.

## Tests
- Delete the bootstrap-only-once test and the now-stale "POST /auth/register
  no longer exists" test in `test/colonyMembership.test.js`.
- Add: 400 missing field, 409 duplicate phone, 201 with `{ token }` shape.

## Docs
`docs/BACKEND_ANALYSIS.md`: replace every bootstrap-era mention (§3, §4,
§5, §6, §7, §11/§12 resolved-question section) and the "Mobile auth flow"
diagram with Register → (create colony) or (wait for an admin to find you
via `GET /users?search=` and link you) → Login on later sessions.
`PROGRESS.md`: new dated entry replacing the bootstrap gap-closure entry's
relevance.
