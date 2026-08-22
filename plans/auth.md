# JWT auth for write endpoints

## Context
All routes are currently unauthenticated. The app needs a minimal login system:
any authenticated caller can perform writes (POST/PUT/PATCH/DELETE), no
roles/permissions yet. This is intentionally basic — will be refined later.

## Decisions
- **Separate `users` table**, not auth fields on `members`. `members` models
  organizers/volunteers as festival data (name, phone); login identity is a
  different concern and keeping it separate avoids mixing credentials into a
  table that's referenced by donations/expenses/tasks.
- **Password hashing: `bcryptjs`** (pure JS), not native `bcrypt` — avoids a
  node-gyp native build on this Windows machine.
- **JWT: `jsonwebtoken`**, secret from a new `JWT_SECRET` env var in `.env`
  (already gitignored).
- **Registration: open `POST /auth/register`** (confirmed with user) — no
  auth required, so the first account doesn't need manual DB access. Can be
  locked down once roles exist.
- **Protected verbs: POST, PUT, PATCH, DELETE** — the app uses PATCH (not PUT)
  for updates, so PATCH is included even though the user said POST/PUT/DELETE;
  PUT is included too in case it's added later. GET stays open.
- Enforced as **one global middleware**, not per-route checks — keeps route
  handlers thin (per CLAUDE.md) and only two lines in `index.js`.

## Changes

**`package.json`** — add deps `bcryptjs`, `jsonwebtoken`.

**`.env`** — add `JWT_SECRET=<generated random value>`.

**`migrations/008_users.sql`** (new)
```sql
CREATE TABLE users (
  user_id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**`services/authService.js`** (new) — mirrors existing service style
(`services/memberService.js`): plain functions, throws `Error` with
`.status` for 400/401/409, uses `pool` directly.
- `registerUser({ email, password })`: validates both present (400), hashes
  with `bcryptjs.hash`, inserts, catches unique-violation (Postgres code
  `23505`) → 409 "email already registered", returns `{ user_id, email }`
  (never the hash).
- `loginUser({ email, password })`: looks up by email (401 "invalid
  credentials" if not found — same message as a bad password, so login
  doesn't leak which emails exist), `bcryptjs.compare`, on success signs a
  JWT with `jsonwebtoken.sign({ user_id, email }, process.env.JWT_SECRET,
  { expiresIn: '7d' })`, returns `{ token }`.

**`middleware/auth.js`** (new folder+file)
- `requireAuth(req, res, next)`: reads `Authorization: Bearer <token>`,
  401 if missing/malformed, `jsonwebtoken.verify` (401 on failure), attaches
  `req.user = { user_id, email }`, calls `next()`.

**`routes/auth.js`** (new) — same thin-handler pattern as `routes/members.js`:
`POST /auth/register`, `POST /auth/login`, both call into `authService.js`.

**`index.js`** — mount `/auth` router before the global check (so
register/login stay public), then apply the write-guard globally, then mount
the existing routers (unchanged otherwise):
```js
app.use('/auth', authRouter);

app.use((req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    return requireAuth(req, res, next);
  }
  next();
});

app.use('/colonies', coloniesRouter);
// ...rest unchanged
```
`/health` stays mounted before the guard (GET-only, but keep it explicit/first
for clarity) — no functional change there.

## Verification
- Run `npm run migrate` to apply `008_users.sql` against the docker Postgres.
- `npm run dev`, then manually:
  - `POST /auth/register` with email/password → 201 with `{user_id, email}`
    (no hash leaked); repeat with same email → 409.
  - `POST /auth/login` with correct creds → 200 with `{token}`; wrong
    password → 401; unknown email → 401 (same message).
  - `POST /colonies` (or any write) with no `Authorization` header → 401.
  - Same request with `Authorization: Bearer <token>` from login → succeeds
    as before.
  - `GET /colonies` with no header → still works (unauthenticated reads
    unaffected).
  - Expired/garbage token on a write → 401.

## After implementation
Update `PROGRESS.md` (Done section + plan reference) per the project's
workflow rule, same as prior features.
