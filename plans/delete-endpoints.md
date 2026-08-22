# Plan: DELETE endpoints

## Goal
Add DELETE support across the API, per user direction:
- **Soft delete** (`deleted_at` column) on `donations`, `expense_payments`,
  `expenses` — the money-tracking tables, where a physical DELETE would
  destroy an audit trail for what's meant to be a frozen/near-frozen fact.
- **Hard delete** on `tasks` and `availability` — lower-stakes,
  non-financial tables. `task_assignments` already has hard DELETE
  (`services/taskAssignmentService.js`, added in the previous layer) and
  needs no change.
- **Explicitly out of scope**: `colonies`, `festivals`, `members`,
  `donors`, `expected_donations`. These are heavily FK-referenced by
  everything downstream and deleting one raises a cascade-behavior question
  (RESTRICT vs CASCADE vs SET NULL) that hasn't been decided — same
  "cascade behavior not yet decided" flag from the original
  colony/festival/members plan. Not deciding that silently here; ask
  separately if DELETE is wanted for these.

## Files to add/change
- `migrations/007_soft_delete_money_tables.sql`: adds nullable
  `deleted_at TIMESTAMPTZ` to `donations`, `expenses`, `expense_payments`.
- `services/donationService.js`:
  - `listDonations`/`getDonation` add an unconditional `deleted_at IS NULL`
    filter (soft-deleted rows behave as not-found/not-listed).
  - New `deleteDonation(id)` — `UPDATE donations SET deleted_at = now()`,
    after confirming the row exists (via `getDonation`, so an
    already-deleted row 404s like any other missing row).
- `services/expensePaymentService.js` — same shape:
  `deleted_at IS NULL` filter on list/get, new `deleteExpensePayment(id)`.
- `services/expenseService.js`:
  - `deleted_at IS NULL` filter on the expense side of `BASE_SELECT`.
  - The `total_paid` join (`LEFT JOIN expense_payments ep ON ep.expense_id
    = e.expense_id`) gets `AND ep.deleted_at IS NULL` added to the join
    condition, so a soft-deleted payment stops counting once removed.
  - New `deleteExpense(id)` — soft delete, same pattern.
- `services/expectedDonationService.js` — `total_donated`'s join
  (`LEFT JOIN donations d ON d.expected_id = ed.expected_id`) gets
  `AND d.deleted_at IS NULL`, so a soft-deleted donation stops counting.
- `services/festivalService.js` — both correlated subqueries in
  `current_balance` (donations sum, expense_payments sum) get an
  `AND ... deleted_at IS NULL` clause, for the same reason.
- `services/taskService.js` — new `deleteTask(id)`: hard `DELETE FROM
  tasks`. `task_assignments.task_id` is `NOT NULL REFERENCES tasks` with no
  `ON DELETE` clause (migration 004), so deleting a task with existing
  signups hits a `23503` FK violation — caught and turned into a 400
  ("cannot delete task with existing task_assignments; remove those
  first") rather than a raw 500, same pattern as the insert-side FK checks
  elsewhere.
- `services/availabilityService.js` — new `deleteAvailability(id)`: hard
  `DELETE FROM availability`. No dependents, no FK concern.
- `routes/donations.js`, `routes/expensePayments.js`, `routes/expenses.js`,
  `routes/tasks.js`, `routes/availability.js` — add
  `DELETE /:id` → `204 No Content` on success, matching the existing
  `task_assignments` DELETE convention.

## Notes / judgment calls
- Soft delete doesn't touch `amount`/`amount_planned` — only adds a new
  `deleted_at` column — so it doesn't conflict with "money fields never
  edited after creation" (CLAUDE.md); it's an audit-preserving void, not an
  edit.
- Not adding a "show deleted" query param anywhere — soft-deleted rows are
  simply invisible via the existing GET endpoints for now. Easy to add
  later if history/audit views are wanted.
- Not blocking creation of a new `expense_payment` against a soft-deleted
  `expense` (the FK is still physically intact, so it's allowed) — flagging
  this rather than silently adding an extra guard beyond what was asked.
- DELETE on an already-soft-deleted or already-hard-deleted row 404s (same
  "not found" as any other missing id), not a special "already deleted"
  response.

## Out of scope
- DELETE for colonies/festivals/members/donors/expected_donations (cascade
  behavior undecided — ask before doing this).
- Auth.
- A "restore" endpoint for soft-deleted rows.

## Verification
- `npm run migrate` applies 007 cleanly.
- `npm run dev`: soft-delete a donation, confirm it disappears from
  `GET /donations` and `GET /donations/:id` (404), confirm the parent
  `expected_donations` row's `total_donated` drops by that amount, confirm
  the festival's `current_balance` shifts accordingly.
- Same check for an expense_payment (disappears from list/get,
  `expenses.total_paid` and `current_balance` update).
- Soft-delete an expense, confirm it disappears from `GET /expenses`.
- Hard-delete an availability row, confirm 204 and it's gone.
- Create a task, sign up a member (task_assignment), attempt to hard-delete
  the task — expect 400, not 500. Remove the assignment, delete the task —
  expect 204.
- DELETE on a nonexistent/already-deleted id returns 404 in all five
  cases.
