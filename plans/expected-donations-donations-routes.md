# Plan: Donors, Expected_Donations, Donations routes/services

## Goal
Second layer of routes, following the schema build order. Adds donor
management, donation expectations, and actual donation payments — including
the derived "total donated" rollup.

## Files to add
- `services/donorService.js` — `createDonor`, `listDonors`, `getDonor`,
  `updateDonor` (name/phone) — same shape as `memberService.js`.
- `services/expectedDonationService.js`:
  - `createExpectedDonation({ donor_id, festival_id, expected_amount, year, purpose })`
    — `status` defaults to `'open'` in the DB, not settable at create.
  - `listExpectedDonations({ festival_id, donor_id, status })` — optional
    filters, each row annotated with `total_donated` (summed from `donations`
    via `LEFT JOIN ... GROUP BY`).
  - `getExpectedDonation(id)` — same `total_donated` annotation.
  - `updateExpectedDonation(id, { expected_amount, year, purpose, status })` —
    `expected_amount` is an estimate, not an actual paid/received amount, so
    it's editable (unlike `donations.amount`). `status` open→closed is an
    explicit organizer action, not derived.
- `services/donationService.js`:
  - `createDonation({ donor_id, expected_id, amount, date, collected_by })` —
    `expected_id` optional (nullable — walk-in donations not tied to an
    expectation, per PROJECT_OVERVIEW.md).
  - `listDonations({ donor_id, expected_id })` — optional filters.
  - `getDonation(id)`.
  - **No update/delete function** — `donations.amount` is a frozen fact per
    CLAUDE.md; once inserted, only new rows are ever added.
- `routes/donors.js` — mounted at `/donors`: POST, GET, GET/:id, PATCH.
- `routes/expectedDonations.js` — mounted at `/expected-donations`: POST, GET
  (`?festival_id=`, `?donor_id=`, `?status=`), GET/:id, PATCH.
- `routes/donations.js` — mounted at `/donations`: POST, GET (`?donor_id=`,
  `?expected_id=`), GET/:id. **No PATCH, no DELETE.**
- `index.js` — mount the three new routers.

## Notes / rules followed
- `donations.amount` never gets an update path — matches "money fields never
  edited after creation, only new rows added."
- `total_donated` is computed at query time (SUM over `donations`), never
  stored — matches "totals are derived, not stored counters."
- `expected_donations.status` stays organizer-set via explicit PATCH, no
  auto-close-when-total-reached logic.
- FK violations (bad `donor_id`/`festival_id`/`expected_id`) return 400 with a
  readable message, same pattern as `festivalService.js`.
- Thin routes, logic in services, ES modules — per CLAUDE.md.

## Out of scope (later)
- Expenses, Expense_Payments, Tasks, Task_Assignments, Availability routes.
- Any endpoint that updates `festival.current_balance` from donation totals.
- Auth.

## Verification
- `npm run dev`, exercise: create donor, create expected_donation, create 2+
  donations against it (one full, one partial) and confirm `total_donated`
  sums correctly on GET.
- Create a walk-in donation with no `expected_id`, confirm it's accepted.
- Confirm no route exists to edit/delete a donation (PATCH/DELETE return
  404/405).
- Confirm bad FK on create returns 400, not 500.
