# Bulk-add colony members + bulk-import donors

Two new file-driven bulk-write endpoints, reusing the existing
`POST /members/bulk` infrastructure (multer memory storage, 5MB cap,
csv-parse/exceljs parsing, row-level `{ created, skipped, errors }` response,
1-based row numbers excluding header). No new way to parse CSV/XLSX.

## Shared parsing extraction

`memberService.js` currently defines `parseRoster`/`parseCsv`/`parseXlsx`/
`normalizeHeader` as private helpers. Extract these into a new
`services/rosterParser.js` (exported) so both `colonyMembershipService.js`
and `donorService.js` can reuse them without a circular import back through
`memberService.js` (which already imports from `colonyMembershipService.js`).
`memberService.js` switches to importing from the new module; behavior
unchanged.

## 1. `POST /colonies/:id/members/bulk` (priority)

- Route: `routes/colonies.js`, same inline multer-wrapping pattern as
  `routes/members.js`'s `/bulk` route. Registered after the existing
  `POST /:id/members` (no path conflict — different segment count from
  `PATCH/DELETE /:id/members/:userId`).
- Service: new `colonyMembershipService.bulkAddMembers(colonyId, actingUserId, file)`.
  Refactor the existing `addMember` into a shared `insertMembership(colonyId, {email, role})`
  helper (validation + lookup + insert + 409-on-duplicate translation) that
  neither asserts admin nor is asserted twice; `addMember` becomes
  `assertColonyAdmin` + `insertMembership`, and `bulkAddMembers` asserts admin
  **once**, then calls `insertMembership` per row — matching `/members/bulk`'s
  convention of a single up-front admin check.
- File columns: `email` (required per row), `role` (optional, defaults
  `'member'`, must be `'admin'`/`'member'` if given).
- Per-row outcomes:
  - missing email → `errors`
  - invalid role → `errors`
  - no registered user with that email (single-add's 404) → `errors`
  - already a member of this colony (single-add's 409) → `skipped`
  - success → `created`, shape = `insertMembership`'s return
    (`colony_membership_id, colony_id, user_id, role, created_at`) + `row`.
- Top-level 400 if no file; existing `colonyService.getColony` 404 check and
  `assertColonyAdmin` 403 reused as-is (route already fetches the colony
  first, same as the single-add route).

## 2. `POST /donors/bulk`

- Route: `routes/donors.js`, same multer pattern.
- Service: new `donorService.bulkImportDonors(file)`. No colony scoping, no
  auth beyond the existing global write-gate (any authenticated user, same as
  single `POST /donors`).
- File columns: `name` (required per row), `phone` (optional).
- No dedup rule exists for donors (no uniqueness constraint) — every row with
  a name lands in `created`; missing name → `errors`. Response still returns
  `skipped: []` (always empty) to keep the same three-key shape as
  `/members/bulk` for a uniform client parser, per the request wording
  ("exactly the same shape as /members/bulk").
- `created` row shape: `{ row, donor_id, name, phone }`.

## Tests

New `test/bulkImport.test.js` (own register/login/colony helpers, same
supertest-against-real-Postgres style as `colonyMembership.test.js`):
- colony bulk-add: valid new member row (created), already-a-member row
  (skipped), unregistered-email row (error), bad-role row (error),
  non-admin caller (403 top-level), missing file (400).
- donor bulk-import: valid row (created), missing-name row (error), no dedup
  (two rows with the same name+phone both created).

Run full suite (`npm test`) against local docker Postgres afterward, per
existing `.env` swap-and-restore convention documented in `PROGRESS.md`.
