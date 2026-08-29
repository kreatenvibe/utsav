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
JWT auth guards all write endpoints, colony-admin is now the only write role
app-wide (see below — this closes the walk-in-donations/availability/donors
scoping gap that was previously deferred here), the `members` table is
gone (retired in favor of `users` + `colony_memberships`), and `email` is
gone too — phone is now the sole login identifier and self-registration no
longer exists (see below; this opens a real, flagged gap — there's no API
path left to create the very first user in a fresh deployment). Next: not
yet decided — open candidates are DELETE for
colonies/festivals/donors/expected_donations (still deferred, cascade
behavior not decided) and how the first-account-provisioning gap should
actually be solved (seed script? ops runbook?). Ask user before picking.

## Done
- **Removed `email` entirely from the identity model — phone is now the sole
  login identifier, self-registration is gone** (database wipe confirmed
  safe by user — test/seed data only, so this is a destructive,
  non-backfilled schema change): `migrations/016_drop_email.sql` drops
  `users_email_or_phone_check`, drops `users.email` (its unique constraint
  goes with it), drops the partial `users_phone_unique` index, sets
  `users.phone NOT NULL`, adds a plain `UNIQUE (phone)` constraint. Final
  `users` shape: `user_id`, `name`, `phone` (required, unique),
  `password_hash`, `created_at`.
  **`POST /auth/register` deleted entirely** — not deprecated, removed from
  `routes/auth.js`; `authService.registerUser` deleted too (no remaining
  caller). `app.js` needed no change — it only mounts the `/auth` router as
  a whole, so removing one route inside it leaves no dead reference. An
  unauthenticated `POST /auth/register` now falls through to the app-wide
  write gate (401); an authenticated one falls through to Express's default
  404 (confirmed via a new test, since nothing in this app has ever had an
  explicit catch-all 404 handler).
  **`POST /auth/login`** simplified to `{ phone, password }` only — the
  email/phone exactly-one-of branching from migration 012 is gone with it.
  400 `"phone and password are required"` if either is missing. JWT payload
  is now `{ user_id, phone }`.
  **Colony membership add (single + bulk)** simplified the same way:
  `POST /colonies/:id/members` body is `{ name, phone, password?, role? }`
  — `phone` always required, no more exactly-one-of logic (400
  `"phone is required"` if missing). Same create-or-link semantics
  unchanged otherwise. Bulk CSV/XLSX columns drop `email` entirely (`name`,
  `phone`, `password`, `role`). Response shapes (`AddMemberResult`, bulk
  created/skipped/errors rows) drop `email`, keep `phone`.
  `GET /users?search=` matches `name`/`phone` only now, response is
  `[{ user_id, name, phone }]`. `GET /colonies/:id/members` drops `email`
  too.
  **Consequential — not explicitly requested, but required so the column
  drop doesn't break existing queries**: `donationService`,
  `expensePaymentService`, `taskAssignmentService`, `availabilityService`
  all `SELECT u.email` to inline `collector`/`payer`/`user` objects on their
  GET responses — all four lost the `email` field from those inlined
  objects (`{ user_id, name, phone }` / `{ name, phone }`, same shape minus
  `email`).
  **Flagged, not fixed — a real gap this change opens**: with
  self-registration gone, there is no API path left to create the very
  first `users` row in a fresh deployment (`POST /colonies/:id/members`
  needs an existing colony admin; `POST /colonies` needs an existing
  authenticated user). The first account now has to be provisioned directly
  against the database, outside the API — flagged in
  `docs/BACKEND_ANALYSIS.md` §3/§5/§12 rather than silently worked around.
  Test suite: `test/usersPhoneLogin.test.js` deleted (it was entirely about
  the retired email/phone dual-login and email-column bulk-import behavior;
  its one still-relevant case — a bulk-import phone row logging in
  successfully — already existed in `test/bulkImport.test.js`).
  `test/colonyMembership.test.js` and `test/bulkImport.test.js` rewritten:
  since there's no more `POST /auth/register` to bootstrap a test user with,
  both files' shared helper now inserts a `users` row directly (bcrypt-hash
  a known password) then logs in via `POST /auth/login` — mirroring the
  real first-admin-provisioning gap above rather than working around it.
  All 17 tests pass (16 rewritten/pre-existing + 1 new, confirming
  `POST /auth/register` truly 404s for an authenticated caller — while
  unauthenticated it's a 401 from the write gate, worth knowing if anyone
  goes looking for it). Manually verified via the test suite against the
  local docker Postgres (`.env` swapped, `npm run migrate` applied
  `016_drop_email.sql` cleanly, `npm test`, `.env` restored to the Render
  line afterward — same swap-and-restore convention as every prior
  session). `docs/BACKEND_ANALYSIS.md` updated throughout, not just
  §3/§4/§5/§7 as requested — email/register mentions in §1, §2, §6, §8, §9,
  §10, §11, §12 were also stale and would have misled a reader otherwise;
  §11/§12 specifically gained the bootstrapping-gap observation and note
  that the migration-014 placeholder-account concern is now moot (no
  production data survived the wipe).
