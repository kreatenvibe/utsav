# Plan: festival.current_balance derivation

## Goal
Resolve a schema/rule conflict: `festival.current_balance` is a stored
`NUMERIC NOT NULL DEFAULT 0` column (migration 001), but CLAUDE.md
explicitly lists "balance" as a total that must be "calculated by summing
related rows, not stored as counters" — the same rule already applied to
`total_donated` (expected_donations) and `total_paid` (expenses). Confirmed
with user: drop the stored column, compute at query time instead.

## Files to add/change
- `migrations/006_drop_festival_current_balance.sql`:
  `ALTER TABLE festival DROP COLUMN current_balance;`
- `services/festivalService.js`:
  - Add a `BASE_SELECT`/`GROUP_BY` pair like
    `expectedDonationService.js`/`expenseService.js`, joining festival to
    `donations` (via `donations.donor_id`... no — donations don't have
    `festival_id` directly, they link through `expected_donations`, but
    also allow walk-in donations with `expected_id IS NULL`). Need a
    festival-scoped view of "money in": donations don't carry
    `festival_id` directly. Resolve by summing two subqueries instead of a
    single multi-join (a join across `expected_donations` would only catch
    donations tied to an expectation, missing walk-ins with no
    `festival_id` path — so walk-in donations can never be attributed to a
    festival's balance under the current schema). **Scope decision:**
    `current_balance` sums only donations reachable via
    `expected_donations.festival_id` (walk-in donations with no
    `expected_id` have no festival to attribute to, by schema design —
    same nullable-FK tradeoff already accepted for `donations.expected_id`).
  - `getFestival(id)` and `listFestivals(...)` both add a computed
    `current_balance` field:
    `(SELECT COALESCE(SUM(d.amount),0) FROM donations d JOIN expected_donations ed ON ed.expected_id = d.expected_id WHERE ed.festival_id = f.festival_id) - (SELECT COALESCE(SUM(ep.amount),0) FROM expense_payments ep JOIN expenses e ON e.expense_id = ep.expense_id WHERE e.festival_id = f.festival_id)`
  - `createFestival`/`updateFestival` unaffected (never touched
    `current_balance`; already excluded from PATCH body per the original
    plan).

## Notes / rules followed
- Matches "totals are derived, not stored as counters" (CLAUDE.md) exactly
  — no writer, no counter, always summed fresh.
- Two correlated subqueries instead of a double outer join, to avoid a
  fan-out (donations × expense_payments) double-counting the sums.
- `current_balance` was never exposed on PATCH before, so no route/service
  contract changes beyond adding the read-only computed field.

## Out of scope
- Attributing walk-in donations (no `expected_id`) to a festival balance —
  would require adding `festival_id` directly to `donations`, a schema
  change beyond what was asked here.
- Auth, DELETE endpoints for core tables (separate open items).

## Verification
- `npm run migrate` applies 006 cleanly.
- `npm run dev`: GET a festival with existing donations/expense_payments
  test data (or fresh: create expected_donation + donation + expense +
  expense_payment under one festival), confirm `current_balance` on
  GET /festivals/:id equals sum(donations) − sum(expense_payments).
- Confirm festival with no donations/expenses yet returns
  `current_balance: "0"` (not null, not error).
- Confirm PATCH /festivals/:id body with `current_balance` in it is
  silently ignored (no way to set it — matches existing behavior for
  unknown fields via COALESCE pattern).
