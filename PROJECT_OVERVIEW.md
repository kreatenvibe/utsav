# Festival Management Backend — Project Overview

## What this is
A backend for managing a community festival (e.g., Ganesh Chaturthi) — tracking donations (expected + actual), expenses (planned + payments), tasks, volunteers, and support for multiple colonies (multi-tenant).

## Tech stack
- Node.js + Express
- PostgreSQL

## Tables

**Colony** — colony_id, name, location
**Festival** — festival_id, colony_id (FK), name, year, current_balance *(derived/cached)*

**Members** — member_id, name, phone *(organizers + volunteers, unified)*
**Donors** — donor_id, name, phone

**Expected_Donations** — expected_id, donor_id (FK), festival_id (FK), expected_amount, year, purpose (free text), status (open/closed — organizer-set)
**Donations** — donation_id, donor_id (FK), expected_id (FK), amount, date, collected_by (FK → Members)
> One row per actual payment. Total donated = derived by summing Donations per expected_id.

**Expenses** — expense_id, festival_id (FK), purpose, vendor_name, amount_planned, status (open/settled — organizer-set)
**Expense_Payments** — payment_id, expense_id (FK), amount, date, paid_by (FK → Members)
> One row per payment (advance, final, etc.). Total paid = derived by summing Expense_Payments per expense_id.

**Tasks** — task_id, festival_id (FK), title, planned_date, labor_required, status
**Task_Assignments** — assignment_id, task_id (FK), member_id (FK), signed_up_at *(junction: many:many, informal signup — estimation only, not strict scheduling; no role/day fields, no enforcement)*
**Availability** — availability_id, member_id (FK), date, is_available *(date-level only, no time-of-day granularity)*

## Core rules to remember
- Money amounts (paid, received) are **frozen facts** — never edited after the fact, never recalculated with new formulas.
- Totals (donated_amount, paid_amount, current_balance) are **derived** by summing event rows, not stored counters — avoids drift.
- Status fields (open/closed, planned/settled) are **stored**, set by an organizer — not purely auto-derived, because closing something is a judgment call, not just a number match.
- Every table with 1 colony/festival scope stays clean via `festival_id` → `colony_id` chain (or duplicate `colony_id` directly if query performance demands it — decide later if needed).

## Build order
1. Colony → Festival → Members
2. Expected_Donations → Donations
3. Expenses → Expense_Payments
4. Tasks → Task_Assignments → Availability