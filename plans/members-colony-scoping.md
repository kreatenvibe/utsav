# Plan: Optional colony-scoping for `members`

## Context
`members` is today a flat, unscoped directory (`member_id`, `name`, `phone`) —
any authenticated user can write to it, no `colony_id`, no relation to
`colonies`. This adds an *optional* `colony_id` so a colony admin can build a
private roster, while leaving existing unscoped behavior fully intact for
`colony_id: null` rows. Confirmed against the actual code (not just the task
description) before writing this:
- `routes/members.js` + `services/memberService.js` — matches description
  exactly: POST/GET/GET:id/PATCH, no colony_id anywhere, no auth check beyond
  the app-wide `requireAuth` gate on writes.
- `services/colonyMembershipService.js` — `assertColonyAdmin`/`assertColonyMember`
  pattern confirmed, used as designed.
- `colony_memberships` (users ↔ colonies, role) is untouched by this plan, as
  instructed.
- No partial/in-progress colony-scoping of `members` exists anywhere (no stray
  column, no TODO, no half-applied migration) — clean slate, per PROGRESS.md
  and BACKEND_ANALYSIS.md §3/§12 which both explicitly list `members` as
  currently, deliberately unscoped.

**One drift from the task description worth flagging:** the description says
to check "how other nullable colony FKs are handled, e.g. on
`expenses`/`tasks`." Neither table actually has a `colony_id` column — both
have `festival_id`, and colony is resolved by joining through `festival`
(`colonyIdForExpense`/`colonyIdForTask` in `colonyMembershipService.js`). So
there's no existing *nullable colony_id* FK anywhere in the schema to copy.
Going with what the code actually does instead: every nullable FK in this
schema (`donations.expected_id`, `donations.collected_by`,
`expense_payments.paid_by`) is a plain `INTEGER REFERENCES table(pk)` with
**no `ON DELETE` clause** — the whole schema has zero `ON DELETE` clauses
anywhere (default `NO ACTION`/`RESTRICT`). `members.colony_id` will follow
that same plain-FK convention.

## Design decision: phone uniqueness (open question from the task)

**Chosen: per-colony uniqueness**, not global.

- `UNIQUE (colony_id, phone)` as a **partial** index —
  `WHERE colony_id IS NOT NULL` — so it only applies to colony-scoped rows.
- Unscoped rows (`colony_id IS NULL`, i.e. all existing rows and any future
  global add) get **no uniqueness enforcement at all** — identical to
  today's behavior, zero behavior change for the existing directory.
- The same phone number **can** appear in multiple different colonies'
  rosters as distinct rows (a volunteer helping two neighboring colonies'
  festivals is a real scenario, not an edge case to design against).
- Adding the **same phone twice to the same colony's roster** is treated as
  a genuine duplicate-entry mistake and rejected.

**Reasoning:** `members` today has *no* uniqueness constraint on `phone` at
all — not even a soft one. Global uniqueness would be a bigger behavior
change than asked for (it would mean the second colony to add a known
volunteer either fails outright or has to silently adopt/reuse a row it
doesn't administer — a cross-colony row-ownership model this app's flat,
non-relational `members`/`donors` concept doesn't have anywhere else).
Per-colony uniqueness is the smaller, additive change: it fixes the actual
data-quality problem (accidental double-entry within one roster) without
inventing new cross-colony semantics.

**Failure mode:** inserting a duplicate `(colony_id, phone)` → Postgres
`23505` → caught and translated to **409**, same pattern already used for
`colony_memberships` duplicates (`colonyMembershipService.addMember`) and
`users.email` duplicates (`authService.registerUser`). No dedup/reuse logic.

## Changes

**`migrations/010_members_colony_scoping.sql`** (new)
```sql
ALTER TABLE members ADD COLUMN colony_id INTEGER REFERENCES colony(colony_id);

CREATE UNIQUE INDEX members_colony_id_phone_unique
  ON members (colony_id, phone)
  WHERE colony_id IS NOT NULL;
```
Existing rows get `colony_id = NULL` automatically (nullable column add).

**`services/memberService.js`**
- `createMember({ name, phone, colony_id }, actingUserId)`:
  - `name` required (unchanged).
  - If `colony_id` provided: mirror `festivalService.createFestival`'s
    null-skip convention — `if (await colonyExists(colony_id)) await
    assertColonyAdmin(actingUserId, colony_id)`. If `colony_id` doesn't
    resolve, skip the check and let the INSERT's FK violation produce the
    existing 400 pattern. If omitted, behavior is byte-for-byte identical to
    today (any authenticated user, unscoped row).
  - Catch `23503` → 400 "colony_id does not reference an existing colony"
    (matches `festivalService`/others). Catch `23505` → 409 "a member with
    that phone already exists in this colony" (matches `addMember`'s
    pattern).
