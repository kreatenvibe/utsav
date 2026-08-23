# Plan: Colony membership / write-permission model

## Context
Audited the codebase and confirmed: `requireAuth` only verifies a JWT and attaches
`req.user`, but nothing ever reads `req.user` again — any authenticated user can
write to any colony's data (see audit findings, not repeated here). This adds a real
membership model, modeled on a WhatsApp group: creating a colony makes you its first
admin; admins add/remove other registered users; only members (admin or plain) can
write data scoped under their colony; all reads stay public and unchanged.

## Decisions
- **New table `colony_memberships`**, not `colony_members` — avoids confusion with
  the existing unrelated `members` table (festival volunteers/organizers, a global
  roster with no `colony_id`, separate from login identity in `users`).
- **`actingUserId` threaded as a plain second parameter** on every mutating service
  function (`fn(body, actingUserId)`), never merged into the destructured body
  object — keeps it visually obvious at each call site that identity comes from the
  verified JWT, not attacker-controlled `req.body`. Rejected a per-route
  `requireColonyMember(resolverFn)` middleware: `plans/auth.md` chose one global
  auth middleware specifically to keep routes thin; resolving an FK chain to a
  colony_id is business logic (CLAUDE.md: business logic lives in services), and
  update/delete paths already have the resolved row in hand inside the service from
  the existing `getX(id)` call — a middleware would force a duplicate fetch.
- **Null-skip only on create paths.** Create takes a raw parent id from the request
  body before any row is fetched — if that id doesn't resolve to a colony, the
  membership check is skipped and the existing FK-violation catch (`23503` → 400)
  fires exactly as it does today. Update/delete paths already call `getX(id)` first
  (404s if missing), so their FK column is guaranteed valid by the time membership
  is checked — no skip logic needed there. Not an information leak: every GET in
  this app is already fully public, so a 400-vs-403 distinction on a write reveals
  nothing a non-member couldn't already read directly.
- **Colony rename (`PATCH /colonies/:id`) is admin-only** (confirmed with user) —
  treated like a WhatsApp group's settings, not like regular colony-scoped content.
- **Membership management is split POST (create-only) / PATCH (role change) /
  DELETE**, not an upsert — matches this codebase's existing strict
  create-vs-update convention (no `ON CONFLICT` anywhere else); `POST` catches
  unique-violation `23505` → 409, same pattern as `authService.registerUser`'s
  duplicate-email handling.
- **Invite by email of an already-registered user** — 404 if no such user exists.
  No invitation-email system; out of scope.
- **`GET /colonies/:id/members` requires auth** (the one read this feature gates) —
  membership rows expose other users' emails, more sensitive than the fully-public
  donation/expense/task data already exposed today.
- **Left deliberately unscoped** (flagged, not silently decided):
  - Walk-in donations (`donations.expected_id IS NULL`) — no festival/colony link
    in the schema.
  - `availability` — no `festival_id`/`colony_id` column at all; would need a
    schema change beyond "add a membership model."
  - `members` (volunteers) and `donors` — global rosters, no `colony_id` column.
  - Self-removal ("leave a colony") — only admins can remove members; a member
    can't remove themselves. Easy follow-up if wanted later.

## Changes

**`migrations/009_colony_memberships.sql`** (new)
```sql
CREATE TABLE colony_memberships (
  colony_membership_id SERIAL PRIMARY KEY,
  colony_id INTEGER NOT NULL REFERENCES colony(colony_id),
  user_id INTEGER NOT NULL REFERENCES users(user_id),
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (colony_id, user_id)
);
```

**`services/colonyMembershipService.js`** (new) — `isColonyMember`, `isColonyAdmin`,
`assertColonyMember`/`assertColonyAdmin` (403), `colonyExists` (for `createFestival`'s
raw `colony_id`), `colonyIdForFestival`/`colonyIdForExpense`/`colonyIdForTask`/
`colonyIdForExpectedDonation` resolvers (`null` if the id doesn't resolve),
`listMyColonies`, `listColonyMembers`, `addMember` (409 on dup), `updateMemberRole`
(sole-admin-demotion guard), `removeMember` (sole-admin guard, 404 if no membership).

**`services/colonyService.js`** — `createColony` wraps the colony insert + admin
membership insert in one transaction (`pool.connect()`/BEGIN/COMMIT, mirrors
`db/migrate.js`'s only existing transaction precedent; validation runs before
`BEGIN`). `updateColony` gains `assertColonyAdmin`.

**`routes/colonies.js`** — thread `req.user.user_id` into `createColony`/
`updateColony`; add `GET /mine` (registered before `GET /:id`), `GET /:id/members`,
`POST /:id/members`, `PATCH /:id/members/:userId`, `DELETE /:id/members/:userId`.

**`services/festivalService.js`, `expectedDonationService.js`, `expenseService.js`,
`taskService.js`, `expensePaymentService.js`, `taskAssignmentService.js`,
`donationService.js`** — every create/update/delete gains `actingUserId` and a
membership assert resolved per the rules above. Matching route files thread
`req.user.user_id` through.

**`app.js`** (new) — Express app construction moved out of `index.js`; exports
`app`, no `.listen()`. **`index.js`** shrinks to importing `app` and calling
`.listen()`. Needed so tests can drive the app in-process without binding a port.

**`package.json`** — add `supertest` devDependency; `"test": "node --test"`.

**`test/colonyMembership.test.js`** (new) — runs against the real docker Postgres
(`DATABASE_URL`), no mocking, matching this repo's existing manual-verification
philosophy. Registers real users, creates real colonies/festivals, cleans up exact
captured ids in `after()` (FK-safe order). Covers: colony creation auto-admins the
creator; non-member blocked (403) writing under someone else's colony; admin adds a
plain member who can then write; non-admin blocked (403) managing membership;
demoting/removing the sole admin rejected (400); unauthenticated write still 401;
public GET still unauthenticated.

## Verification
- `npm run migrate` applies `009_colony_memberships.sql` against the docker Postgres.
- `npm test` runs the new suite against the same DB.
- Manual pass via running server: register 2 users, create colony as A, confirm
  `GET /colonies/mine` shows `role: admin`; B gets 403 creating a festival under it;
  A adds B as member; B's festival create then succeeds; removing A (sole admin)
  rejected with 400.

## After implementation
Update `PROGRESS.md` (Done section + plan reference + testing prerequisites), same
as prior features.
