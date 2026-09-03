# Plan: Mandatory `note` field on expense_payments

## Goal
Add a required, frozen-at-creation `note` (TEXT, NOT NULL) to
`expense_payments`, matching the existing frozen-`amount` pattern. No PATCH.

## Migration
`migrations/020_add_note_to_expense_payments.sql` — same
backfill-then-constrain pattern as `013_users_name.sql` /
`018_add_colony_id_to_donors.sql`:
```sql
ALTER TABLE expense_payments ADD COLUMN note TEXT;
UPDATE expense_payments SET note = '' WHERE note IS NULL;
ALTER TABLE expense_payments ALTER COLUMN note SET NOT NULL;
```

## Service (`services/expensePaymentService.js`)
- `createExpensePayment({ expense_id, amount, date, note, paid_by }, actingUserId)`:
  add `note` to the required-field check (`!note` catches missing/empty
  string, consistent with how `!amount`/`!date` are checked) and to the
  INSERT statement/params.
- `BASE_SELECT` uses `ep.*` already — `note` comes back for free on
  list/get, no change needed there.
- No PATCH function added — out of scope per CLAUDE.md's frozen-money-row
  rule, same as `amount`.

## Route (`routes/expensePayments.js`)
No change needed — it already just forwards `req.body` to the service.

## Docs
Update `docs/BACKEND_ANALYSIS.md`:
- `expense_payments` entity description (§3): add `note` (required) to the
  column list.
- Expense Payments `Create body` line (§4): add `note` as required.
