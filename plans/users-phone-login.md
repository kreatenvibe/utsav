# Phone-based login + bulk-import colony auto-link

## Goal
1. `users` gains an optional `phone` identifier; `email` becomes optional too (at least one required).
2. `POST /auth/login` accepts `{email,password}` OR `{phone,password}` (not both, not neither).
3. `POST /members/bulk` gets a new `grant_login` column: when truthy and `email` is empty, grants a phone-keyed login instead. Existing `email`-column behavior is unchanged.
4. Whichever path grants a login (email or phone) in the bulk import, the resulting user is auto-added to `colony_memberships` for the batch's `colony_id`, role `member` — fixes the existing gap where email-granted bulk logins never got colony access.
5. `GET /users?search=` matches `email` OR `phone`, response includes `phone`.

## Confirmed scope decision (point 4 in the request)
`bulkImportMembers` and `grantLogin` do NOT share login-granting code today — each has its own inline `INSERT INTO users` block. Not refactoring them together for this change. Only `bulkImportMembers` gets phone-login support; `POST /members/:id/grant-login` stays email+password only, unchanged.

## Migration `012_users_phone_login.sql`
```sql
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ADD COLUMN phone TEXT;
CREATE UNIQUE INDEX users_phone_unique ON users (phone) WHERE phone IS NOT NULL;
ALTER TABLE users ADD CONSTRAINT users_email_or_phone_check CHECK (email IS NOT NULL OR phone IS NOT NULL);
```
No-op backfill: all existing rows have email, none have phone, so the CHECK is trivially satisfied.

## `services/authService.js`
- `loginUser({ email, phone, password })`: 400 if `password` missing or neither identifier given; 400 if both given ("provide either email or phone, not both"). Query `WHERE email = $1` or `WHERE phone = $1` depending which was given. Same ambiguous "invalid credentials" 401 for both not-found and wrong-password. JWT payload becomes `{ user_id, email, phone }` (either may be null).
- `registerUser` unchanged (email+password only).

## `services/memberService.js` — `bulkImportMembers`
Per row, add `grant_login` column (truthy: `yes`/`true`/`1`, case-insensitive, via new local `parseTruthy`).
- `email` non-empty → existing path unchanged (grants via email).
- `email` empty AND `grant_login` truthy → new path: `INSERT INTO users (phone, password_hash)` using row's own `password` or batch `initial_password` (same fallback already used).
- `email` empty AND `grant_login` falsy → unchanged, plain roster row.
- Whichever path grants a login → `INSERT INTO colony_memberships (colony_id, user_id, role) VALUES ($1, $2, 'member') ON CONFLICT (colony_id, user_id) DO NOTHING`, same per-row transaction.
- New error case: unique violation on `users_phone_unique` → row-level `errors` entry, `"phone already registered for login"`.

## `services/userService.js`
`searchUsers`: `SELECT user_id, email, phone ... WHERE email ILIKE $1 OR phone ILIKE $1`. Non-search path also returns `phone`.

## Out of scope (unchanged)
`POST /colonies/:id/members/bulk`, `POST /donors/bulk`, `POST /auth/register`, `POST /members/:id/grant-login`.

## Tests to add (`test/`)
- login with phone only (success + wrong password)
- login with both email and phone → 400
- login with neither → 400
- bulk import: email path unchanged, new phone-only `grant_login` path, colony-membership auto-created for both paths, phone-already-registered → errors
- `GET /users?search=` matching by phone

## Verification
Swap `.env` to local docker Postgres, `npm run migrate`, `npm test` (full suite + new tests), then restore `.env`, same convention as prior sessions.
