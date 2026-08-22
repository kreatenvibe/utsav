# Plan: Expected_Donations, Donations (build order step 2)

## Goal
Add the donation-tracking tables. Schema + migration only, matching the
scope/style of step 1 (no routes yet).

## Note: Donors table
PROJECT_OVERVIEW.md lists `Expected_Donations.donor_id` and `Donations.donor_id`
as FKs to a `Donors` table (donor_id, name, phone) that isn't in the numbered
build order but is a hard prerequisite here — it's created in this step
alongside the two listed tables.

## Files to add
- `migrations/002_expected_donations_donations.sql`:
  - `donors` (donor_id PK, name, phone)
  - `expected_donations` (expected_id PK, donor_id FK → donors,
    festival_id FK → festival, expected_amount numeric, year integer,
    purpose text, status text CHECK IN ('open','closed') default 'open')
  - `donations` (donation_id PK, donor_id FK → donors,
    expected_id FK → expected_donations, amount numeric, date date,
    collected_by FK → members)

## Rules followed
- `donations.amount` is a frozen fact — no update/delete path will be built
  for it later; only inserts.
- No `total_donated` column anywhere — always summed from `donations` at
  query time when needed.
- `status` on `expected_donations` is stored/organizer-set, not derived.

## Out of scope
- Routes/services for donors/expected_donations/donations.
- Expenses, Expense_Payments, Tasks, Task_Assignments, Availability.

## Verification
- `npm run migrate` applies 002 cleanly on top of 001.