- `listMembers({ colony_id })`: optional filter, `WHERE colony_id = $1` when
  provided, unfiltered (all rows, any colony or none) otherwise — matches
  `listFestivals`'s optional-filter shape exactly. No existence validation on
  the filter value, same as `listFestivals`.
- `updateMember`: **`colony_id` stays immutable after creation** — out of
  scope for now, not silently dropped. Reasoning: a "move a member between
  colonies" operation raises its own question (admin of source, destination,
  or both?) that isn't asked for here and has no precedent elsewhere in the
  app (nothing else supports re-parenting a row to a different colony after
  creation). `updateMember` continues to only accept `name`/`phone`, and
  keeps today's "any authenticated user" gate — deliberately *not* gated by
  colony-admin, since it can't change colony scoping and PATCH on an
  already-unscoped row shouldn't suddenly require new privilege just because
  the feature shipped elsewhere in the table. This will be stated explicitly
  in `BACKEND_ANALYSIS.md`, not left implicit.

**`routes/members.js`**
- `POST /` passes `req.user.user_id` through to `createMember` (same shape as
  `routes/festivals.js`).
- `GET /` reads `req.query.colony_id` and passes it through to `listMembers`.
- `GET /:id`, `PATCH /:id` unchanged (PATCH still doesn't touch colony_id).

**`docs/BACKEND_ANALYSIS.md`** — updates only, no new sections:
- §3 `members` entity description: add `colony_id` (nullable FK, optional),
  note the per-colony phone-uniqueness partial index and its 409 failure
  mode.
- §3 relationship overview: add `colony ──0:N──▶ members (optional)`.
- §3 "Explicitly out of scope / unscoped by design": remove `members` from
  the always-unscoped list, replace with a note that it's now *optionally*
  scoped (NULL colony_id = still fully unscoped, matching today).
- §4 Members table: document the new `colony_id` body field, the two auth
  tiers (admin-only when scoping, any-authenticated-user when not), the
  `?colony_id=` filter, and that PATCH cannot change `colony_id`.
- §5 Authorization paragraph: mention `members` now has conditional
  colony-scoping (the one resource in the app where the auth tier depends on
  a value in the request body, not just which route was hit).
- §11 "Inconsistent colony scoping" observation: update to reflect that
  `members` is now partially scoped (opt-in), not uniformly unscoped;
  `donors`/`availability`/walk-in donations remain fully unscoped, unchanged.
- §12 Unknowns: soften/update the "Will `members` ever become colony-scoped?"
  question to reflect that it now optionally is, as of this change.

## Explicitly not touched
`colony_memberships`, `users`, `middleware/auth.js`, login/auth flow,
`donors`/`availability`/walk-in-donations scoping — all untouched, as
instructed.

## Verification
- `npm run migrate` against the local docker Postgres (per PROGRESS.md's
  documented DB caveat — swap `.env` to the docker line first).
- Manual pass via running server: create member with no `colony_id` (any
  authenticated user, unchanged); create with `colony_id` as a non-admin
  (403); as the colony's admin (201); duplicate phone in the same colony
  (409); same phone in a *different* colony (201, distinct row); bad
  `colony_id` (400, FK violation path); `GET /members?colony_id=` filter;
  `PATCH /members/:id` confirming `colony_id` in the body is ignored/rejected
  as documented.

## After implementation
Update `PROGRESS.md` (Done section, lessons if any), same as prior features.
