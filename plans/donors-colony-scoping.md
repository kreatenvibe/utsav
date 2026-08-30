# Scope donors to colonies

## Why
`donors` is currently a flat global directory (no `colony_id`), gated only by
"admin of any colony" (`assertAdminOfAnyColony`). This ties each donor to one
specific colony so donor directories are isolated per colony, matching how
every other colony-owned resource (festivals, expenses, tasks) already works.

## Schema note (adapting the request to this repo's actual table names)
The request's SQL sketch uses `colonies`/`festivals` (plural). This schema's
real tables are singular: `colony` and `festival`
(`migrations/001_colony_festival_members.sql`). The migration below targets
`colony`/`festival`, not the plural names.

## Migration: `migrations/018_add_colony_id_to_donors.sql`
- Add nullable `donors.colony_id INTEGER`.
- Backfill from each donor's existing pledge (`expected_donations` →
  `festival.colony_id`), first row found.
- Backfill any remaining orphans to the first `colony` row.
- Delete any still-orphaned rows (only reachable if `colony` is empty).
- `SET NOT NULL`, add `fk_donors_colony` (`ON DELETE CASCADE`, per explicit
  instruction — this is a deviation from the rest of this schema's FKs, which
  have no `ON DELETE` clause; flagging it rather than silently matching the
  request or silently following existing convention).
- Index `colony_id`, compound index `(colony_id, name)`.

## Service layer: `services/donorService.js` (repo's actual filename —
the task calls it `donorsService.js`, but the file that `routes/donors.js`
already imports is singular `donorService.js`; editing that one rather than
creating a parallel file under a name nothing imports)
- Reuse the existing `assertColonyAdmin(userId, colonyId)` from
  `colonyMembershipService.js` — this is exactly the "admin of colony X"
  check the task calls `assertAdminOfColony`; no need for a second,
  identically-behaving export under a different name.
- `createDonor`: require `colony_id`, `name`; assert colony-admin of
  `colony_id` (not admin-of-any-colony anymore).
- `listDonors`: optional `colony_id` + `search` filters, combinable.
- `getDonor`: unchanged shape, now includes `colony_id`.
- `updateDonor`: caller passes `colony_id` already resolved from the fetched
  donor; route does the fetch-then-assert, service just checks admin of that
  colony_id like today's `assertAdminOfAnyColony(actingUserId)` call is
  replaced with `assertColonyAdmin(actingUserId, donor.colony_id)`.
- `bulkImportDonors`: require `colony_id` up front, assert admin-of-that-
  colony once (not per row, matching every other bulk endpoint in this app),
  insert every valid row with that `colony_id`.

## Routes: `routes/donors.js`
- `GET /donors?colony_id=&search=` — public read, both filters optional.
- `POST /donors` — body needs `colony_id`; auth now `assertColonyAdmin` via
  the service, not `assertAdminOfAnyColony`.
- `POST /donors/bulk?colony_id=` — colony_id from query string (multipart
  bodies don't reliably carry non-file fields the same way `req.body` GETs
  populated pre-multer, so query param per the task's own instruction).
- `PATCH /donors/:id` — route fetches the donor first (404 if missing), then
  the service asserts admin of the donor's own `colony_id`.

## Integrity check: `services/expectedDonationService.js`
`createExpectedDonation` already resolves the festival's `colony_id`
(`colonyIdForFestival`) and skips checks entirely if the festival doesn't
exist (existing null-skip convention — the FK violation on insert still
produces the 400). Adding: when the festival *does* resolve, also look up the
donor's `colony_id` and reject (400) a mismatch before the admin check's
`assertColonyAdmin` short-circuits into a write. A donor that doesn't exist
is left to the existing FK-violation 400 on insert, same as today.

## Docs
`docs/BACKEND_ANALYSIS.md` §4 (Donors table) and §5 (authorization) updated
to describe `colony_id`-scoped donors — anywhere else that describes donors
as globally admin-gated (§1, §8 Donors Directory screen, §11 resolved-
questions note) gets a pass too so nothing is left stale, same convention
every prior session in `PROGRESS.md` has followed.

## Tests
`test/bulkImport.test.js`'s existing donor-bulk test creates a colony but
never passes `colony_id` — it will 400 under the new required field. Updating
it to pass `colony_id` and asserting the created rows carry it.
