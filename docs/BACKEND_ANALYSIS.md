# Backend Analysis — Festival Management API

*Written for a developer building a React Native mobile client on top of this backend. This document describes the system as it exists in the code today. Nothing here is a proposal or a recommendation to change anything.*

*Note: `UI_UX_FUNCTIONAL_SPEC.md` in the repo root is a related, very detailed document but it predates migration `009_colony_memberships.sql` — it still describes "one role, no per-colony scoping." That is now out of date. This document reflects the current code, including colony membership and per-colony write permissions.*

---

## 1. Understand the Product

**Problem it solves:** Coordinates the finances and logistics of a community festival (the codebase's own example is Ganesh Chaturthi) run by a housing colony/neighborhood association. It tracks who pledged money, who actually paid, what was planned to be spent, what was actually spent, what work needs doing, and who's available/signed up to do it.

**Expected users:** Festival organizers (the people who create colonies, festivals, log donations/expenses, assign tasks). There is currently no volunteer-facing or donor-facing login — volunteers and donors exist only as data records referenced by organizers.

**User roles that exist in the code today (as of migration 015 — `members` is retired, colony-admin is the only write role):**
- **Unauthenticated visitor** — can read (GET) everything, no login needed.
- **Registered user** — logging in alone grants no write access anywhere except creating a colony (which auto-admins the creator).
- **Colony admin of at least one colony** — the gate for donors, walk-in donations, and availability (none of which have a specific colony to check against — see §5).
- **Colony admin of a specific colony** (`colony_memberships.role = 'admin'`) — the gate for every colony-owned write: festivals, pledges, donations tied to a pledge, expenses, expense payments, tasks, task assignments, and colony membership add/remove/promote/reset-password. Also edits the colony's own `name`/`location`. The colony creator is auto-admined. A colony can never be left with zero admins (enforced in code).
- There is no plain "colony member" write role anymore — being `role = 'member'` grants no write access beyond what any authenticated user already has; it exists only to record who belongs to a colony (visible via `GET /colonies/mine`/`GET /colonies/:id/members`).

There is no "volunteer" or "donor" login role — `donors` are plain data rows, not user accounts. Volunteers **are** `users` rows now (see below) — the old separate `members` directory was retired in migration 015.

**Major business domains/modules** (11 route groups):
1. Auth (users/login)
2. Colonies (+ colony membership)
3. Festivals
4. Donors
5. Expected Donations (pledges)
6. Donations (actual payments)
7. Expenses (planned costs)
8. Expense Payments (actual payments)
9. Tasks
10. Task Assignments (volunteer signups)
11. Availability (volunteer yes/no calendar)

**How domains relate:** Everything nests under a **Colony → Festival**. Festivals own Expected Donations, Expenses, and Tasks. Each of those has a child "payment/actual" table (Donations, Expense Payments) or child junction (Task Assignments). Donors are a flat directory referenced by FK from the money tables, not scoped to a colony themselves. Volunteers/organizers are just `users` — task assignments and availability now point straight at `users`, the same table that backs login.

```
Colony
 └─ Festival  (current_balance is COMPUTED here)
     ├─ Expected Donations (pledge)
     │    └─ Donations (frozen payment log)
     ├─ Expenses (planned cost)
     │    └─ Expense Payments (frozen payment log)
     └─ Tasks
          └─ Task Assignments (volunteer signups)

Donors → Expected Donations, Donations
Users  → Task Assignments, Availability, (optional attribution on Donations/Expense Payments)
Users  → colony_memberships → Colony  (login identity IS the volunteer/organizer identity now)
```

---

## 2. Node.js Project Structure

- **Runtime/framework:** Node.js (ES modules, `"type": "module"` in `package.json`), Express 5.
- **Entry point:** [index.js](index.js) — imports the configured `app` from `app.js` and calls `.listen()`. Kept separate from `app.js` specifically so tests can drive the Express app in-process (via `supertest`) without binding a port.
- **App assembly:** [app.js](app.js) — creates the Express app, applies `express.json()`, defines `GET /health` (checks DB connectivity), mounts `/auth` (public), then a blanket auth-gate middleware for all `POST/PUT/PATCH/DELETE`, then mounts the remaining 10 routers, then a centralized error handler.
- **Routes** ([routes/](routes/)) — one file per resource. Thin: parse `req.params`/`req.query`/`req.body`, call the matching service function, set status code, `next(err)` on failure. No business logic lives here.
- **Services** ([services/](services/)) — one file per resource, all business logic and every SQL query. Functions throw plain `Error` objects with a `.status` property (e.g. `err.status = 404`) which the central error handler reads.
- **Models/Database layer:** No ORM. Raw SQL via the `pg` driver, called directly from services. [db/pool.js](db/pool.js) exports a single shared `pg.Pool`. Notably patches the `DATE` (oid 1082) type parser to return the raw `'YYYY-MM-DD'` string instead of a JS `Date`, to avoid a timezone-shift bug when serializing to JSON.
- **Migrations:** [db/migrate.js](db/migrate.js) is a small hand-rolled migration runner (no framework like Knex/Sequelize/Prisma) — reads `.sql` files from [migrations/](migrations/) in filename order, tracks applied ones in a `schema_migrations` table, wraps each file in `BEGIN/COMMIT/ROLLBACK`. Run via `npm run migrate`.
- **Middleware:** [middleware/auth.js](middleware/auth.js) — `requireAuth` verifies a `Bearer` JWT and attaches `req.user = { user_id, email, phone }` (migration 012 — `email`/`phone` may individually be `null` depending which identifier was used to log in). Applied globally to all mutating verbs in `app.js`, and additionally applied explicitly on GET routes that expose other users' data: two in `routes/colonies.js` (`/mine`, `/:id/members`) and `GET /users` in `routes/users.js`.
- **Authorization:** [services/colonyMembershipService.js](services/colonyMembershipService.js) — not a route-level middleware but a set of service-layer helper functions (`assertColonyAdmin`, `assertAdminOfAnyColony`, and per-resource `colonyIdFor*` resolvers) that every mutating service calls before writing.
- **Validation:** No schema library (no Joi/Zod/express-validator). Manual `if (!field) throw` checks at the top of each service function, plus reliance on Postgres constraints (`NOT NULL`, `CHECK`, FK) as a second line of defense, with Postgres error codes (`23503` FK violation, `23505` unique violation, `23514` check violation) caught and translated into friendly 400/409 messages.
- **Error handling:** One centralized Express error-handling middleware at the bottom of `app.js`: `res.status(err.status || 500).json({ error: err.message })`. All routes forward failures via `next(err)`.
- **Config/env vars:** Loaded via `dotenv`. Three vars used: `DATABASE_URL`, `PORT`, `JWT_SECRET`. `.env` is gitignored.
- **Background jobs / scheduled tasks:** None exist.
- **External services:** None — no email, SMS, push, file storage, or third-party API integration anywhere in the code.
- **File uploads:** Three endpoints — `POST /colonies/:id/members/bulk`, `POST /donors/bulk` — `multer` (memory storage, 5MB cap) handles the multipart request; the file is parsed in-memory (`csv-parse` for `.csv`, `exceljs` for `.xlsx`/`.xls`) and never persisted to disk or any storage layer. No other endpoint accepts file uploads. (`POST /members/bulk` was retired in migration 015 along with the rest of `members`.)
- **Logging:** None beyond `console.log`/`console.error` in the migration runner and server startup. No structured logging or request logging middleware.
- **Testing:** [test/colonyMembership.test.js](test/colonyMembership.test.js), [test/usersPhoneLogin.test.js](test/usersPhoneLogin.test.js), [test/bulkImport.test.js](test/bulkImport.test.js) — Node's built-in test runner (`node --test`) + `supertest`, run against a real Postgres database (no mocking). Covers auth, colony-membership/authorization, and bulk-import; no tests exist yet for the other modules' basic CRUD.

---

## 3. Database & Data Model

**Technology:** PostgreSQL, accessed via the `pg` driver with no ORM. Schema built up across 15 migration files. **Migration 015 dropped `members` entirely** — every table that used to reference it now references `users` directly. This section describes the schema as of migration 015.

### Entities

**users** (`migrations/008`, extended `migrations/012`, `013`)
- `user_id` (PK, serial), `name` (**required**, added migration 013 — backfilled on existing rows to `COALESCE(email, phone)`), `email` (**nullable** as of migration 012, unique when present), `phone` (**nullable**, added migration 012, unique when present via a partial index), `password_hash` (required, bcrypt), `created_at` (auto).
- **CHECK (email IS NOT NULL OR phone IS NOT NULL)** (migration 012) — a login identity needs at least one identifier. Both are optional individually; at least one is mandatory.
- Purpose: login identity **and** the volunteer/organizer identity — as of migration 015 there is no separate `members` table. Every colony member, task-assignment signup, and availability row now points straight at `users`.
- **Ways to get a `users` row**: `POST /auth/register` (email+password+name, self-registration only, never phone-based), `POST /colonies/:id/members` and `POST /colonies/:id/members/bulk` (create-or-link — creates a new row when the given email/phone doesn't already resolve to one, see §4/§6), and migration 014's one-time backfill (placeholder accounts for pre-migration `members` rows that had signups/availability but no login — see the migration file's own comments; these have an unusable random password until an admin resets it).
- No update/delete endpoints exist for `users` themselves beyond `PATCH /auth/change-password` (self-service) and the colony-admin-only `POST /colonies/:id/members/:userId/reset-password`. `GET /users?search=` is the only read/search endpoint.

**colony_memberships** (`migrations/009`)
- `colony_membership_id` (PK), `colony_id` (FK → colony), `user_id` (FK → users), `role` (`'admin'`|`'member'`, default `'member'`, CHECK-enforced), `created_at`.
- `UNIQUE (colony_id, user_id)` — one membership row per user per colony.
- Purpose: records who belongs to which colony. **As of this change, `role` no longer gates write access by itself** — `'member'` and `'admin'` both read everything; only `'admin'` can write anything colony-scoped (see §5). `role` still exists (not collapsed to a boolean) because it's still meaningful for who can manage membership/settings, and because demoting the sole admin is still specifically guarded.

**colony**
- `colony_id` (PK), `name` (required), `location` (optional, free text).
- Top of the hierarchy — a neighborhood/housing colony.

**festival**
- `festival_id` (PK), `colony_id` (FK, required), `name` (required), `year` (required).
- `current_balance` originally existed as a stored column (migration 001) but was **dropped** in migration 006 — it's now always computed at query time (see below). This is a deliberate, confirmed-with-user schema change; CLAUDE.md's "current_balance is always computed, never stored" rule reflects this.

**donors**
- `donor_id` (PK), `name` (required), `phone` (optional).
- People who give money. Unlike volunteers/organizers, donors were never merged into `users` — they have no login concept at all.

**expected_donations** (a pledge)
- `expected_id` (PK), `donor_id` (FK, required), `festival_id` (FK, required), `expected_amount` (required), `year` (required), `purpose` (free text, optional), `status` (`'open'`|`'closed'`, default `'open'`, CHECK-enforced, organizer-set).
- `total_donated` is **not a column** — computed on every read by summing linked, non-deleted `donations`.

**donations** (actual payment against a pledge, or a walk-in gift)
- `donation_id` (PK), `donor_id` (FK, required), `expected_id` (FK, **nullable** — null means a walk-in gift with no pledge), `amount` (required, frozen after insert), `date` (required, plain DATE), `collected_by` (FK → **users** as of migration 015, nullable, attribution only), `deleted_at` (soft-delete marker, migration 007).
- No PATCH endpoint exists at all — `amount` truly cannot be edited once created.
- GET responses inline the collector as `collector: { user_id, name, email, phone } | null` alongside the raw `collected_by` id (see §4).

**expenses** (planned cost)
- `expense_id` (PK), `festival_id` (FK, required), `purpose` (optional), `vendor_name` (optional, free text — not a linked entity), `amount_planned` (required, editable estimate), `status` (`'open'`|`'settled'`, default `'open'`), `deleted_at` (soft-delete).
- `total_paid` computed by summing linked, non-deleted `expense_payments`.

**expense_payments** (actual payment against an expense)
- `payment_id` (PK), `expense_id` (FK, required), `amount` (required, frozen), `date` (required), `paid_by` (FK → **users** as of migration 015, nullable, attribution only), `deleted_at` (soft-delete).
- No PATCH endpoint at all. GET responses inline the payer as `payer: { user_id, name, email, phone } | null` (see §4).

**tasks**
- `task_id` (PK), `festival_id` (FK, required), `title` (required), `planned_date` (optional DATE), `labor_required` (optional integer — a target headcount, purely informational, never enforced), `status` (`'planned'`|`'in_progress'`|`'done'`, DB CHECK-enforced, default `'planned'`).
- Hard-deleted (no `deleted_at`). Delete is blocked by a real FK violation (caught, returned as 400) if `task_assignments` still reference the task.

**task_assignments** (junction: a volunteer signed up for a task)
- `assignment_id` (PK), `task_id` (FK, required), `user_id` (FK → **users**, required, renamed from `member_id` in migration 015), `signed_up_at` (auto timestamp).
- No status/role/day fields — an informal signup, but as of this change **only a colony admin can create or cancel one** (not self-service — see §5). Hard-deleted. No PATCH. GET responses inline `user: { name, email, phone }`.

**availability**
- `availability_id` (PK), `user_id` (FK → **users**, required, renamed from `member_id` in migration 015), `date` (required, identity field — not editable), `is_available` (required boolean, the only PATCH-able field).
- Date-level only, no time-of-day granularity. Hard-deleted. GET responses inline `user: { name, email, phone }`.

### Relationship overview

```
users ──(colony_memberships, role)──▶ colony
colony ──1:N──▶ festival
festival ──1:N──▶ expected_donations, expenses, tasks
expected_donations ──1:N──▶ donations
expenses ──1:N──▶ expense_payments
tasks ──1:N──▶ task_assignments
donors ──1:N──▶ expected_donations, donations
users ──1:N──▶ task_assignments, availability
users ──optional FK──▶ donations.collected_by, expense_payments.paid_by
```

### Derived/calculated values (never stored)
- `expected_donations.total_donated` = SUM(`donations.amount`) where `expected_id` matches and `deleted_at IS NULL`.
- `expenses.total_paid` = SUM(`expense_payments.amount`) where `expense_id` matches, both expense and payment not soft-deleted.
- `festival.current_balance` = SUM(donations linked via expected_donations to this festival) − SUM(expense_payments linked via expenses to this festival), both excluding soft-deleted rows. **Walk-in donations (`expected_id IS NULL`) are excluded** — there's no schema path from a walk-in donation to a festival.

### Authorization scoping, resolved (previously "explicitly out of scope")
This used to be a flagged, deferred inconsistency (donors/walk-in-donations/availability were writable by any authenticated user, with no colony check at all). It's resolved now: **every write in the app requires colony-admin.** Donors, walk-in donations, and availability have no FK path to a specific colony, so their gate is "admin of *at least one* colony" (`assertAdminOfAnyColony`) rather than a specific colony's admin — see §5 for the full rule and reasoning. No self-service "leave a colony" still exists — only an admin can remove a member (including another admin, down to but not the last one).

---

## 4. API Inventory

Base URL has no global prefix (e.g. routes are mounted directly at `/colonies`, not `/api/colonies`). All list endpoints return plain JSON arrays (no pagination, no envelope, no total-count metadata) — the whole app has no pagination anywhere. 🔒 = requires `Authorization: Bearer <jwt>` (checked by the app-wide gate on POST/PUT/PATCH/DELETE); reads are public unless noted.

### Auth

| Method | Endpoint | Purpose | Auth |
|---|---|---|---|
| POST | `/auth/register` | Create a user account | — |
| POST | `/auth/login` | Log in, get a JWT | — |
| PATCH | `/auth/change-password` | Self-service password change | 🔒 |

- **Register** body: `{ name, email, password }` (`name` newly required by this change). Response `201`: `{ user_id, name, email }` (no password hash, no token). 400 if any field missing. 409 if email already registered. Self-registration is deliberately email+password only — no `POST /auth/register` path to a phone-only account. Phone-based logins are created via `POST /colonies/:id/members`/`/bulk` (see Colonies above) or the migration-014 backfill.
- **Login** body: `{ email, password }` **or** `{ phone, password }` (migration 012 — exactly one identifier, not both). Response `200`: `{ token }` (JWT, 7-day expiry). 400 if `password` is missing, or if neither `email` nor `phone` is given. 400 if **both** `email` and `phone` are given ("provide either email or phone, not both" — ambiguous on purpose, the API won't silently prefer one). 401 for wrong password or unknown identifier (email *or* phone) — identical `"invalid credentials"` message in every case, by design (doesn't leak which emails/phones are registered). JWT payload is now `{ user_id, email, phone }`; whichever field wasn't used to log in comes back `null`.
- **Change password** body: `{ current_password, new_password }`. Response `204`, no body. 400 if either field missing. 401 if `current_password` doesn't match. This is a **private** password change — independent of any shared/organizer-set password a member may have been given (see Members below); it doesn't require or reference a member's `user_id` link at all, just the caller's own JWT identity.

### Users (directory / search)

| Method | Endpoint | Purpose | Auth |
|---|---|---|---|
| GET | `/users?search=` | Search/browse registered users | 🔒 (always, even though it's a GET) |

- Added specifically so a colony admin can find a registered user's exact `email`/`phone` before calling `POST /colonies/:id/members` — though as of this change that endpoint no longer 404s on a miss (see Colonies below), this is still the picker for "link an existing account."
- `search` is optional. Omit it and the endpoint returns every registered user (same always-a-full-list convention as every other GET in this API — still no pagination). Given, it matches **partial, case-insensitive against `name` OR `email` OR `phone`** (name added in this change, alongside the existing email/phone match from migration 012).
- Response is `[{ user_id, name, email, phone }]` (`name` added in this change) — never `password_hash`, never any other column. Either `email` or `phone` may be `null` on a given row; `name` is never null.
- Requires auth on the GET, same reasoning as `/colonies/mine` and `/colonies/:id/members` below: an unauthenticated user-search endpoint would let anyone enumerate registered accounts.

### Colonies

| Method | Endpoint | Purpose | Auth |
|---|---|---|---|
| POST | `/colonies` | Create a colony (creator becomes admin) | 🔒 |
| GET | `/colonies?search=` | List all colonies, optional partial name/location search | — |
| GET | `/colonies/mine` | List colonies the caller belongs to, with their role | 🔒 (always, even though it's a GET) |
| GET | `/colonies/:id` | Colony detail | — |
| PATCH | `/colonies/:id` | Edit name/location | 🔒, colony-admin only |
| GET | `/colonies/:id/members` | List a colony's members (name + email/phone + role) | 🔒 (always) |
| POST | `/colonies/:id/members` | Create-or-link a user, add them to the colony | 🔒, colony-admin only |
| POST | `/colonies/:id/members/bulk` | Create-or-link many from a CSV/XLSX file | 🔒, colony-admin only |
| PATCH | `/colonies/:id/members/:userId` | Change a member's role | 🔒, colony-admin only |
| DELETE | `/colonies/:id/members/:userId` | Remove a member | 🔒, colony-admin only |
| POST | `/colonies/:id/members/:userId/reset-password` | Admin override: set a new password for a member's login | 🔒, colony-admin only |

- Create body: `{ name, location? }`. 400 if `name` missing.
- Role update body: `{ role }`. 400 if it would demote the last admin.
- Note: `/colonies/mine` must be registered before `/colonies/:id` in the router (it is) or Express would treat "mine" as an `:id` value.
- `?search=` (new) matches partial, case-insensitive against `name` OR `location`. Optional and additive — omit it and the response is the full list, unchanged.

**Add member — now create-or-link, not add-only** (`POST /colonies/:id/members`, body shape changed): `{ name, email?, phone?, password?, role? }`. Exactly one of `email`/`phone` is required (400 `"provide either email or phone, not both"` / `"email or phone is required"`, mirroring `POST /auth/login`'s own exactly-one-of validation). If the identifier already resolves to an existing `users` row, that account is **linked** as-is — `name`/`password` in the body are ignored entirely, never mutating an existing account as a side effect. If it doesn't resolve, a new account is **created** — `name` and `password` become required (400 if either is missing), then linked. **There is no more 404 "no registered user with that email"** — every call either links or creates. 409 unchanged if the resolved (or newly created) user is already a member of this colony. Response `201`:
```json
{
  "colony_membership_id": 9, "colony_id": 3, "user_id": 12, "role": "member",
  "created_at": "...", "name": "...", "email": "...", "phone": null, "account": "created"
}
```
`account` is `"created"` or `"linked"` — tells the caller (and a bulk-import review screen) which happened.

**Bulk add members** (`POST /colonies/:id/members/bulk`) — `multipart/form-data`: a `file` field (`.csv`/`.xlsx`/`.xls`, 5MB cap) plus an optional form field `initial_password`. Admin-of-`:id` is checked **once** up front for the whole request, not per row. File columns: `name` (**required per row**, even on a row that ends up linking — the value is simply ignored in that case), `email` (optional), `phone` (optional — exactly one of `email`/`phone` required per row), `password` (optional, falls back to the batch's `initial_password` field, which is itself only required if some row actually needs it to create a new account), `role` (optional, defaults `'member'`). Each row runs the exact same create-or-link logic as single-add. Response `201`:
```json
{
  "created": [{ "row": 1, "colony_membership_id": 9, "colony_id": 3, "user_id": 12, "role": "member", "created_at": "...", "name": "...", "email": "...", "phone": null, "account": "created" }],
  "skipped": [{ "row": 2, "email": "...", "phone": null, "reason": "that user is already a member of this colony" }],
  "errors":  [{ "row": 3, "email": null, "phone": "...", "reason": "password is required to create a new account" }]
}
```
`row` is 1-based, data rows only. `skipped` = already a member (unchanged concept). `errors` = missing `name`; missing/both identifiers; a new-account row missing `password` (and no `initial_password` fallback); bad `role`. Top-level 400 if no file; 404 if `:id` doesn't resolve to a colony; 403 if the caller isn't that colony's admin.

**Reset a member's password** (`POST /colonies/:id/members/:userId/reset-password`, new — replaces the retired `POST /members/:id/reset-password`) body: `{ password }`. 400 if `password` missing. 404 if `:userId` isn't a member of `:id`. Response `200`: `{ user_id }`. No current-password check — this is an admin override for a member who forgot their password, not self-service (`PATCH /auth/change-password` is the self-service path, unchanged).

### Festivals

| Method | Endpoint | Purpose | Auth |
|---|---|---|---|
| POST | `/festivals` | Create a festival | 🔒, must be an admin of the target colony |
| GET | `/festivals?colony_id=` | List, optional colony filter | — |
| GET | `/festivals/:id` | Detail, includes computed `current_balance` | — |
| PATCH | `/festivals/:id` | Edit name/year | 🔒, must be an admin of the festival's colony |

- Create body: `{ colony_id, name, year }`, all required. 400 on missing field or bad `colony_id` FK.

### Donors

| Method | Endpoint | Purpose | Auth |
|---|---|---|---|
| POST | `/donors` | Create | 🔒, must be an admin of at least one colony |
| POST | `/donors/bulk` | Create many from a CSV/XLSX file | 🔒, must be an admin of at least one colony |
| GET | `/donors?search=` | List, optional partial name/phone search | — |
| GET | `/donors/:id` | Detail | — |
| PATCH | `/donors/:id` | Edit name/phone | 🔒, must be an admin of at least one colony |

Donors have no `colony_id` and no FK path to any specific colony, so the gate here isn't "admin of *the* colony" — it's "admin of *any* colony" (see §5). `?search=` matches partial, case-insensitive against `name` OR `phone`.

**Bulk import** (`POST /donors/bulk`) — `multipart/form-data`, `file` field only. File columns: `name` (required per row), `phone` (optional). No uniqueness constraint on name or phone, so there is no dedup rule and no `skipped` case — every row with a name lands in `created`; only a missing name produces a row-level `errors` entry. Response `201`:
```json
{
  "created": [{ "row": 1, "donor_id": 7, "name": "...", "phone": "..." }],
  "skipped": [],
  "errors":  [{ "row": 2, "name": null, "reason": "name is required" }]
}
```
`skipped` is always `[]` — kept for response-shape consistency with the other bulk-import endpoints. Top-level 400 if no file.

### Expected Donations (pledges)

| Method | Endpoint | Purpose | Auth |
|---|---|---|---|
| POST | `/expected-donations` | Create a pledge | 🔒, must be an admin of the festival's colony |
| GET | `/expected-donations?festival_id=&donor_id=&status=` | List, filterable | — |
| GET | `/expected-donations/:id` | Detail, includes computed `total_donated` | — |
| PATCH | `/expected-donations/:id` | Edit amount/year/purpose/status | 🔒, colony admin |

Create body: `{ donor_id, festival_id, expected_amount, year, purpose? }`, first four required. `status` must be `'open'`/`'closed'` on PATCH (400 otherwise).

### Donations

| Method | Endpoint | Purpose | Auth |
|---|---|---|---|
| POST | `/donations` | Log a payment (or walk-in gift) | 🔒, colony admin if tied to a pledge; admin-of-any-colony if walk-in |
| GET | `/donations?donor_id=&expected_id=` | List, filterable | — |
| GET | `/donations/:id` | Detail | — |
| DELETE | `/donations/:id` | Soft delete | 🔒, same gate as create |

Create body: `{ donor_id, expected_id?, amount, date, collected_by? }`. No PATCH exists — `amount` is frozen. `collected_by` is now an optional `users.user_id` (was `members.member_id`). GET responses inline `collector: { user_id, name, email, phone } | null` alongside the raw `collected_by`.

### Expenses

| Method | Endpoint | Purpose | Auth |
|---|---|---|---|
| POST | `/expenses` | Create a planned cost | 🔒, colony admin |
| GET | `/expenses?festival_id=&status=` | List, filterable | — |
| GET | `/expenses/:id` | Detail, includes computed `total_paid` | — |
| PATCH | `/expenses/:id` | Edit purpose/vendor/amount_planned/status | 🔒, colony admin |
| DELETE | `/expenses/:id` | Soft delete | 🔒, colony admin |

Create body: `{ festival_id, purpose?, vendor_name?, amount_planned }`. `status` must be `'open'`/`'settled'`.

### Expense Payments

| Method | Endpoint | Purpose | Auth |
|---|---|---|---|
| POST | `/expense-payments` | Log a payment | 🔒, colony admin |
| GET | `/expense-payments?expense_id=` | List, filterable | — |
| GET | `/expense-payments/:id` | Detail | — |
| DELETE | `/expense-payments/:id` | Soft delete | 🔒, colony admin |

Create body: `{ expense_id, amount, date, paid_by? }`. No PATCH. `paid_by` is now an optional `users.user_id` (was `members.member_id`). GET responses inline `payer: { user_id, name, email, phone } | null` alongside the raw `paid_by`.

### Tasks

| Method | Endpoint | Purpose | Auth |
|---|---|---|---|
| POST | `/tasks` | Create | 🔒, colony admin |
| GET | `/tasks?festival_id=&status=` | List, filterable | — |
| GET | `/tasks/:id` | Detail | — |
| PATCH | `/tasks/:id` | Edit title/date/headcount/status | 🔒, colony admin |
| DELETE | `/tasks/:id` | Hard delete, blocked if signups exist | 🔒, colony admin |

Create body: `{ festival_id, title, planned_date?, labor_required? }`. `status` restricted to `'planned'`/`'in_progress'`/`'done'` by a DB CHECK (400 on violation).

### Task Assignments

| Method | Endpoint | Purpose | Auth |
|---|---|---|---|
| POST | `/task-assignments` | Sign a user up for a task | 🔒, colony admin of the task's colony |
| GET | `/task-assignments?task_id=&user_id=` | List, filterable either direction | — |
| GET | `/task-assignments/:id` | Detail | — |
| DELETE | `/task-assignments/:id` | Cancel a signup | 🔒, colony admin |

Create body: `{ task_id, user_id }` (renamed from `member_id`). No PATCH — nothing on a signup is editable. **This is no longer self-service** — signing up (or cancelling) now requires the *caller* to be a colony admin, not the person being signed up; an ordinary colony member can no longer sign themselves up (see §5). GET responses inline `user: { name, email, phone }` alongside the raw `user_id`.

### Availability

| Method | Endpoint | Purpose | Auth |
|---|---|---|---|
| POST | `/availability` | Create a day's yes/no | 🔒, must be an admin of at least one colony |
| GET | `/availability?user_id=&date=` | List, filterable | — |
| GET | `/availability/:id` | Detail | — |
| PATCH | `/availability/:id` | Flip `is_available` only | 🔒, must be an admin of at least one colony |
| DELETE | `/availability/:id` | Hard delete | 🔒, must be an admin of at least one colony |

Create body: `{ user_id, date, is_available }` (renamed from `member_id`), all required; `is_available` must be a JS boolean (400 otherwise). `availability` has no FK path to a specific colony, so — like donors — the gate is admin-of-*any*-colony, not a specific colony's admin (see §5). This is a real behavior change from before: previously any authenticated user could write their own availability; now only a colony admin can write anyone's. GET responses inline `user: { name, email, phone }` alongside the raw `user_id`.

**No pagination and no sort-order control anywhere in the API** — every list is `ORDER BY <primary key> ASC` with no override. Filtering is exact-match everywhere **except** four endpoints with a partial, case-insensitive `?search=`: `GET /users?search=` (name/email/phone), `GET /donors?search=` (name/phone), `GET /colonies?search=` (name/location). No other endpoint has free-text search. (`GET /members?search=` no longer exists — `members` was retired.)

---

## 5. Authentication & Authorization

**Mechanism:** Stateless JWT, signed with `JWT_SECRET`, 7-day expiry, no refresh token.

- **Registration** (`POST /auth/register`): name + email + password (`name` added in this change — previously email+password only), bcrypt-hashed (`bcryptjs`, 10 salt rounds) via `authService.registerUser`. No email verification, no roles selection.
- **Login** (`POST /auth/login`): returns `{ token }` only — no user profile info in the response body.
- **Logout:** Not implemented server-side (stateless JWT — client just discards the token). No token blacklist/revocation.
- **Token contents:** `{ user_id, email, phone }` (migration 012 — `email`/`phone` may individually be `null`, depending which identifier the account has and which one was used to log in) plus standard JWT claims (`iat`, `exp`). `name` is not in the token — fetch it via `GET /users?search=` or `GET /colonies/:id/members` if needed client-side.
- **Token verification:** `middleware/auth.js`'s `requireAuth` — reads `Authorization: Bearer <token>`, verifies with `jsonwebtoken`, 401 on missing header, malformed header, invalid signature, or expired token. Sets `req.user`.
- **Password reset:** No "forgot password" self-service flow — no email/SMS, no token, no unauthenticated reset path. Two authenticated alternatives exist: a logged-in user can change their own password (`PATCH /auth/change-password`, requires the current password), and a colony admin can reset a member's password directly (`POST /colonies/:id/members/:userId/reset-password`, no current-password check — this is an admin override, not self-service; replaces the retired `POST /members/:id/reset-password`).
- **User profile:** No `GET /me` or profile endpoint exists at all. The only way to learn the current user's `user_id`/`email`/`phone` is what was embedded in the JWT at login (decode client-side) or infer via `/colonies/mine`.
- **Login identifiers (migration 012):** `users.email` and `users.phone` are each individually optional (a `CHECK` requires at least one), so `POST /auth/login` takes exactly one of `email`/`phone` plus `password` — see §4. `POST /auth/register` remains email+password (+name) only; a `users` row only ever gets a `phone` via the colony-member create-or-link path (§4) or the migration-014 backfill.
- **Global gate:** In `app.js`, every `POST`/`PUT`/`PATCH`/`DELETE` request across the whole app requires a valid JWT (applied *after* `/auth` is mounted, so register/login stay open). All `GET` requests are public with no exceptions **except** `/colonies/mine`, `/colonies/:id/members`, and `/users`, which explicitly require auth even though they're GETs (because they expose other users' emails).
- **Roles/permissions beyond colony membership:** None system-wide — every registered user can create a colony and become its admin. Within a colony, `role = 'member'` no longer carries any write privilege of its own (see below) — the only roles that matter for authorization purposes are "colony admin of a specific colony" and "colony admin of at least one colony."
- **Authorization — colony-admin is the only write role, app-wide (this change).** Previously, most colony-descended writes only required `assertColonyMember` (any member could write); this is now `assertColonyAdmin` everywhere: `festivals`, `expected_donations`, `donations` (when tied to a pledge via `expected_id`), `expenses`, `expense_payments`, `tasks`, `task_assignments`, and colony membership add/remove/promote/reset-password. `donors`, walk-in `donations` (no `expected_id`), and `availability` have no FK path to a specific colony at all, so they use a new, looser gate — `assertAdminOfAnyColony(userId)` (`colonyMembershipService.js`) — true if the user is `role = 'admin'` on *any* `colony_memberships` row, regardless of which colony. This closes a gap flagged across three prior sessions (PROGRESS.md) where those three resources were writable by any authenticated user with no colony check at all. **Reasoning for extending rather than leaving them unscoped**: the task driving this change was explicitly "colony-admin the only write role app-wide" — leaving three resources as the sole exceptions would have reproduced the exact inconsistency being fixed. **Mobile consequence**: the Donors screens and the Walk-in Donation screen need a "current user is admin of ≥1 colony" gate before showing their write actions — derivable client-side from `GET /colonies/mine` (any row with `role: "admin"`), no new endpoint needed.
- **Task assignments are no longer self-service.** Signing up for a task (`POST /task-assignments`) and cancelling a signup (`DELETE /task-assignments/:id`) now require the *caller* to be a colony admin of the task's colony — not the person being signed up. An ordinary colony member can no longer add themselves to a task; only an admin enrolls volunteers. This is a deliberate product change made as part of the app-wide admin-only rule above, called out explicitly here because it's easy to miss (the resource name suggests self-service).
- **Colony membership (this change, replacing migration 011's member-linking model):** `POST /colonies/:id/members` and its bulk counterpart are now **create-or-link** (upsert) instead of add-only — see §4 for the exact rule. Both remain colony-admin-of-`:id`-only, checked once per request (not per row for bulk). `POST /colonies/:id/members/:userId/reset-password` is new, colony-admin-of-`:id`-only, and replaces the retired `POST /members/:id/reset-password`. There is still no self-service "leave a colony" and still no way to demote/remove the last admin.

**Mobile auth flow the backend actually supports:**
```
Register (POST /auth/register)
  ↓
Login (POST /auth/login) → { token }
  ↓
Store token securely on-device (e.g. secure storage / keychain)
  ↓
Attach "Authorization: Bearer <token>" to every write request
  ↓
Token expires after 7 days, no refresh endpoint exists
  ↓
On any 401 from a write call, discard token and re-prompt login
  (there is no way to detect expiry in advance — no /me endpoint, no expiry check other than the JWT's own exp claim if decoded client-side)
```

---

## 6. Business Workflows

### Colony + membership bootstrap
1. User registers, logs in.
2. `POST /colonies` — creates the colony **and**, in the same DB transaction, an admin `colony_memberships` row for the creator (`colonyService.createColony`). This is the one place in the codebase with an explicit multi-table transaction.
3. Admin calls `POST /colonies/:id/members` with `{ name, email?, phone?, password?, role? }` — this either links an already-registered person by their email/phone, or creates a brand-new account for them on the spot (no more 404 "not registered yet"; see §4/§5).
4. From here on, every write under that colony's festivals/expenses/tasks/etc. requires the acting user to be an **admin** of that colony, not just any member (see §5).

### Donation (pledge → payment) workflow
1. Organizer creates a **Donor** (`POST /donors`) if new.
2. Organizer creates an **Expected Donation** (`POST /expected-donations`) — a pledge tied to a donor + festival, with an amount and year.
3. As money comes in, organizer logs one or more **Donations** (`POST /donations`) against that `expected_id` — each is a frozen row, `amount` never edited again.
4. `GET /expected-donations/:id` recomputes `total_donated` live by summing those donations.
5. Organizer explicitly `PATCH`es the pledge's `status` to `'closed'` when done — this never happens automatically, even if `total_donated >= expected_amount`.
6. A donation can alternatively skip step 2 entirely — a "walk-in" donation with `expected_id: null` — which is excluded from any festival's `current_balance` and from colony authorization scoping.
7. To correct a mistaken amount, the only path is `DELETE /donations/:id` (soft-delete) and re-`POST` a corrected one — there is no edit.

### Expense (planned → paid) workflow
Mirrors donations exactly: `POST /expenses` (planned cost against a festival) → one or more `POST /expense-payments` against it → `expenses.total_paid` computed live → organizer `PATCH`es `status` to `'settled'` manually. Expense itself (unlike a pledge) *can* be edited via PATCH (`purpose`, `vendor_name`, `amount_planned`, `status`); only the payment rows are frozen.

### Festival balance
`festival.current_balance` is computed on every `GET /festivals` or `GET /festivals/:id` — never stored, never updated by a write. It's `Σ(donations via expected_donations for this festival) − Σ(expense_payments via expenses for this festival)`, both sums excluding soft-deleted rows.

### Task/volunteer workflow
1. Organizer creates a **Task** (`POST /tasks`) under a festival, optionally with a target `labor_required` headcount and a `planned_date`.
2. A colony admin signs a volunteer (a `users` row) up via `POST /task-assignments` — a simple join, no capacity check against `labor_required` (informational only, never enforced). This is no longer self-service (see §5) — an ordinary colony member can't add themselves.
3. Organizer moves the task through `status`: `planned` → `in_progress` → `done` via `PATCH /tasks/:id` (DB CHECK enforces only those three values).
4. A member can separately record day-level `Availability` (`POST /availability`, `PATCH` to flip `is_available`) — unrelated to task assignments; the API does not cross-reference the two.
5. Deleting a task is blocked (400) if any `task_assignments` still reference it — assignments must be cancelled first (`DELETE /task-assignments/:id`).

---

## 7. Validation & Error Behavior

Error response format is uniform across the whole API: `{ "error": "<message>" }`, with an HTTP status set from each thrown error's `.status` (defaulting to `500` if unset).

| Situation | Status | Example message | Where enforced |
|---|---|---|---|
| Missing required field | 400 | `"name is required"` / `"donor_id, amount, and date are required"` | Manual check at top of each service function |
| Invalid enum value (status fields, `is_available` type) | 400 | `"status must be 'open' or 'closed'"` | Manual check, or a caught DB CHECK violation (tasks.status) |
| FK references a nonexistent row | 400 | `"colony_id does not reference an existing colony"` | Caught Postgres `23503`, translated |
| Delete blocked by dependent rows | 400 | `"cannot delete task with existing task_assignments; remove those first"` | Caught Postgres `23503` on the DELETE itself |
| Insufficient colony privilege | 403 | `"you must be an admin of this colony to do that"` / `"you must be an admin of at least one colony to do that"` | `colonyMembershipService.assertColonyAdmin`/`assertAdminOfAnyColony` (this change — `assertColonyMember` was removed, colony-admin is now the only write role) |
| Missing/invalid/expired JWT on a write | 401 | `"missing or malformed Authorization header"` / `"invalid or expired token"` | `middleware/auth.js` |
| Wrong password or unknown email/phone at login | 401 | `"invalid credentials"` (identical message, intentionally) | `authService.loginUser` |
| Login with both `email` and `phone`, or with neither | 400 | `"provide either email or phone, not both"` / `"password and either email or phone are required"` | Manual check in `authService.loginUser` (migration 012) |
| Row not found (or soft-deleted) | 404 | `"donation not found"` etc. | Manual `if (!rows[0]) throw` in every `get*` |
| Duplicate email at registration | 409 | `"email already registered"` | Caught Postgres `23505` |
| Duplicate colony membership | 409 | `"that user is already a member of this colony"` | Caught Postgres `23505` |
| Removing/demoting the last colony admin | 400 | `"cannot remove the last admin of a colony"` | Manual check (`isSoleAdmin`) |
| Wrong current password on change-password | 401 | `"current password is incorrect"` | `authService.changePassword` |
| Colony-member add/bulk-add: neither or both of email/phone given | 400 | `"email or phone is required"` / `"provide either email or phone, not both"` | `colonyMembershipService.upsertMembership` (this change, mirrors `authService.loginUser`'s wording) |
| Colony-member add/bulk-add: creating a new account without name/password | 400 | `"name is required to create a new account"` / `"password is required to create a new account"` | `colonyMembershipService.upsertMembership` (this change) — not an error at all if the identifier resolves to an existing account (name/password are simply ignored) |
| Colony-member reset-password: target isn't a member of this colony | 404 | `"membership not found"` | `colonyMembershipService.resetMemberPassword` (this change) |
| Unexpected/uncaught error | 500 | raw `err.message` (whatever Postgres or Node produced) | Fallback in the central error handler |

Notes for a mobile client:
- A soft-deleted row (donations/expenses/expense_payments) reads back identically to a row that never existed (404) — the client can't distinguish "never existed" from "deleted" from the API alone.
- There's no field-level validation error array — only ever a single top-level `error` string, so a form can't highlight multiple invalid fields from one response.
- No rate limiting, no CORS configuration, no request-size limits beyond Express defaults were found in the code.

---

## 8. Mobile Application Requirements

### Screen: Login / Register
**Purpose:** Authenticate, or create an account.
**Who can access it:** Anyone (unauthenticated).
**Data required:** Register: name, email, password. Login: password plus exactly one of email/phone (most self-registered users only have email, but a colony-added volunteer may only have a phone login, so a login form should offer both, not just email).
**APIs required:** `POST /auth/register`, `POST /auth/login`.
**Actions:** Submit registration (name+email+password only — there is no phone-based self-registration); submit login (email or phone); switch between the two forms.
**States:** Loading (submitting); Error (400 missing field or both-identifiers-given on login, 409 duplicate email on register, 401 bad credentials); Success (registered → prompt login; logged in → store token, navigate to Colony picker).

### Screen: Colony Picker / List
**Purpose:** Choose or create the colony to work in.
**Who can access it:** Any logged-in user (list is public even signed out, but creating requires auth).
**Data required:** `GET /colonies` (all) or `GET /colonies/mine` (only colonies the user belongs to, with role).
**APIs required:** `GET /colonies`, `GET /colonies/mine`, `POST /colonies`.
**Actions:** View all colonies; view "my colonies"; create a new colony (becomes its admin).
**States:** Loading; Empty (no colonies yet); Error; Success.

### Screen: Colony Detail / Members
**Purpose:** View a colony, and (if admin) manage its membership.
**Who can access it:** Anyone for the base detail (public read); membership list/management requires being logged in, admin-only for mutation.
**Data required:** `GET /colonies/:id`; `GET /colonies/:id/members` (auth required); `GET /users?search=` (auth required) to look up the user to add.
**APIs required:** `GET /colonies/:id`, `PATCH /colonies/:id` (admin), `GET /colonies/:id/members`, `GET /users?search=`, `POST /colonies/:id/members`, `POST /colonies/:id/members/bulk`, `PATCH /colonies/:id/members/:userId`, `DELETE /colonies/:id/members/:userId`.
**Actions:** Edit name/location (admin only); search registered users by partial name/email/phone via `GET /users?search=` and pick one to link, or type a brand-new person's `{ name, email/phone, password, role? }` to create-and-add them in one call (admin only — `POST /colonies/:id/members` no longer 404s on an unregistered identifier; it creates the account); bulk-add many people at once via a CSV/XLSX file (admin only — `POST /colonies/:id/members/bulk`), showing the created/skipped/error breakdown per row (skipped = already a member, created rows show whether each was `linked` or a brand-new `created` account); reset a member's password (`POST /colonies/:id/members/:userId/reset-password`, admin only, no current-password check); promote/demote a member; remove a member (blocked if it's the last admin).
**States:** Loading; Error (403 if not admin attempting a mutation, 400 on a new-account row missing name/password or on last-admin removal); Success. `GET /users` and `GET /colonies/:id/members` both include `name` now — use it in the picker instead of email/phone alone.

### Screen: Festival Dashboard
**Purpose:** The main "home" screen for a specific festival — shows the live balance and links into every other module.
**Who can access it:** Anyone to view; write requires colony **admin** (not just any colony member, as of this change).
**Data required:** `GET /festivals/:id` (includes computed `current_balance`).
**APIs required:** `GET /festivals`, `GET /festivals/:id`, `POST /festivals`, `PATCH /festivals/:id`.
**Actions:** Switch festival/year; edit name/year (colony admin); create a new festival under a colony (colony admin).
**States:** Loading; Empty (no festivals yet in this colony); Error; Success — highlight `current_balance` as the headline stat.

### Screen: Donors Directory + Donor Detail
**Purpose:** Manage the list of people who give money; drill into one donor's pledges/gifts.
**Data required:** `GET /donors`, `GET /donors/:id`, and filtered `GET /expected-donations?donor_id=`, `GET /donations?donor_id=`.
**APIs required:** `POST /donors`, `POST /donors/bulk`, `GET /donors`, `GET /donors/:id`, `PATCH /donors/:id`.
**Actions:** Add/edit a donor; bulk-import many donors at once via a CSV/XLSX file (name required, phone optional — no dedup, so re-uploading the same file creates duplicates); view their pledge and payment history (multiple calls, not bundled by the API). All three writes now require the caller to be an admin of at least one colony (see §5) — gate these actions behind that check client-side.
**States:** Loading; Empty; Error (403 if not an admin of any colony, per-row errors surfaced from the bulk-import response); Success.

### Screen: Pledges (Expected Donations) List + Detail
**Purpose:** Track what donors promised vs. what's actually been paid.
**Data required:** `GET /expected-donations?festival_id=&donor_id=&status=`; detail includes computed `total_donated`.
**APIs required:** `POST /expected-donations`, `GET /expected-donations`, `GET /expected-donations/:id`, `PATCH /expected-donations/:id`, plus `POST /donations` for logging a payment, `GET /donations?expected_id=` for the payment log.
**Actions:** Create a pledge; log a payment against it; edit amount/year/purpose; mark closed (deliberate action, never automatic).
**States:** Loading; Empty (no pledges); Error (400 bad FK, 403 not a colony admin); Success — progress-bar UI (`expected_amount` vs `total_donated`).

### Screen: Log a Walk-in Donation
**Purpose:** Record a gift with no prior pledge.
**Data required:** donor (existing or newly created), amount, date, optional collector.
**APIs required:** `POST /donors` (if new), `POST /donations` (no `expected_id`).
**Actions:** Quick-add flow.
**States:** Loading; Error; Success — note this donation won't appear in any festival's balance.

### Screen: Budget Lines (Expenses) List + Detail
**Purpose:** Mirror of Pledges for the spending side.
**Data required:** `GET /expenses?festival_id=&status=`; detail includes computed `total_paid`.
**APIs required:** `POST /expenses`, `GET /expenses`, `GET /expenses/:id`, `PATCH /expenses/:id`, `DELETE /expenses/:id`, plus `POST /expense-payments`, `GET /expense-payments?expense_id=`, `DELETE /expense-payments/:id`.
**Actions:** Create a planned cost; log a payment; edit planned amount/vendor/purpose; mark settled; delete an expense (soft — hides its payment history too) or a single payment.
**States:** Loading; Empty; Error; Success — flag if `total_paid` exceeds `amount_planned` (API allows overpayment silently).

### Screen: Task Board
**Purpose:** Kanban-style view of festival work items.
**Data required:** `GET /tasks?festival_id=&status=`; `GET /task-assignments?task_id=` for the signed-up list.
**APIs required:** `POST /tasks`, `GET /tasks`, `GET /tasks/:id`, `PATCH /tasks/:id`, `DELETE /tasks/:id`, `POST /task-assignments`, `GET /task-assignments`, `DELETE /task-assignments/:id`.
**Actions:** Create a task (colony admin); move between planned/in_progress/done (colony admin); a colony admin adds/removes volunteer signups on behalf of members (chip-style, nothing to edit on a signup) — **no longer self-service**, an ordinary member can't sign themselves up (see §5); delete a task (blocked with 400 if volunteers are signed up — must remove them first).
**States:** Loading; Empty; Error (403 if not a colony admin, 400 on blocked delete); Success — show "X of Y signed up" against `labor_required` as informational only, never a hard cap.

### Screen: Volunteer Directory / Profile
**Purpose:** There is no separate volunteer directory anymore — volunteers/organizers **are** `users`. This screen is really "the colony's member list" (`GET /colonies/:id/members`), plus a per-person profile rolling up their task signups and availability.
**Data required:** `GET /colonies/:id/members` (name/email/phone/role), `GET /task-assignments?user_id=`, `GET /availability?user_id=`.
**APIs required:** `GET /colonies/:id/members`, `POST /colonies/:id/members`, `POST /colonies/:id/members/bulk`, `POST /colonies/:id/members/:userId/reset-password`, `PATCH /colonies/:id/members/:userId`, plus the filtered lists above, and `POST/PATCH/DELETE /availability` (colony-admin only, see §5).
**Actions:** Add a person to the colony by linking their existing account or creating a new one on the spot (colony admin — see the Colony Detail screen above, same endpoint); bulk-onboard a roster via CSV/XLSX, showing the created/skipped/error breakdown per row; reset a person's password (colony admin, no current-password check); promote/demote within the colony; view a person's signups and availability calendar; a colony admin toggles a day's availability on someone's behalf (not self-service, see §5).
**States:** Loading; Empty; Error (403 not-admin, 400 on a new-account bulk row missing name/password, per-row errors surfaced from a bulk-import response rather than a single top-level error); Success.

---

## 9. User Journey

```
Login / Register
  ↓
Colony Picker  ("mine" vs "all")
  ↓
Festival Dashboard  (current_balance headline)
  ├─→ Donors → Donor Detail → Pledges/Donations for that donor
  ├─→ Pledges (Expected Donations) → Pledge Detail → log Donation
  ├─→ Walk-in Donation quick-add
  ├─→ Budget Lines (Expenses) → Expense Detail → log Expense Payment
  ├─→ Task Board → Task Detail → colony admin assigns/removes volunteers
  └─→ Volunteer Directory → Profile → signups + availability
```

Colony membership management (add/remove/promote members, edit colony name/location) sits one level above the Festival Dashboard, on the Colony Detail screen, and is only actionable by an admin. As of this change, that's true of essentially every write in the app — colony-admin is the only write role anywhere below the Colony Picker.

---

## 10. MVP Scope

### Must Have
- Login / Register (only two auth screens the backend supports)
- Colony picker + create colony
- Festival dashboard (create, list, view balance)
- Donors: create/list/view/edit
- Expected Donations: create/list/view/edit + status
- Donations: create (pledge-linked and walk-in), list, delete
- Expenses: create/list/view/edit + status, delete
- Expense Payments: create, list, delete
- Tasks: create/list/view/edit status, delete
- Task Assignments: add/remove signup

### Should Have
- Colony membership management screen (add/remove/promote members, create-or-link, reset password) — needed for any colony with more than one organizer, but not needed for a single-admin colony testing the rest of the app
- Volunteer directory (`GET /colonies/:id/members`) — needed as soon as `collected_by`/`paid_by`/task assignment/availability screens are built, since they all need a user picker. There is no separate roster table anymore; this doubles as the picker source.
- Availability calendar (colony admin toggles on a volunteer's behalf, not self-service)

### Later
- Any "my colonies" convenience filtering polish
- Cross-referencing Availability against Tasks' `planned_date`/`labor_required` (not provided by the API — would be client-side join logic)
- Anything depending on features the backend doesn't have yet: refresh tokens, user profile screen, push notifications, general (non-roster) file/photo uploads, pagination — none of these exist server-side today. (Partial `?search=` now exists on three endpoints — users/donors/colonies, see §4 — but there is still no pagination anywhere.) **Password reset** is partial: a logged-in user can change their own password (`PATCH /auth/change-password`), and a colony admin can reset a member's password (`POST /colonies/:id/members/:userId/reset-password`) — but there's still no "forgot password" self-service flow (no email/SMS, no token, no unauthenticated reset path).

---

## 11. Architecture Observations

**Actual request flow:**
```
Client
 → Express route handler (routes/*.js) — parses params/query/body, calls service, sets status
 → (app-wide requireAuth middleware, only for mutating verbs, applied before the resource routers)
 → Service function (services/*.js) — validation, colony-authorization checks, raw SQL via pg
 → Postgres (via db/pool.js's shared Pool)
 → Central error-handling middleware (app.js) catches anything thrown/passed to next(err)
```

There is no separate "controller" layer distinct from the route file, and no model layer distinct from inline SQL in services — a flatter structure than the classic MVC split, but consistent throughout.

**Good architectural decisions:**
- Consistent `err.status`-on-Error convention makes the single central error handler sufficient for the whole app — no per-route try/catch duplication of status logic.
- Computed totals (`total_donated`, `total_paid`, `current_balance`) are genuinely never stored, matching CLAUDE.md's rule and avoiding drift bugs.
- Postgres CHECK constraints are treated as the single source of truth for enums (task status, colony role) rather than re-validated in JS — one place to change the valid set.
- The colony-authorization logic is centralized in one service file (`colonyMembershipService.js`) with resolver functions per FK chain, rather than duplicated per resource.
- Splitting `app.js` (exported, listen-less) from `index.js` (thin, calls `.listen()`) specifically to make the app testable in-process is a clean, deliberate choice, confirmed by the test file using it.
- `db/pool.js`'s DATE type-parser patch is a real, documented fix for a genuine pg/timezone footgun, applied once globally rather than per-query.

**Potential concerns for whoever builds on top of this:**
- **No pagination anywhere.** Every list endpoint returns the full table filtered only by exact-match query params. A mobile client should assume list responses could grow unbounded over a festival's lifetime (e.g. `donations`) and may want its own client-side windowing/lazy-loading, since the server won't do it.
- **Colony scoping is now consistent** (previously flagged here as inconsistent, across three prior sessions) — every write in the app requires colony-admin, either of a specific colony (resolved via FK chain) or of at least one colony (`donors`/walk-in `donations`/`availability`, which have no FK path to a specific colony). `members` no longer exists, so its old "optional scoping" middle ground is gone too.
- **Inconsistent delete semantics** across resources (soft-delete for 3 money tables, hard-delete for 3 lower-stakes tables, no delete at all for the remaining 6) is intentional per CLAUDE.md/PROGRESS.md, but it means a mobile client can't apply one generic "delete" UX pattern everywhere — it has to know, per-resource, which behavior applies.
- **No user profile / `/me` endpoint.** A mobile client has no server-provided way to fetch "who am I" other than what it captured from the login response's JWT payload client-side (email/user_id only, no `name` — decode the JWT or persist it from login/register). If the token needs re-hydrating after app restart, the client must decode the stored JWT itself.
- **No refresh token / session extension.** A 7-day hard expiry with no silent renewal means a mobile client must handle full re-authentication reasonably often, including mid-form (the UI_UX_FUNCTIONAL_SPEC.md flags this explicitly).
- **Duplicated authorization-resolution pattern.** Each service that needs colony scoping repeats the same `const colonyId = await colonyIdForX(...); if (colonyId !== null) await assertColonyAdmin(...)` shape. Not currently a bug, but worth knowing it's copy-pasted per resource rather than middleware-enforced, so a future rule change would need touching every service file individually.
- **Placeholder accounts from the members→users migration.** Any pre-existing `members` row that had task-assignment/availability history but no linked login got an auto-created `users` row with an unusable random password (migration 014) — a colony admin needs to run `POST /colonies/:id/members/:userId/reset-password` before that person can actually log in. A mobile client shouldn't assume every row in `GET /colonies/:id/members` currently has a working password.
- **`vendor_name` and `purpose` fields are free text**, not linked entities — a mobile client shouldn't expect a vendor picker or autocomplete backed by a real `vendors` table; none exists.
- **Environment/deploy note (from PROGRESS.md, not something to re-verify yourself):** the `.env` `DATABASE_URL` at the time of the last recorded session pointed at a Render-internal hostname unreachable outside Render's network, and migration `009` (colony_memberships) had not yet been applied to that production database. A mobile client developer hitting a deployed instance should confirm with the backend owner that migrations are current before assuming colony-membership behavior is live there.

---

## 12. Unknowns / Questions

- **Is there a deployed/staging URL the mobile app should target**, or is local-only development the current state? Not present in the code — `.env`'s `PORT`/`DATABASE_URL` are local dev config, and PROGRESS.md mentions a Render instance but its accessibility/migration status as of today is unconfirmed.
- ~~Will `donors`/`availability`/walk-in-donations ever become colony-scoped?~~ **Resolved by this change**: yes, all three now require the caller to be an admin of at least one colony (see §5) — closing what had been an open, deliberately deferred question across three prior sessions.
- **Is there any intent to add roles beyond colony admin/member** (e.g. a "volunteer" self-service login, or a global platform-admin role)? With colony-admin now the only write role, `'member'` is closer to a pure read/roster-visibility marker than a role in its own right — worth asking whether that's the intended long-term shape, or whether some middle "member can do X but not Y" tier will be wanted later.
- **Cascade/deletion policy for colonies, festivals, donors, and expected_donations** is explicitly unresolved in the backend itself (no DELETE endpoints exist for any of them) — a mobile app should not assume these will ever be deletable, nor guess at what "delete a colony" should cascade to.
- **Push notifications, file/photo attachments (e.g. a photo of a receipt for an expense payment), and any offline-sync expectations** — none of these exist in the backend today; if the mobile app needs them, they would require new backend work, not just client work.
- **Whether the 12-domain UI_UX_FUNCTIONAL_SPEC.md's screen inventory should be treated as authoritative for information architecture** — it's a strong starting point and mostly consistent with this analysis, but was written before colony membership existed, so its "one role, no per-colony scoping" framing (rule 5 in that doc) is now incorrect and should be disregarded in favor of Section 5 above. It also still describes a standalone `members` roster, which no longer exists as of this change.
- **Migration-014 placeholder accounts (see §11) still need reset-password runs.** Before relying on `GET /colonies/:id/members` rows as "this person can log in," confirm with the backend owner whether that one-time cleanup has actually been run against whichever database the mobile app targets.
