# Plan: Tasks, Task_Assignments, Availability (build order step 4)

## Goal
Add the task/volunteer-scheduling tables. Schema + migration only, matching
the scope/style of steps 1-3 (no routes yet). This is the last item in the
numbered build order.

## Files to add
- `migrations/004_tasks_assignments_availability.sql`:
  - `tasks` (task_id PK, festival_id FK → festival, title text,
    planned_date date, labor_required integer, status text default 'open')
  - `task_assignments` (assignment_id PK, task_id FK → tasks,
    member_id FK → members, signed_up_at timestamptz default now()) —
    junction table, informal signup (no role/day fields, no enforcement of
    labor_required, per PROJECT_OVERVIEW.md)
  - `availability` (availability_id PK, member_id FK → members, date date,
    is_available boolean) — date-level only, no time-of-day

## Judgment call: `tasks.status`
PROJECT_OVERVIEW.md lists a `status` column on Tasks but — unlike
Expected_Donations (open/closed) and Expenses (open/settled) — doesn't name
its allowed values. Rather than guess a CHECK constraint that might block a
legitimate value later, this leaves it as unconstrained `text default 'open'`,
stored/organizer-set like the other status fields. Flagging for confirmation;
easy to tighten with a follow-up migration once the real values are known.

## Rules followed
- No frozen-money-fact concerns here (no amount columns in this step).
- `status` stored, organizer-set — not derived.
- `task_assignments` intentionally has no unique constraint on
  (task_id, member_id) since PROJECT_OVERVIEW.md describes signup as
  informal/estimation-only, not enforced.

## Out of scope
- Routes/services for tasks/task_assignments/availability.
- Anything beyond the four numbered build-order steps.

## Verification
- `npm run migrate` applies 004 cleanly on top of 001-003.