- **Retired `members`; unified all person-attribution on `users` +
  `colony_memberships`; made colony-admin the only write role app-wide**
  (design/decision doc at the Claude plan path `typed-sparking-fox.md`, not
  copied into `plans/` in-repo for this one): three new migrations.
  `migrations/013_users_name.sql` adds `users.name TEXT NOT NULL`, backfilled
  on existing rows to `COALESCE(email, phone)` (decided over a
  placeholder-and-prompt flow — simpler, needs no client change, and every
  existing row already has at least one of email/phone thanks to migration
  012's own CHECK). `migrations/014_backfill_member_logins.sql` is the
  riskiest part: for every pre-existing `members` row that had no `user_id`
  yet but *was* referenced by `task_assignments`/`availability` (about to
  become `user_id NOT NULL`), it creates a placeholder `users` row via
  `pgcrypto`'s `crypt(gen_random_uuid()::text, gen_salt('bf'))` — an unusable
  random bcrypt-compatible password — keyed on the member's own `phone` if
  present, else a synthesized `legacy-member-<id>@placeholder.invalid` email,
  and links it into that member's colony (if `colony_id` was set). **These
  accounts cannot be logged into until an admin runs the new**
  `POST /colonies/:id/members/:userId/reset-password` — a one-time
  operational follow-up, flagged here rather than solved silently. Known edge
  case, deliberately left to fail loudly: two distinct members needing
  backfill who share the same real phone number (across different colonies)
  would collide on `users`' global phone uniqueness and roll back the whole
  migration — resolution is manual (a DBA decides if they're the same
  person) before re-running `npm run migrate`. `migrations/015_retire_members.sql`
  then repoints `task_assignments.user_id`/`availability.user_id` (NOT NULL,
  renamed from `member_id`) and `donations.collected_by`/`expense_payments.paid_by`
  (nullable, attribution-only, unchanged semantics) at `users` instead of
  `members`, backfilling via each member's `user_id`, and finally
  `DROP TABLE members`. Verified row counts matched before/after and that the
  `NOT NULL` on the first two didn't fire (meaning migration 014 caught every
  referenced row).
  **Endpoints removed entirely**: `POST /members`, `POST /members/bulk`,
  `GET /members`, `GET /members/:id`, `PATCH /members/:id`,
  `POST /members/:id/grant-login`, `POST /members/:id/reset-password`,
  `PATCH /members/:id/colony-role` — `routes/members.js` and
  `services/memberService.js` deleted outright.
  **`POST /colonies/:id/members` is now create-or-link, not add-only**: body
  becomes `{ name, email?, phone?, password?, role? }`, exactly one of
  `email`/`phone` required (same exactly-one-of wording as `/auth/login`). An
  identifier that already resolves to a `users` row is linked as-is
  (`name`/`password` in the body are ignored, never mutating an existing
  account as a side effect); one that doesn't resolve requires
  `name`+`password` to create a fresh account. **No more 404** "no
  registered user with that email" — this was the actual point of the
  change, since login is now mandatory for every colony member and there
  needed to be a single call that either finds or creates that login.
  Response adds `name`/`email`/`phone`/`account` (`'created'`|`'linked'`) to
  the existing `colony_membership_id, colony_id, user_id, role, created_at`
  shape. `POST /colonies/:id/members/bulk` gained the same create-or-link
  logic per row (file columns: `name` required per row even on a linking
  row, `email`/`phone` exactly-one-of, `password` optional falling back to a
  now-optional `initial_password` form field, `role` optional) — this
  absorbs everything `POST /members/bulk` used to do; the old `grant_login`
  column concept is gone entirely since granting a login is no longer
  optional. New `POST /colonies/:id/members/:userId/reset-password`
  (colony-admin of `:id` only, 404 if `:userId` isn't a member, no
  current-password check) replaces the retired
  `POST /members/:id/reset-password`. `GET /colonies/:id/members` response
  gained `name`.
  **`GET /users?search=` gained `name`** to both its response shape and its
  match columns (`name` OR `email` OR `phone`) — it's exactly the "picker"
  the `users.name` column was added for.
  **`POST /auth/register` now requires `name`** alongside `email`/`password`
  (400 if missing) — users no longer have "no display name at all."
  **`task_assignments`/`availability` now key on `user_id`**
  (`{ task_id, user_id }` / `{ user_id, date, is_available }`), and both now
  inline the linked user's display info on every GET
  (`user: { name, email, phone }`) — matches the existing precedent of
  inlining computed fields (`total_donated`, `current_balance`, etc.) rather
  than making the client do a lookup per row. `donations`/`expense_payments`
  inline `collector`/`payer: { user_id, name, email, phone } | null` the
  same way, alongside the raw `collected_by`/`paid_by` id.
  **Authorization — colony-admin is now the only write role, app-wide.**
  Every `assertColonyMember` call across `festivalService`,
  `expectedDonationService`, `expenseService`, `taskService`,
  `taskAssignmentService` became `assertColonyAdmin` — a plain colony member
  can read everything but write nothing beyond what they already could as
  any authenticated user. `assertColonyMember`/`isColonyMember` had no
  remaining callers afterward and were deleted rather than left as dead
  exports.
  **Resolved the open question** (donors / walk-in donations / availability
  were flagged unscoped across three prior sessions): extended the
  admin-only rule to all three, via a new `assertAdminOfAnyColony(userId)`
  gate (true if `role = 'admin'` on *any* `colony_memberships` row) since
  none of them has an FK path to a specific colony. Chosen because the task
  was explicitly "colony-admin the only write role **app-wide**" — leaving
  these three as the sole remaining exceptions would have reproduced the
  exact inconsistency being fixed. Mobile consequence: the Donors screens
  and Walk-in Donation screen need a "current user is admin of ≥1 colony"
  gate, derivable from `GET /colonies/mine` (any `role: "admin"` row) — no
  new endpoint needed.
  **Also resolved, flagged as a real product change, not silently decided**:
  `task_assignments` create/delete now require colony-admin too, same as
  everything else in the app-wide list — meaning **signing up for a task is
  no longer self-service**. An ordinary colony member can no longer add
  themselves to a task; only an admin enrolls volunteers now. Same for
  `availability` (admin-of-any-colony gate) — a plain member can no longer
  record their own yes/no; only an admin can, on anyone's behalf.
  Updated all three test files for the new shapes/gates
  (`test/colonyMembership.test.js`, `test/usersPhoneLogin.test.js` —
  rewritten around the new create-or-link bulk endpoint instead of the
  retired `/members/bulk`, including a new case confirming the same phone in
  a second colony now *links* the existing account instead of erroring,
  `test/bulkImport.test.js`). Fixed one real bug surfaced by the new tests:
  `routes/colonies.js`'s bulk-add handler read `req.body.initial_password`
  unconditionally, which threw (500, not 400) on a request with no body at
  all (e.g. the "missing file" test) — fixed with `req.body?.`. All 16 tests
  pass. Manually verified against the local docker Postgres + running
  server (`.env` swapped, `npm run migrate` applied 013–015 cleanly,
  `npm test`, then a manual pass): colony-member add by phone (new
  account), `GET /colonies/:id/members` showing `name`, admin
  reset-password followed by a successful login with the new password, a
  non-admin blocked (403 "you must be an admin of at least one colony to do
  that") from creating their own availability while the admin succeeded
  with the denormalized `user` object inlined — `.env` restored to the
  Render line afterward.
  `docs/BACKEND_ANALYSIS.md` updated throughout: §1 (domain list/roles/
  relationship diagram), §3 (dropped the `members` entity, updated
  `users`/`colony_memberships`/`donations`/`expense_payments`/
  `task_assignments`/`availability`, resolved the old "explicitly out of
  scope" section), §4 (every endpoint table/body touched above), §5 (the
  app-wide admin-only rule, the any-colony-admin gate, the task-assignment
  self-service change, replacing the retired member-login-granting
  section), §6 (bootstrap/task workflow wording), §7 (new error rows for
  create-or-link validation and the any-colony-admin 403, removed the
  retired grant-login/duplicate-phone rows), §8 (rewrote the Volunteer
  Roster screen as "Volunteer Directory," updated Colony Detail/Festival
  Dashboard/Donors/Pledges/Task Board actions), §9/§10/§11/§12 (resolved
  the long-flagged scoping question, removed now-stale "members" mentions,
  added the placeholder-account follow-up as a new observation/unknown).
- **Phone-based login + bulk-import colony auto-link** (see
  `plans/users-phone-login.md`): `migrations/012_users_phone_login.sql` makes
  `users.email` nullable, adds a nullable `users.phone TEXT` with a **partial**
  unique index `users_phone_unique ON users (phone) WHERE phone IS NOT NULL`,
  and a `CHECK (email IS NOT NULL OR phone IS NOT NULL)` — a login identity
  needs at least one identifier. No-op backfill (every existing row already
  has `email`, none have `phone`).
  **`POST /auth/login`** now accepts `{email, password}` OR `{phone,
  password}` — 400 if neither given, 400 if both given ("provide either
  email or phone, not both"), same ambiguous `"invalid credentials"` 401 for
  wrong-password/unknown-identifier either way (unchanged reasoning — don't
  leak which emails/phones exist). JWT payload is now `{user_id, email,
  phone}` (whichever wasn't used to log in comes back `null`).
  `POST /auth/register` is **unchanged** — email+password only, confirmed
  out of scope; phone-based accounts are only ever created via bulk-import.
  **`POST /members/bulk`** gains a new optional per-row `grant_login` column
  (truthy: `yes`/`true`/`1`, case-insensitive). Existing `email`-column
  behavior is byte-for-byte unchanged (a non-empty `email` still grants a
  login via email). New: `email` empty + `grant_login` truthy grants a login
  keyed on that row's own `phone` instead, using the row's `password` column
  or the batch's `initial_password` (same fallback already used for email).
  `email` empty + `grant_login` falsy is unchanged (plain roster row, no
  login — the common "volunteer" case).
  **The actual bug being fixed**: whichever path now grants a login (email
  *or* phone) also inserts a `colony_memberships` row for that user, scoped
  to the batch's `colony_id`, role `'member'`, in the same per-row atomic
  transaction (`ON CONFLICT (colony_id, user_id) DO NOTHING` — defensive,
  not expected to fire for a freshly-created login). Previously, a bulk-
  imported member granted a login via `email` never got colony access at
  all — they wouldn't show up under `/colonies/mine` for their own colony
  until an admin separately ran `PATCH /members/:id/colony-role`.
  New row-level error case: the row's `phone` already backs another user's
  login account (global unique violation on `users.phone`, distinct from
  the existing per-colony `members.phone` dedup which still lands in
  `skipped`) → `errors` entry, `"phone already registered for login"`.
  **Not shared, confirmed and left alone**: `bulkImportMembers` and
  `grantLogin` (the single `POST /members/:id/grant-login` endpoint) were
  already two separate inline `INSERT INTO users` blocks, not a shared
  helper — so per explicit instruction, phone-login-granting was added only
  to the bulk path. `POST /members/:id/grant-login` is unchanged (still
  email+password only, no colony auto-link). Flagging this as an
  inconsistency for later, not fixing it now.
  **`GET /users?search=`** now matches partial against `email` OR `phone`
  (was email-only); response shape is now `[{user_id, email, phone}]` (was
  `[{user_id, email}]`) — still auth-required, still never `password_hash`.
  New `test/usersPhoneLogin.test.js` (7 cases): phone-login success + wrong
  password, both-identifiers-400, neither-identifier-400, email-path bulk
  import now auto-links colony membership (regression coverage for the bug
  fix), `grant_login=false` with no email still grants nothing, phone
  already registered for login (cross-colony — same phone in two different
  colonies' rosters, since `members.phone` uniqueness is per-colony but
  `users.phone` is global, so a same-colony duplicate phone hits the
  existing `members_colony_id_phone_unique` check first and lands in
  `skipped`, not `errors`), and `/users?search=` matching by phone. All 17
  tests pass (10 pre-existing across the other two suites + these 7 new
  ones), verified against the local docker Postgres (`.env` swapped, `npm run
  migrate` applied `012_users_phone_login.sql` cleanly, `npm test`, `.env`
  restored to the Render line afterward — same swap-and-restore convention
  as every prior session). `docs/BACKEND_ANALYSIS.md` updated: §3 `users`
  entity, §4 Auth/Users/Members endpoint tables and bodies, §5
  authorization, §7 error table.
- **Bulk-add colony members + bulk-import donors** (see
  `plans/colonies-donors-bulk-import.md`): two new file-driven bulk-write
  endpoints, reusing `/members/bulk`'s existing infrastructure rather than
  inventing a second CSV/XLSX parser. Extracted `parseRoster`/`parseCsv`/
  `parseXlsx`/`normalizeHeader` out of `services/memberService.js` into a new
  `services/rosterParser.js` (avoids a circular import, since
  `colonyMembershipService.js` needed the parser too and `memberService.js`
  already imports *from* `colonyMembershipService.js`); `memberService.js`'s
  own behavior is unchanged, just re-pointed at the shared module.
  - **`POST /colonies/:id/members/bulk`** (new route on `routes/colonies.js`,
    same inline multer-wrapping pattern as `/members/bulk`): admin-of-`:id`
    is asserted **once** for the whole request, not per row (per explicit
    instruction — same convention `/members/bulk` already uses for its
    `colony_id` admin check). Refactored `colonyMembershipService.addMember`
    into a shared `insertMembership(colonyId, {email, role})` helper (does
    the validation/lookup/insert/409-translation, no auth check of its own)
    so `addMember` = assert-admin + `insertMembership`, and the new
    `bulkAddMembers` = assert-admin-once + `insertMembership` per row — no
    duplicated validation logic between single and bulk. File columns:
    `email` (required per row), `role` (optional, defaults `'member'`, must
    be `'admin'`/`'member'` if given). Row outcomes map 1:1 onto single-add's
    existing status codes: no registered user with that email (404 case) →
    `errors`; already a member of this colony (409 case) → `skipped` (benign,
    same treatment as a duplicate phone in `/members/bulk`); bad role →
    `errors`. `created` row shape is exactly `insertMembership`'s return
    (`colony_membership_id, colony_id, user_id, role, created_at` — no
    `email` field, since the single-add endpoint's response doesn't have one
    either) plus `row`. Top-level 400 if no file; existing `getColony`
    404 and `assertColonyAdmin` 403 reused unchanged.
  - **`POST /donors/bulk`** (new route on `routes/donors.js`, same multer
    pattern): no colony scoping, same auth as single `POST /donors` (any
    authenticated user). File columns: `name` (required per row), `phone`
    (optional). Donors have no uniqueness constraint at all (unlike Members'
    colony-scoped phone uniqueness) — deliberately did **not** invent a dedup
    rule, per explicit instruction. Every row with a name lands in `created`;
    missing name → `errors`. Response keeps the `{ created, skipped, errors }`
    three-key shape for client-parser consistency with `/members/bulk`, but
    `skipped` is always `[]` since there's no duplicate case to detect.
    `created` row shape: `{ row, donor_id, name, phone }`.
  New `test/bulkImport.test.js` (own register/login/colony helpers, same
  supertest-against-real-Postgres style as `test/colonyMembership.test.js`):
  colony bulk-add covering created/skipped(already-member)/errors(unregistered
  email, bad role)/403(non-admin)/400(no file) in one mixed-file request;
  donor bulk-import covering created/error(missing name)/no-dedup (same
  name+phone twice, both created). All 11 tests (9 pre-existing + 2 new) pass.
  Manually verified via the test suite only (no separate manual Postman pass
  requested) against the local docker Postgres (`.env` swapped to the
  commented-out local line, `npm run migrate` — no new migrations needed,
  schema unchanged — then `npm test`, then `.env` restored to the Render
  line afterward, same swap-and-restore convention as every prior session).
  `docs/BACKEND_ANALYSIS.md` updated: §4 Colonies and Donors endpoint tables
  and bodies, §8 Colony Detail/Members and Donors Directory screens' Actions.
- **Search filters on list/GET endpoints + new user directory** (audit
  requested by user, no plan file — small, additive, no schema change):
  added `?search=` to four existing list endpoints and one brand-new
  endpoint, all case-insensitive partial match via `ILIKE '%term%'`, all
  purely additive on top of the existing full-list-no-pagination design
  (omit `search` and behavior is byte-for-byte unchanged). No auth/response
  shape changes on any touched endpoint except the new `GET /users`.
  - **`GET /users?search=`** (new route + new `services/userService.js`):
    there was no user directory at all before this — the only way to add
    someone to a colony was `POST /colonies/:id/members` with their exact
    email (404 if it didn't match). Matches partial, case-insensitive
    against `email` only — **`users` has no name column**
    (`migrations/008_users.sql`: just `user_id`/`email`/`password_hash`/
    `created_at`), so despite the request mentioning "name field on users,
    if one exists," there isn't one; documented here instead of forcing a
    match against a nonexistent field. Returns only `user_id` and `email`
    (no `password_hash`). `requireAuth`-gated on the GET, same as
    `GET /colonies/mine` and `GET /colonies/:id/members` — same reasoning
    (a public user-search-by-email endpoint is an email enumeration risk).
    No query param at all still returns the full directory (same
    always-a-list convention as every other GET in this app).
  - **`GET /donors?search=`**: matches partial `name` OR `phone`. No auth
    change (donors reads were already public, still are).
  - **`GET /members?search=`**: matches partial `name` OR `phone`,
    combinable with the existing `?colony_id=` filter (both apply as AND
    when both given). No auth change.
  - **`GET /colonies?search=`**: matches partial `name` OR `location`. No
    auth change (this is the plain `GET /colonies` list, unrelated to the
    already-`requireAuth`'d `GET /colonies/mine`/`GET /colonies/:id/members`
    — those two were deliberately left untouched, per explicit instruction).
  Manually verified against the docker Postgres + running server: `GET
  /users` with no token (401); with a token, `?search=` matching one
  registered email, a no-match search (empty array), and no param (full
  list, minimal fields only); `GET /donors?search=` matching by partial
  name and by partial phone digits; `GET /colonies?search=` matching by
  partial name and by a location string with a space; `GET /members?search=`
  matching two same-named members in different colonies, then combined with
  `?colony_id=` to confirm it narrows to just the one in-colony match and
  excludes the other colony's same-named member. All 9 pre-existing tests
  in `test/colonyMembership.test.js` still pass unchanged.
  **For the mobile client / `docs/BACKEND_ANALYSIS.md`**: these are the
  exact new/changed endpoints — `GET /users?search=` (new, auth required,
  returns `[{user_id, email}]`), `GET /donors?search=`, `GET
  /members?search=` (combinable with existing `?colony_id=`), `GET
  /colonies?search=`. No endpoint's authorization, response shape, or
  pagination behavior changed otherwise.
- **Member bulk import + login granting/promotion** (see
  `plans/members-bulk-import-login.md`): `migrations/011_members_login_link.sql`
  adds `members.user_id INTEGER UNIQUE REFERENCES users(user_id)`, nullable —
  a member optionally links to a login account; the UNIQUE direction means a
  `users` row backs at most one `members` row. `users` itself is unchanged.
  New in `services/memberService.js`: `bulkImportMembers`, `grantLogin`,
  `resetPassword`, `setColonyRole`, plus an internal `parseRoster` that
  dispatches to `csv-parse` (`.csv`) or `exceljs` (`.xlsx`/`.xls`) by file
  extension. New in `services/authService.js`: `changePassword`. New routes:
  `POST /members/bulk` (multipart, `multer` memory storage, 5MB cap),
  `POST /members/:id/grant-login`, `POST /members/:id/reset-password`,
  `PATCH /members/:id/colony-role`, `PATCH /auth/change-password`.
  **Password strategy, confirmed with user**: organizer-supplied shared
  password per bulk-import call (`initial_password`, required), not
  system-generated — "nothing secret between members of the same colony."
  A per-row `password` column in the file overrides the shared one for that
  person only. No forced password-change flag (would undercut the point);
  `PATCH /auth/change-password` exists as a self-service escape hatch for
  anyone who later wants a private password.
  **Row processing**: independent across rows (no whole-file transaction, so
  one bad row doesn't fail the batch), but each row's member-insert +
  optional login-grant is atomic *together* (its own BEGIN/COMMIT/ROLLBACK,
  mirroring `colonyService.createColony`'s existing transaction precedent) —
  avoids a row leaving a member with no login when the file said it should
  have one, or a dangling `users` row nothing points at.
  **Duplicate-phone handling, explicitly flagged and resolved**: dedup is
  scoped **per-colony only**, reusing the existing partial unique index
  (`members_colony_id_phone_unique` from migration 010) — a dup is `skipped`
  and reported, the existing row is untouched. Deliberately **not** extended
  to check collisions against legacy *unscoped* (`colony_id IS NULL`) member
  rows: migration 010 already settled "phone uniqueness is per-colony, not
  global" for exactly this reason (no cross-colony row-ownership model exists
  anywhere else in this app), and `POST /members` itself has never checked
  against unscoped rows either — a one-off global check just for bulk-import
  would be inconsistent and would silently drop legitimate new roster rows
  because of old data the organizer can't see.
  Response shape: `{ created: [...], skipped: [...], errors: [...] }`, each
  entry carrying `row` (1-based, data rows only), `phone`, and (for
  created rows) `member_id`/`login_granted`/`email`, or (for skipped/error
  rows) a `reason` string. `errors` covers everything row-level that isn't
  the duplicate-phone case: missing `name`/`phone`, an `email` already
  registered (whether against an existing account or a duplicate within the
  same file — both surface as `"email already registered"`, disambiguated
  internally by Postgres's `err.constraint`: `members_colony_id_phone_unique`
  → skipped, `users_email_key` → error).
  **Authorization**: `POST /members/bulk` is always colony-scoped and
  colony-admin-only (no null-skip convention — a bulk roster upload is
  inherently "the organizer's colony," unlike `POST /members`'s optional
  `colony_id`). `grant-login`/`reset-password` reuse `createMember`'s
  existing convention instead of inventing a new rule: colony-admin required
  if the target member has a `colony_id`, any authenticated user if it's a
  legacy unscoped row. `PATCH /members/:id/colony-role` does no
  authorization of its own — 404 via `getMember`, 400 if `member.user_id`
  is null, then delegates entirely to the existing
  `colonyMembershipService.addMember` (first grant, looked up by email
  resolved from the member's linked `user_id`) or `updateMemberRole` (role
  already exists, called directly with the `user_id`) — both already
  `assertColonyAdmin` and already have the sole-admin-can't-be-demoted guard,
  so nothing needed re-implementing.
  **Dependency note**: `xlsx` (SheetJS)'s npm-published build (0.18.5, the
  last version ever published there) has two unpatched advisories
  (prototype pollution, ReDoS), "no fix available" per `npm audit" — since
  this endpoint parses untrusted uploaded files, used `exceljs` instead (one
  low-relevance transitive moderate advisory on `uuid`, unrelated code path)
  plus `csv-parse` for `.csv`. New deps: `multer`, `exceljs`, `csv-parse`.
  Manually verified against the docker Postgres + running server: CSV bulk
  import (valid row with shared password, valid row with per-row password
  override, no-login row, missing-name row → error, duplicate-phone row →
  skipped) and an equivalent XLSX file parsed correctly; shared-password
  login succeeded, per-row-override password succeeded and the shared
  password correctly failed for that row; `grant-login` on an existing
  no-login member (201) → duplicate grant-login (409) → grant-login with an
  already-taken email (409); `reset-password` (200, confirmed new password
  logs in) → on a no-login member (400); `colony-role` promote (addMember
  path, 200) → repeat call on the same membership (updateMemberRole path,
  200) → on a no-`user_id` member (400) → as a non-admin (403); bulk-import
  with a bad `colony_id` (400), as a non-admin (403), with no file (400);
  `change-password` wrong current password (401), correct change (204,
  confirmed new password logs in). All 9 pre-existing tests in
  `test/colonyMembership.test.js` still pass unchanged.
  `docs/BACKEND_ANALYSIS.md` updated (§3 entities, §4 endpoint tables, §5
  authorization, §7 error table) to describe these endpoints for the mobile
  client, which treats that doc as authoritative.
- **Optional colony-scoping for `members`** (see
  `plans/members-colony-scoping.md`): `migrations/010_members_colony_scoping.sql`
  adds a nullable `colony_id INTEGER REFERENCES colony(colony_id)` to `members`
  (plain FK, no `ON DELETE` — matches every other FK in this schema, none of
  which has one) plus a **partial** unique index `(colony_id, phone) WHERE
  colony_id IS NOT NULL`. `colony_memberships`/`users`/auth flow untouched, as
  requested — this only touches `members`.
  `memberService.createMember` now takes `actingUserId` and an optional
  `colony_id` in the body: omit it and behavior is byte-for-byte unchanged
  (any authenticated user, unscoped row); provide it and the caller must be a
  **colony admin** (`assertColonyAdmin`), mirroring `festivalService
  .createFestival`'s null-skip convention (`colonyExists` check first, skip
  the assert and let the FK violation 400 through if the id doesn't resolve).
  409 on duplicate `(colony_id, phone)` (same catch-and-translate pattern as
  `colonyMembershipService.addMember`). `listMembers` gained an optional
  `?colony_id=` filter (same shape as `listFestivals`). `updateMember`/PATCH
  is **unchanged** — still only touches `name`/`phone`, still any
  authenticated user, `colony_id` is immutable after creation (deliberate,
  documented — no precedent anywhere in the app for re-parenting a row to a
  different colony after creation).
  **Design decision (asked to be made and documented, not silently picked):
  phone uniqueness is per-colony, not global** — same phone number can appear
  in multiple different colonies' rosters as distinct rows; only a duplicate
  *within the same colony's roster* is rejected (409). Chosen because
  `members` had zero uniqueness constraint before this, and global uniqueness
  would have forced a cross-colony row-ownership model (reuse-or-fail) that
  doesn't exist anywhere else in this app's flat `members`/`donors` concept.
  `docs/BACKEND_ANALYSIS.md` updated throughout (§3 entity/relationship/
  scoping-exceptions, §4 Members table, §5 authorization, §11 observations,
  §12 unknowns) to reflect exactly this, including the immutable-`colony_id`
  and any-user-can-PATCH deviations from a "full" scoping model.
  Manually verified against the docker Postgres + running server: unscoped
  create by a non-admin (201, unchanged), non-admin scoped create (403),
  colony-admin scoped create (201), duplicate phone same colony (409), same
  phone different colony (201, distinct row), bad `colony_id` (400, FK
  violation path), `GET /members?colony_id=` filter, and PATCH with a
  `colony_id` in the body confirmed ignored (row's `colony_id` unchanged,
  `name` still updates).
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
