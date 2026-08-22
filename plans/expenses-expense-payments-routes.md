# Plan: Expenses, Expense_Payments routes/services

## Goal
Third layer of routes, following the schema build order. Adds expense
tracking (planned amounts) and actual expense payments — including the
derived "total paid" rollup. Mirrors the Expected_Donations/Donations
pattern (`plans/expected-donations-donations-routes.md`) since the shape is
the same: a "planned" parent with a derived sum, and a frozen-fact payment
child.

## Files to add
- `services/expenseService.js`:
  - `createExpense({ festival_id, purpose, vendor_name, amount_planned })` —
    `status` defaults to `'open'` in the DB, not settable at create.
  - `listExpenses({ festival_id, status })` — optional filters, each row
    annotated with `total_paid` (summed from `expense_payments` via
    `LEFT JOIN ... GROUP BY`).
  - `getExpense(id)` — same `total_paid` annotation.
  - `updateExpense(id, { purpose, vendor_name, amount_planned, status })` —
    `amount_planned` is an estimate, not an actual paid amount, so it's
    editable (unlike `expense_payments.amount`). `status` open→settled is an
    explicit organizer action, not derived.
- `services/expensePaymentService.js`:
  - `createExpensePayment({ expense_id, amount, date, paid_by })` —
    `paid_by` optional (nullable FK → members, matches schema).
  - `listExpensePayments({ expense_id })` — optional filter.
  - `getExpensePayment(id)`.
  - **No update/delete function** — `expense_payments.amount` is a frozen
    fact per CLAUDE.md; once inserted, only new rows are ever added.
- `routes/expenses.js` — mounted at `/expenses`: POST, GET (`?festival_id=`,
  `?status=`), GET/:id, PATCH.
- `routes/expensePayments.js` — mounted at `/expense-payments`: POST, GET
  (`?expense_id=`), GET/:id. **No PATCH, no DELETE.**
- `index.js` — mount the two new routers.

## Notes / rules followed
- `expense_payments.amount` never gets an update path — matches "money
  fields never edited after creation, only new rows added."
- `total_paid` is computed at query time (SUM over `expense_payments`),
  never stored — matches "totals are derived, not stored counters."
- `expenses.status` stays organizer-set via explicit PATCH, no
  auto-settle-when-total-reached logic.
- FK violations (bad `festival_id`/`expense_id`/`paid_by`) return 400 with a
  readable message, same pattern as `donationService.js`.
- Thin routes, logic in services, ES modules — per CLAUDE.md.

## Out of scope (later)
- Tasks, Task_Assignments, Availability routes.
- Any endpoint that updates `festival.current_balance` from
  donation/expense totals.
- Auth.

## Verification
- `npm run dev`, exercise: create expense, create 2+ expense_payments
  against it (partial payments) and confirm `total_paid` sums correctly on
  GET.
- Confirm status PATCH validation (`open`/`settled` only).
- Confirm no route exists to edit/delete an expense_payment (PATCH/DELETE
  return 404/405).
- Confirm bad FK on create returns 400, not 500.
