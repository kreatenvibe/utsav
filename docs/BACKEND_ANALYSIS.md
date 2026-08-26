# Backend Analysis — Festival Management API

*Written for a developer building a React Native mobile client on top of this backend. This document describes the system as it exists in the code today. Nothing here is a proposal or a recommendation to change anything.*

*Note: `UI_UX_FUNCTIONAL_SPEC.md` in the repo root is a related, very detailed document but it predates migration `009_colony_memberships.sql` — it still describes "one role, no per-colony scoping." That is now out of date. This document reflects the current code, including colony membership and per-colony write permissions.*

---

## 1. Understand the Product

**Problem it solves:** Coordinates the finances and logistics of a community festival (the codebase's own example is Ganesh Chaturthi) run by a housing colony/neighborhood association. It tracks who pledged money, who actually paid, what was planned to be spent, what was actually spent, what work needs doing, and who's available/signed up to do it.

**Expected users:** Festival organizers (the people who create colonies, festivals, log donations/expenses, assign tasks). There is currently no volunteer-facing or donor-facing login — volunteers and donors exist only as data records referenced by organizers.

**User roles that exist in the code today:**
- **Unauthenticated visitor** — can read (GET) everything, no login needed.
- **Registered user ("organizer")** — anyone who registers via `/auth/register` can write. There is no global admin/super-user role.
- **Colony member** (`colony_memberships.role = 'member'`) — can write data scoped to that colony (festivals, expenses, tasks, donations linked through the colony's festivals, etc.) once added to the colony.
- **Colony admin** (`colony_memberships.role = 'admin'`) — everything a member can do, plus manage colony membership (add/remove/promote/demote members) and edit the colony's own `name`/`location`. The colony creator is auto-admined. A colony can never be left with zero admins (enforced in code).

There is no "volunteer" or "donor" login role — `members` and `donors` are plain data rows, not user accounts.

**Major business domains/modules** (12 route groups):
1. Auth (users/login)
2. Colonies (+ colony membership)
3. Festivals
4. Members (volunteers/organizers directory — distinct from login `users`)
5. Donors
6. Expected Donations (pledges)
7. Donations (actual payments)
8. Expenses (planned costs)
9. Expense Payments (actual payments)
10. Tasks
11. Task Assignments (volunteer signups)
12. Availability (volunteer yes/no calendar)

**How domains relate:** Everything nests under a **Colony → Festival**. Festivals own Expected Donations, Expenses, and Tasks. Each of those has a child "payment/actual" table (Donations, Expense Payments) or child junction (Task Assignments). Donors and Members are flat directories referenced by FK from the money/task tables, not scoped to a colony themselves.

```
Colony
 └─ Festival  (current_balance is COMPUTED here)
     ├─ Expected Donations (pledge)
     │    └─ Donations (frozen payment log)
     ├─ Expenses (planned cost)
     │    └─ Expense Payments (frozen payment log)
     └─ Tasks
          └─ Task Assignments (volunteer signups)

Donors  → Expected Donations, Donations
Members → Task Assignments, Availability, (optional attribution on Donations/Expense Payments)
Users   → colony_memberships → Colony  (login identity, separate from Members)
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
- **Middleware:** [middleware/auth.js](middleware/auth.js) — `requireAuth` verifies a `Bearer` JWT and attaches `req.user = { user_id, email }`. Applied globally to all mutating verbs in `app.js`, and additionally applied explicitly on two GET routes in `routes/colonies.js` (`/mine`, `/:id/members`) since those expose other users' data.
- **Authorization:** [services/colonyMembershipService.js](services/colonyMembershipService.js) — not a route-level middleware but a set of service-layer helper functions (`assertColonyMember`, `assertColonyAdmin`, and per-resource `colonyIdFor*` resolvers) that every mutating service calls before writing.
- **Validation:** No schema library (no Joi/Zod/express-validator). Manual `if (!field) throw` checks at the top of each service function, plus reliance on Postgres constraints (`NOT NULL`, `CHECK`, FK) as a second line of defense, with Postgres error codes (`23503` FK violation, `23505` unique violation, `23514` check violation) caught and translated into friendly 400/409 messages.
- **Error handling:** One centralized Express error-handling middleware at the bottom of `app.js`: `res.status(err.status || 500).json({ error: err.message })`. All routes forward failures via `next(err)`.
- **Config/env vars:** Loaded via `dotenv`. Three vars used: `DATABASE_URL`, `PORT`, `JWT_SECRET`. `.env` is gitignored.
- **Background jobs / scheduled tasks:** None exist.
- **External services:** None — no email, SMS, push, file storage, or third-party API integration anywhere in the code.
- **File uploads:** None — no multipart handling, no storage layer.
- **Logging:** None beyond `console.log`/`console.error` in the migration runner and server startup. No structured logging or request logging middleware.
- **Testing:** [test/colonyMembership.test.js](test/colonyMembership.test.js) — Node's built-in test runner (`node --test`) + `supertest`, run against a real Postgres database (no mocking). Covers only the colony-membership/authorization feature; no tests exist yet for the other 11 modules' basic CRUD.

---

## 3. Database & Data Model

**Technology:** PostgreSQL, accessed via the `pg` driver with no ORM. Schema built up across 9 migration files.

### Entities

**users** (`migrations/008`)
- `user_id` (PK, serial), `email` (unique, required), `password_hash` (required, bcrypt), `created_at` (auto).
- Purpose: login identity only. Deliberately separate from `members` (see PROGRESS.md) — a login account is not the same concept as a festival volunteer/organizer contact.
- No update/delete endpoints exist for `users` themselves.

**colony_memberships** (`migrations/009`)
- `colony_membership_id` (PK), `colony_id` (FK → colony), `user_id` (FK → users), `role` (`'admin'`|`'member'`, default `'member'`, CHECK-enforced), `created_at`.
- `UNIQUE (colony_id, user_id)` — one membership row per user per colony.
- Purpose: which users can write to which colony's data, and with what privilege.

**colony**
- `colony_id` (PK), `name` (required), `location` (optional, free text).
- Top of the hierarchy — a neighborhood/housing colony.

**festival**
- `festival_id` (PK), `colony_id` (FK, required), `name` (required), `year` (required).
- `current_balance` originally existed as a stored column (migration 001) but was **dropped** in migration 006 — it's now always computed at query time (see below). This is a deliberate, confirmed-with-user schema change; CLAUDE.md's "current_balance is always computed, never stored" rule reflects this.

**members**
- `member_id` (PK), `name` (required), `phone` (optional), `colony_id` (FK → colony, **nullable**, added in migration 010).
- Unified directory of organizers + volunteers. Not a login identity, no relation to `users`.
- **Optionally colony-scoped** (migration 010): `colony_id IS NULL` (all pre-migration rows, and any row created without a `colony_id`) behaves exactly as before — a global, unscoped directory entry any authenticated user can create/edit. `colony_id` set means the row belongs to that colony's private roster, and creating it required colony-admin privilege (see §5). Once set, `colony_id` is **immutable** — no PATCH support for moving a member between colonies or in/out of scoping (deliberate, see §4).
- `UNIQUE (colony_id, phone)` as a **partial** index, `WHERE colony_id IS NOT NULL` — duplicate phone numbers are rejected only within the same colony's roster (409). Unscoped rows have no uniqueness constraint at all (same as pre-migration behavior), and the same phone number can appear in more than one colony's roster as distinct rows — see §4 for the reasoning.

**donors**
- `donor_id` (PK), `name` (required), `phone` (optional).
- People who give money. Structurally identical to `members` but kept as a separate table/concept.

**expected_donations** (a pledge)
- `expected_id` (PK), `donor_id` (FK, required), `festival_id` (FK, required), `expected_amount` (required), `year` (required), `purpose` (free text, optional), `status` (`'open'`|`'closed'`, default `'open'`, CHECK-enforced, organizer-set).
- `total_donated` is **not a column** — computed on every read by summing linked, non-deleted `donations`.

**donations** (actual payment against a pledge, or a walk-in gift)
- `donation_id` (PK), `donor_id` (FK, required), `expected_id` (FK, **nullable** — null means a walk-in gift with no pledge), `amount` (required, frozen after insert), `date` (required, plain DATE), `collected_by` (FK → members, nullable, attribution only), `deleted_at` (soft-delete marker, migration 007).
- No PATCH endpoint exists at all — `amount` truly cannot be edited once created.

**expenses** (planned cost)
- `expense_id` (PK), `festival_id` (FK, required), `purpose` (optional), `vendor_name` (optional, free text — not a linked entity), `amount_planned` (required, editable estimate), `status` (`'open'`|`'settled'`, default `'open'`), `deleted_at` (soft-delete).
- `total_paid` computed by summing linked, non-deleted `expense_payments`.

**expense_payments** (actual payment against an expense)
- `payment_id` (PK), `expense_id` (FK, required), `amount` (required, frozen), `date` (required), `paid_by` (FK → members, nullable, attribution only), `deleted_at` (soft-delete).
- No PATCH endpoint at all.

**tasks**
- `task_id` (PK), `festival_id` (FK, required), `title` (required), `planned_date` (optional DATE), `labor_required` (optional integer — a target headcount, purely informational, never enforced), `status` (`'planned'`|`'in_progress'`|`'done'`, DB CHECK-enforced, default `'planned'`).
- Hard-deleted (no `deleted_at`). Delete is blocked by a real FK violation (caught, returned as 400) if `task_assignments` still reference the task.

**task_assignments** (junction: a volunteer signing up for a task)
- `assignment_id` (PK), `task_id` (FK, required), `member_id` (FK, required), `signed_up_at` (auto timestamp).
- No status/role/day fields — an informal, unenforced signup. Hard-deleted. No PATCH.

**availability**
- `availability_id` (PK), `member_id` (FK, required), `date` (required, identity field — not editable), `is_available` (required boolean, the only PATCH-able field).
- Date-level only, no time-of-day granularity. Hard-deleted.

### Relationship overview

```
users ──(colony_memberships, role)──▶ colony
colony ──1:N──▶ festival
festival ──1:N──▶ expected_donations, expenses, tasks
expected_donations ──1:N──▶ donations
expenses ──1:N──▶ expense_payments
tasks ──1:N──▶ task_assignments
donors ──1:N──▶ expected_donations, donations
members ──1:N──▶ task_assignments, availability
members ──optional FK──▶ donations.collected_by, expense_payments.paid_by
colony ──0:N──▶ members  (optional; NULL colony_id = unscoped, unchanged from pre-migration-010 behavior)
```

### Derived/calculated values (never stored)
- `expected_donations.total_donated` = SUM(`donations.amount`) where `expected_id` matches and `deleted_at IS NULL`.
- `expenses.total_paid` = SUM(`expense_payments.amount`) where `expense_id` matches, both expense and payment not soft-deleted.
- `festival.current_balance` = SUM(donations linked via expected_donations to this festival) − SUM(expense_payments linked via expenses to this festival), both excluding soft-deleted rows. **Walk-in donations (`expected_id IS NULL`) are excluded** — there's no schema path from a walk-in donation to a festival.

### Explicitly out of scope / unscoped by design (flagged in code, not bugs)
- Walk-in donations, `availability`, and `donors` have no `colony_id` and are **not** colony-permission-scoped — any authenticated user can write them regardless of colony membership.
- `members` is **optionally** scoped as of migration 010 (see above) — a row with no `colony_id` behaves exactly like the always-unscoped resources above; a row with `colony_id` set requires colony-admin to create and is filterable via `GET /members?colony_id=`.
- No self-service "leave a colony" — only an admin can remove a member (including another admin, down to but not the last one).

---

## 4. API Inventory

Base URL has no global prefix (e.g. routes are mounted directly at `/colonies`, not `/api/colonies`). All list endpoints return plain JSON arrays (no pagination, no envelope, no total-count metadata) — the whole app has no pagination anywhere. 🔒 = requires `Authorization: Bearer <jwt>` (checked by the app-wide gate on POST/PUT/PATCH/DELETE); reads are public unless noted.

### Auth

| Method | Endpoint | Purpose | Auth |
|---|---|---|---|
| POST | `/auth/register` | Create a user account | — |
| POST | `/auth/login` | Log in, get a JWT | — |

- **Register** body: `{ email, password }`. Response `201`: `{ user_id, email }` (no password hash, no token). 400 if either field missing. 409 if email already registered.
- **Login** body: `{ email, password }`. Response `200`: `{ token }` (JWT, 7-day expiry). 400 if fields missing. 401 for either wrong password or unknown email — identical message both times ("invalid credentials"), by design (doesn't leak which emails exist).

### Colonies

| Method | Endpoint | Purpose | Auth |
|---|---|---|---|
| POST | `/colonies` | Create a colony (creator becomes admin) | 🔒 |
| GET | `/colonies` | List all colonies | — |
| GET | `/colonies/mine` | List colonies the caller belongs to, with their role | 🔒 (always, even though it's a GET) |
| GET | `/colonies/:id` | Colony detail | — |
| PATCH | `/colonies/:id` | Edit name/location | 🔒, colony-admin only |
| GET | `/colonies/:id/members` | List a colony's members (email + role) | 🔒 (always) |
| POST | `/colonies/:id/members` | Add a user (by email) to the colony | 🔒, colony-admin only |
| PATCH | `/colonies/:id/members/:userId` | Change a member's role | 🔒, colony-admin only |
| DELETE | `/colonies/:id/members/:userId` | Remove a member | 🔒, colony-admin only |

- Create body: `{ name, location? }`. 400 if `name` missing.
- Add-member body: `{ email, role? }` (`role` defaults to `'member'`; must be `'admin'`/`'member'`). 404 if no registered user with that email. 409 if already a member.
- Role update body: `{ role }`. 400 if it would demote the last admin.
- Note: `/colonies/mine` must be registered before `/colonies/:id` in the router (it is) or Express would treat "mine" as an `:id` value.

### Festivals

| Method | Endpoint | Purpose | Auth |
|---|---|---|---|
| POST | `/festivals` | Create a festival | 🔒, must be a member of the target colony |
| GET | `/festivals?colony_id=` | List, optional colony filter | — |
| GET | `/festivals/:id` | Detail, includes computed `current_balance` | — |
| PATCH | `/festivals/:id` | Edit name/year | 🔒, must be a member of the festival's colony |

- Create body: `{ colony_id, name, year }`, all required. 400 on missing field or bad `colony_id` FK.

### Members (volunteer/organizer directory)

| Method | Endpoint | Purpose | Auth |
|---|---|---|---|
| POST | `/members` | Create | 🔒, colony-admin **only if** `colony_id` is given; any authenticated user otherwise |
| GET | `/members?colony_id=` | List, optional colony filter | — |
| GET | `/members/:id` | Detail | — |
| PATCH | `/members/:id` | Edit name/phone | 🔒 (any authenticated user — `colony_id` not PATCH-able) |

Create body: `{ name, phone?, colony_id? }`. `colony_id` is optional (migration 010) — omit it and behavior is identical to before: any authenticated user creates an unscoped roster row. Provide it and the caller must be a **colony admin** of that colony (`assertColonyAdmin`, 403 otherwise) — a stricter gate than every other write in this resource. 409 if that phone number is already on that colony's roster (`UNIQUE (colony_id, phone)`, colony-scoped only — unscoped rows and cross-colony duplicates are unaffected). 400 if `colony_id` doesn't reference an existing colony. `colony_id` is **immutable after creation** — `PATCH /members/:id` only accepts `name`/`phone`; re-scoping or re-parenting a member to a different colony is out of scope (no precedent elsewhere in the app for reassigning a colony-owned row after creation), and PATCH keeps its original "any authenticated user" gate regardless of whether the row is scoped, since it can't touch scoping either way.

### Donors

| Method | Endpoint | Purpose | Auth |
|---|---|---|---|
| POST | `/donors` | Create | 🔒 |
| GET | `/donors` | List | — |
| GET | `/donors/:id` | Detail | — |
| PATCH | `/donors/:id` | Edit name/phone | 🔒 |

Same shape as Members; not colony-scoped.

### Expected Donations (pledges)

| Method | Endpoint | Purpose | Auth |
|---|---|---|---|
| POST | `/expected-donations` | Create a pledge | 🔒, must be a member of the festival's colony |
| GET | `/expected-donations?festival_id=&donor_id=&status=` | List, filterable | — |
| GET | `/expected-donations/:id` | Detail, includes computed `total_donated` | — |
| PATCH | `/expected-donations/:id` | Edit amount/year/purpose/status | 🔒, colony member |

Create body: `{ donor_id, festival_id, expected_amount, year, purpose? }`, first four required. `status` must be `'open'`/`'closed'` on PATCH (400 otherwise).

### Donations

| Method | Endpoint | Purpose | Auth |
|---|---|---|---|
| POST | `/donations` | Log a payment (or walk-in gift) | 🔒, colony member if tied to a pledge; unscoped if walk-in |
| GET | `/donations?donor_id=&expected_id=` | List, filterable | — |
| GET | `/donations/:id` | Detail | — |
| DELETE | `/donations/:id` | Soft delete | 🔒, colony member if tied to a pledge |

Create body: `{ donor_id, expected_id?, amount, date, collected_by? }`. No PATCH exists — `amount` is frozen.

### Expenses

| Method | Endpoint | Purpose | Auth |
|---|---|---|---|
| POST | `/expenses` | Create a planned cost | 🔒, colony member |
| GET | `/expenses?festival_id=&status=` | List, filterable | — |
| GET | `/expenses/:id` | Detail, includes computed `total_paid` | — |
| PATCH | `/expenses/:id` | Edit purpose/vendor/amount_planned/status | 🔒, colony member |
| DELETE | `/expenses/:id` | Soft delete | 🔒, colony member |

Create body: `{ festival_id, purpose?, vendor_name?, amount_planned }`. `status` must be `'open'`/`'settled'`.

### Expense Payments

| Method | Endpoint | Purpose | Auth |
|---|---|---|---|
| POST | `/expense-payments` | Log a payment | 🔒, colony member |
| GET | `/expense-payments?expense_id=` | List, filterable | — |
| GET | `/expense-payments/:id` | Detail | — |
| DELETE | `/expense-payments/:id` | Soft delete | 🔒, colony member |

Create body: `{ expense_id, amount, date, paid_by? }`. No PATCH.

### Tasks

| Method | Endpoint | Purpose | Auth |
|---|---|---|---|
| POST | `/tasks` | Create | 🔒, colony member |
| GET | `/tasks?festival_id=&status=` | List, filterable | — |
| GET | `/tasks/:id` | Detail | — |
| PATCH | `/tasks/:id` | Edit title/date/headcount/status | 🔒, colony member |
| DELETE | `/tasks/:id` | Hard delete, blocked if signups exist | 🔒, colony member |

Create body: `{ festival_id, title, planned_date?, labor_required? }`. `status` restricted to `'planned'`/`'in_progress'`/`'done'` by a DB CHECK (400 on violation).

### Task Assignments

| Method | Endpoint | Purpose | Auth |
|---|---|---|---|
| POST | `/task-assignments` | Sign a member up for a task | 🔒, colony member (via task→festival→colony) |
| GET | `/task-assignments?task_id=&member_id=` | List, filterable either direction | — |
| GET | `/task-assignments/:id` | Detail | — |
| DELETE | `/task-assignments/:id` | Cancel a signup | 🔒, colony member |

Create body: `{ task_id, member_id }`. No PATCH — nothing on a signup is editable.

### Availability

| Method | Endpoint | Purpose | Auth |
|---|---|---|---|
| POST | `/availability` | Create a day's yes/no | 🔒 (not colony-scoped) |
| GET | `/availability?member_id=&date=` | List, filterable | — |
| GET | `/availability/:id` | Detail | — |
| PATCH | `/availability/:id` | Flip `is_available` only | 🔒 |
| DELETE | `/availability/:id` | Hard delete | 🔒 |

Create body: `{ member_id, date, is_available }`, all required; `is_available` must be a JS boolean (400 otherwise).

**No pagination, filtering-only-by-exact-match query params, no full-text search, and no sort-order control anywhere in the API** — every list is `ORDER BY <primary key> ASC` with no override.

---

## 5. Authentication & Authorization

**Mechanism:** Stateless JWT, signed with `JWT_SECRET`, 7-day expiry, no refresh token.

- **Registration** (`POST /auth/register`): email + password, bcrypt-hashed (`bcryptjs`, 10 salt rounds) via `authService.registerUser`. No email verification, no roles selection.
- **Login** (`POST /auth/login`): returns `{ token }` only — no user profile info in the response body.
- **Logout:** Not implemented server-side (stateless JWT — client just discards the token). No token blacklist/revocation.
- **Token contents:** `{ user_id, email }` plus standard JWT claims (`iat`, `exp`).
- **Token verification:** `middleware/auth.js`'s `requireAuth` — reads `Authorization: Bearer <token>`, verifies with `jsonwebtoken`, 401 on missing header, malformed header, invalid signature, or expired token. Sets `req.user`.
- **Password reset:** Not implemented — no endpoint, no email flow.
- **User profile:** No `GET /me` or profile endpoint exists at all. The only way to learn the current user's `user_id`/`email` is what was embedded in the JWT at login (decode client-side) or infer via `/colonies/mine`.
- **Global gate:** In `app.js`, every `POST`/`PUT`/`PATCH`/`DELETE` request across the whole app requires a valid JWT (applied *after* `/auth` is mounted, so register/login stay open). All `GET` requests are public with no exceptions **except** `/colonies/mine` and `/colonies/:id/members`, which explicitly require auth even though they're GETs (because they expose other users' emails).
- **Roles/permissions beyond colony membership:** None. There is no system-wide admin role — every registered user has equal footing to create colonies and become an admin of their own.
- **Authorization (colony-scoped):** Handled entirely in the service layer (not middleware) via `colonyMembershipService.js`. Every mutating call to a colony-descended resource (festivals, expected_donations, donations-with-a-pledge, expenses, expense_payments, tasks, task_assignments) resolves the resource's owning `colony_id` and asserts `assertColonyMember` (403 if not a member). Colony-level admin actions (editing colony name/location, adding/removing/promoting members) require `assertColonyAdmin`. `donors`, `availability`, and walk-in `donations` (no `expected_id`) are **not** colony-scoped at all — any authenticated user can write them. `members` (migration 010) is the one resource where scoping is **conditional on the request body**: omit `colony_id` and it behaves like the unscoped resources above; provide it and the caller must be a colony admin (`assertColonyAdmin`), not just a member — stricter than the member-level gate used everywhere else.

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
3. Admin can `POST /colonies/:id/members` with another registered user's email to add them (default role `member`); 404 if that email isn't registered yet (no invite-by-email-to-unregistered-user flow exists).
4. From here on, every write under that colony's festivals/expenses/tasks/etc. checks the acting user against `colony_memberships`.

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
2. Volunteers (already existing `members` rows) sign up via `POST /task-assignments` — a simple join, no capacity check against `labor_required` (informational only, never enforced).
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
| Insufficient colony privilege | 403 | `"you are not a member of this colony"` / `"you must be an admin of this colony to do that"` | `colonyMembershipService.assertColonyMember/assertColonyAdmin` |
| Missing/invalid/expired JWT on a write | 401 | `"missing or malformed Authorization header"` / `"invalid or expired token"` | `middleware/auth.js` |
| Wrong password or unknown email at login | 401 | `"invalid credentials"` (identical message, intentionally) | `authService.loginUser` |
| Row not found (or soft-deleted) | 404 | `"donation not found"` etc. | Manual `if (!rows[0]) throw` in every `get*` |
| Duplicate email at registration | 409 | `"email already registered"` | Caught Postgres `23505` |
| Duplicate colony membership | 409 | `"that user is already a member of this colony"` | Caught Postgres `23505` |
| Removing/demoting the last colony admin | 400 | `"cannot remove the last admin of a colony"` | Manual check (`isSoleAdmin`) |
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
**Data required:** email, password.
**APIs required:** `POST /auth/register`, `POST /auth/login`.
**Actions:** Submit registration; submit login; switch between the two forms.
**States:** Loading (submitting); Error (400 missing field, 409 duplicate email, 401 bad credentials); Success (registered → prompt login; logged in → store token, navigate to Colony picker).

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
**Data required:** `GET /colonies/:id`; `GET /colonies/:id/members` (auth required).
**APIs required:** `GET /colonies/:id`, `PATCH /colonies/:id` (admin), `GET /colonies/:id/members`, `POST /colonies/:id/members`, `PATCH /colonies/:id/members/:userId`, `DELETE /colonies/:id/members/:userId`.
**Actions:** Edit name/location (admin only); add a member by email (admin only, fails if that email hasn't registered); promote/demote a member; remove a member (blocked if it's the last admin).
**States:** Loading; Error (403 if not admin attempting a mutation, 404 if email unregistered, 400 on last-admin removal); Success.

### Screen: Festival Dashboard
**Purpose:** The main "home" screen for a specific festival — shows the live balance and links into every other module.
**Who can access it:** Anyone to view; write requires colony membership.
**Data required:** `GET /festivals/:id` (includes computed `current_balance`).
**APIs required:** `GET /festivals`, `GET /festivals/:id`, `POST /festivals`, `PATCH /festivals/:id`.
**Actions:** Switch festival/year; edit name/year (colony member); create a new festival under a colony.
**States:** Loading; Empty (no festivals yet in this colony); Error; Success — highlight `current_balance` as the headline stat.

### Screen: Donors Directory + Donor Detail
**Purpose:** Manage the list of people who give money; drill into one donor's pledges/gifts.
**Data required:** `GET /donors`, `GET /donors/:id`, and filtered `GET /expected-donations?donor_id=`, `GET /donations?donor_id=`.
**APIs required:** `POST /donors`, `GET /donors`, `GET /donors/:id`, `PATCH /donors/:id`.
**Actions:** Add/edit a donor; view their pledge and payment history (multiple calls, not bundled by the API).
**States:** Loading; Empty; Error; Success.

### Screen: Pledges (Expected Donations) List + Detail
**Purpose:** Track what donors promised vs. what's actually been paid.
**Data required:** `GET /expected-donations?festival_id=&donor_id=&status=`; detail includes computed `total_donated`.
**APIs required:** `POST /expected-donations`, `GET /expected-donations`, `GET /expected-donations/:id`, `PATCH /expected-donations/:id`, plus `POST /donations` for logging a payment, `GET /donations?expected_id=` for the payment log.
**Actions:** Create a pledge; log a payment against it; edit amount/year/purpose; mark closed (deliberate action, never automatic).
**States:** Loading; Empty (no pledges); Error (400 bad FK, 403 not a colony member); Success — progress-bar UI (`expected_amount` vs `total_donated`).

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
**Actions:** Create a task; move between planned/in_progress/done; add/remove volunteer signups (chip-style, nothing to edit on a signup); delete a task (blocked with 400 if volunteers are signed up — must remove them first).
**States:** Loading; Empty; Error (400 on blocked delete — should be caught and explained); Success — show "X of Y signed up" against `labor_required` as informational only, never a hard cap.

### Screen: Volunteer Roster / Member Profile
**Purpose:** Directory of members; a profile rolling up their task signups and availability.
**Data required:** `GET /members`, `GET /members/:id`, `GET /task-assignments?member_id=`, `GET /availability?member_id=`.
**APIs required:** `POST /members`, `GET /members`, `GET /members/:id`, `PATCH /members/:id`, plus the above filtered lists, and `POST/PATCH/DELETE /availability`.
**Actions:** Add/edit a member; view their signups and availability calendar; toggle a day's availability (create if absent, PATCH `is_available` if it exists — the API can't "move" a date, only delete-and-recreate).
**States:** Loading; Empty; Error; Success.

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
  ├─→ Task Board → Task Detail → assign/remove volunteers
  └─→ Volunteer Roster → Member Profile → signups + availability
```

Colony membership management (add/remove/promote members, edit colony name/location) sits one level above the Festival Dashboard, on the Colony Detail screen, and is only meaningfully actionable by an admin.

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
- Colony membership management screen (add/remove/promote members) — needed for any colony with more than one organizer, but not needed for a single-admin colony testing the rest of the app
- Members directory (create/edit) — needed as soon as `collected_by`/`paid_by`/task assignment/availability screens are built, since they all need a member picker
- Availability calendar (create/toggle/delete)

### Later
- Any "my colonies" convenience filtering polish
- Cross-referencing Availability against Tasks' `planned_date`/`labor_required` (not provided by the API — would be client-side join logic)
- Anything depending on features the backend doesn't have yet: password reset, refresh tokens, user profile screen, push notifications, file/photo uploads, pagination/search — none of these exist server-side today

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
- **Inconsistent colony scoping.** `donors`, `availability`, and walk-in donations are unauthorized by colony (any logged-in user can write them) while most other resources are colony-scoped. `members` (migration 010) sits in between: scoping is opt-in per row via an optional `colony_id` in the create body — a mobile client must not assume every member row belongs to a colony, and must check `colony_id` per-row rather than assuming resource-level scoping. This split is called out explicitly in PROGRESS.md as a deliberate, still-partially-open area — worth confirming with the backend owner whether `donors`/`availability` will follow the same optional-scoping pattern later.
- **Inconsistent delete semantics** across resources (soft-delete for 3 money tables, hard-delete for 3 lower-stakes tables, no delete at all for the remaining 6) is intentional per CLAUDE.md/PROGRESS.md, but it means a mobile client can't apply one generic "delete" UX pattern everywhere — it has to know, per-resource, which behavior applies.
- **No user profile / `/me` endpoint.** A mobile client has no server-provided way to fetch "who am I" other than what it captured from the login response's JWT payload client-side (email/user_id only — decode the JWT or persist it from login). If the token needs re-hydrating after app restart, the client must decode the stored JWT itself.
- **No refresh token / session extension.** A 7-day hard expiry with no silent renewal means a mobile client must handle full re-authentication reasonably often, including mid-form (the UI_UX_FUNCTIONAL_SPEC.md flags this explicitly).
- **Duplicated authorization-resolution pattern.** Each service that needs colony scoping repeats the same `const colonyId = await colonyIdForX(...); if (colonyId !== null) await assertColonyMember(...)` shape (`memberService.createMember`'s `colonyExists`/`assertColonyAdmin` pair, added in migration 010, is the same shape again). Not currently a bug, but worth knowing it's copy-pasted per resource rather than middleware-enforced, so a future change to the rule (e.g. making it apply to `donors` too) would need touching every service file individually.
- **`vendor_name` and `purpose` fields are free text**, not linked entities — a mobile client shouldn't expect a vendor picker or autocomplete backed by a real `vendors` table; none exists.
- **Environment/deploy note (from PROGRESS.md, not something to re-verify yourself):** the `.env` `DATABASE_URL` at the time of the last recorded session pointed at a Render-internal hostname unreachable outside Render's network, and migration `009` (colony_memberships) had not yet been applied to that production database. A mobile client developer hitting a deployed instance should confirm with the backend owner that migrations are current before assuming colony-membership behavior is live there.

---

## 12. Unknowns / Questions

- **Is there a deployed/staging URL the mobile app should target**, or is local-only development the current state? Not present in the code — `.env`'s `PORT`/`DATABASE_URL` are local dev config, and PROGRESS.md mentions a Render instance but its accessibility/migration status as of today is unconfirmed.
- **Will `donors`/`availability`/walk-in-donations ever become colony-scoped?** `members` gained *optional* colony-scoping in migration 010 (see §3/§4/§5); PROGRESS.md flags the remaining three as an open, deliberately deferred decision — not something this analysis can resolve from the code alone.
- **Is there any intent to add roles beyond colony admin/member** (e.g. a "volunteer" self-service login, or a global platform-admin role)? Nothing in the code suggests this is planned, but it's not explicitly ruled out either.
- **Cascade/deletion policy for colonies, festivals, members, donors, and expected_donations** is explicitly unresolved in the backend itself (no DELETE endpoints exist for any of them) — a mobile app should not assume these will ever be deletable, nor guess at what "delete a colony" should cascade to.
- **Push notifications, file/photo attachments (e.g. a photo of a receipt for an expense payment), and any offline-sync expectations** — none of these exist in the backend today; if the mobile app needs them, they would require new backend work, not just client work.
- **Whether the 12-domain UI_UX_FUNCTIONAL_SPEC.md's screen inventory should be treated as authoritative for information architecture** — it's a strong starting point and mostly consistent with this analysis, but was written before colony membership existed, so its "one role, no per-colony scoping" framing (rule 5 in that doc) is now incorrect and should be disregarded in favor of Section 5 above.
