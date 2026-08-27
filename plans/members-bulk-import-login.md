# Plan: Member bulk import + login granting/promotion

## Context
Follow-up to `plans/members-colony-scoping.md` and `plans/colony-membership.md`.
Real-world usage: most colony work is done by people who either already have a
`users` login or never will (hired staff, occasional volunteers). Today a
`members` row has no relationship to `users` at all, so an organizer can't
grant login capability to an existing roster entry, can't bulk-create a
roster from a spreadsheet, and can't promote a roster entry to colony
admin/member — only `colonyMembershipService` (keyed by `user_id`) can do
that. This adds the missing link and the endpoints around it. Full design
discussion (schema options, password-strategy tradeoffs) happened in
conversation before this plan; only the decisions are recorded here.

## Decisions

- **`members.user_id` (nullable, UNIQUE, FK → `users`)**, not a merge of the
  two tables. `members` stays the single "person who can be assigned work"
  identity (FK target for `task_assignments`/`availability`/`collected_by`/
  `paid_by`); `users` stays purely "has app credentials." A member optionally
  has a login; a login always traces back to exactly one member row (UNIQUE
  enforces that direction). No `ON DELETE` — matches every other FK in this
  schema.
- **Shared/organizer-supplied password, not system-generated.** Confirmed
  with user: colony members don't need individually-secret passwords: the
  organizer sets one `initial_password` per bulk-import call (applies to
  every row in that batch that requests login), with an optional per-row
  `password` column in the file to override it for a specific person. No
  `must_change_password` flag — forcing a change would undercut the point.
  `PATCH /auth/change-password` still exists as a self-service escape hatch
  for the rare member who wants a private password later.
- **Row processing is independent across rows (no whole-file transaction),
  but each row's member-insert + optional login-grant is atomic together**
  (own `BEGIN`/`COMMIT`/`ROLLBACK` per row, mirroring `colonyService
  .createColony`'s existing transaction precedent). Rationale: "no wrapping
  transaction" means the file isn't all-or-nothing, but a single row
  shouldn't be able to leave a member created with no login when the
  organizer's file said it should have one (or a dangling `users` row with no
  member pointing at it) — that's a worse partial state than either "row
  fully in" or "row fully out."
- **Duplicate-phone dedup scope: per-colony only, matching the existing
  partial unique index — not extended to check unscoped legacy rows.**
  (Flagged for a decision; resolved here.) `members_colony_id_phone_unique`
  is `UNIQUE (colony_id, phone) WHERE colony_id IS NOT NULL` (migration 010).
  Bulk import always sets `colony_id` (mandatory param), so a dup within the
  target colony's existing roster is caught by that index exactly like
  `POST /members` already relies on today. Deliberately **not** additionally
  checking whether the phone exists on some unrelated *unscoped*
  (`colony_id IS NULL`) legacy row: migration 010 already settled "phone
  uniqueness is per-colony, not global" specifically because global
  uniqueness would force a cross-colony row-ownership model that doesn't
  exist anywhere in this app's flat `members` concept. Adding a one-off
  global check just for bulk-import would silently skip legitimate new
  roster rows because of old, unrelated data the organizer has no visibility
  into, and would make bulk-import's conflict rule inconsistent with
  `POST /members`'s own (unchanged) behavior. If this turns out to be wrong
  in practice, revisit — but it's the behavior consistent with existing code.
- **`errors` vs `skipped`**: `skipped` is specifically the duplicate-phone
  case (not the caller's fault, existing data). Everything else row-level
  (missing `name`/`phone`, an `email` already registered — whether against an
  existing user or a duplicate within the same file) is an `errors` entry.
- **Bulk import is always colony-scoped and admin-gated** — no null-skip
  convention here (unlike `POST /members`'s optional-`colony_id` behavior).
  A bulk roster upload is inherently "the organizer's colony roster," so
  `colony_id` is required and `assertColonyAdmin` always runs.
- **`grant-login`/`reset-password` on an existing member row**: gated the
  same way single-member create already is (`memberService.createMember`'s
  existing convention) — if the target member has a `colony_id`, caller must
  be that colony's admin (`assertColonyAdmin`); if the member is one of the
  legacy unscoped rows (`colony_id IS NULL`), any authenticated user may act,
  same as every other unscoped-member operation today. Not explicitly spelled
  out in the request spec; applying the existing precedent rather than
  inventing a new rule.
- **`PATCH /members/:id/colony-role` delegates entirely to
  `colonyMembershipService.addMember`/`updateMemberRole`** rather than
  re-implementing admin-checks or the sole-admin guard — those functions
  already call `assertColonyAdmin` internally and already have the guard.
  This function's only job is: 404 via `getMember`, 400 if `member.user_id`
  is null, then look up whether a `colony_memberships` row already exists
  (`isColonyMember`) to decide `addMember` (needs an email — fetched from
  `users` by the member's linked `user_id`) vs `updateMemberRole` (takes the
  `user_id` directly, no email lookup needed).
- **File parsing libraries**: `xlsx` (SheetJS)'s npm-published build (0.18.5,
  the last version ever published there) has two unpatched advisories
  (prototype pollution, ReDoS — GHSA-4r6h-8v6p-xvw6, GHSA-5pgg-2g8v-p4x9),
  "no fix available." Since this endpoint parses untrusted uploaded files,
  used `exceljs` for `.xlsx` instead (no such advisories; one moderate,
  low-relevance transitive `uuid` advisory from `npm audit`, unrelated code
  path) and `csv-parse` for `.csv`. Neither existed in `package.json` before;
  both added as new dependencies, along with `multer` (memory storage, 5MB
  cap) for the multipart upload itself.

## Changes

**`migrations/011_members_login_link.sql`** (new)
```sql
ALTER TABLE members ADD COLUMN user_id INTEGER UNIQUE REFERENCES users(user_id);
```

**`services/memberService.js`** — add `parseRoster` (internal, dispatches to
csv-parse or exceljs by file extension), `bulkImportMembers`, `grantLogin`,
`resetPassword`, `setColonyRole`. Imports `bcryptjs` directly (same
`SALT_ROUNDS = 10` convention as `authService.js` — no shared helper exists
between services for this today, so not inventing one here either).

**`routes/members.js`** — `POST /members/bulk` (multer middleware +
handler), `POST /members/:id/grant-login`, `POST /members/:id/reset-password`,
`PATCH /members/:id/colony-role`.

**`routes/auth.js`** — `PATCH /auth/change-password`.

**`services/authService.js`** — add `changePassword(userId, { current_password, new_password })`.

**`package.json`** — add `multer`, `exceljs`, `csv-parse`.

## Verification
- `npm run migrate` against the docker Postgres (same swap-`.env` procedure
  as prior features).
- Manual pass via running server: bulk-import a small CSV (mix of valid rows,
  one duplicate phone, one missing name) and an XLSX equivalent; confirm
  `created`/`skipped`/`errors` shapes; confirm a `created` row with `email`
  can then log in with the shared password; grant-login/reset-password on an
  existing member; promote via `colony-role` then confirm the promoted
  user's write access; demote; attempt promote on a member with no
  `user_id` (400); attempt as a non-admin (403); attempt bulk-import with a
  bad `colony_id` (400) and as a non-admin (403).

## After implementation
Update `PROGRESS.md` (Done section + lessons) and `docs/BACKEND_ANALYSIS.md`
(the mobile client's source-of-truth doc) — new entities/endpoints/error
table rows, matching how prior features updated both.
