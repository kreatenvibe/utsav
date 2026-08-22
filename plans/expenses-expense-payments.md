# Plan: Expenses, Expense_Payments (build order step 3)

## Goal
Add the expense-tracking tables. Schema + migration only, matching the
scope/style of steps 1-2 (no routes yet).

## Files to add
- `migrations/003_expenses_expense_payments.sql`:
  - `expenses` (expense_id PK, festival_id FK → festival, purpose text,
    vendor_name text, amount_planned numeric,
    status text CHECK IN ('open','settled') default 'open')
  - `expense_payments` (payment_id PK, expense_id FK → expenses,
    amount numeric, date date, paid_by FK → members)

## Rules followed
- `expense_payments.amount` is a frozen fact — inserts only, no
  update/delete path.
- No `total_paid` column — always summed from `expense_payments` at query
  time.
- `status` on `expenses` is stored/organizer-set (open/settled), not derived.

## Out of scope
- Routes/services for expenses/expense_payments.
- Tasks, Task_Assignments, Availability.

## Verification
- `npm run migrate` applies 003 cleanly on top of 001-002.
