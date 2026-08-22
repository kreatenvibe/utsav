# Plan: Tasks, Task_Assignments, Availability routes/services

## Goal
Fourth and final layer of routes in the numbered build order. Adds task
tracking, volunteer signup (junction table), and volunteer date
availability. Shape differs from the previous two layers: no
money/frozen-fact fields here, and `task_assignments` is a true junction
table where removing a row (cancelling a signup) is a normal action, not a
violation of "money fields never edited."

## Files to add
- `services/taskService.js`:
  - `createTask({ festival_id, title, planned_date, labor_required })` —
    `festival_id` and `title` required. `status` defaults to `'planned'` in
    the DB, not settable at create.
  - `listTasks({ festival_id, status })` — optional filters.
  - `getTask(id)`.
  - `updateTask(id, { title, planned_date, labor_required, status })` —
    `status` validated against the DB CHECK (`planned`/`in_progress`/`done`,
    per `migrations/005_tasks_status_check.sql`), stored/organizer-set.
- `services/taskAssignmentService.js`:
  - `createTaskAssignment({ task_id, member_id })` — both required.
    `signed_up_at` defaults to `now()` in the DB.
  - `listTaskAssignments({ task_id, member_id })` — optional filters.
  - `getTaskAssignment(id)`.
  - `deleteTaskAssignment(id)` — cancels a signup. Unlike the money tables,
    this junction table has no frozen-fact rule, and PROJECT_OVERVIEW.md
    describes signup as informal/unenforced, so removing a row is a normal
    "I can't make it anymore" action, not a data-integrity violation.
  - No PATCH — a signup is either there or not; changing `task_id`/
    `member_id` on an existing row doesn't map to a real action (re-sign-up
    instead).
- `services/availabilityService.js`:
  - `createAvailability({ member_id, date, is_available })` — all three
    required (`is_available` is a boolean fact for that date, not
    defaultable).
  - `listAvailability({ member_id, date })` — optional filters.
  - `getAvailability(id)`.
  - `updateAvailability(id, { is_available })` — a volunteer can change
    their mind about a date already recorded; `member_id`/`date` are the
    row's identity and aren't editable (create a new row instead).
- `routes/tasks.js` — mounted at `/tasks`: POST, GET (`?festival_id=`,
  `?status=`), GET/:id, PATCH.
- `routes/taskAssignments.js` — mounted at `/task-assignments`: POST, GET
  (`?task_id=`, `?member_id=`), GET/:id, DELETE.
- `routes/availability.js` — mounted at `/availability`: POST, GET
  (`?member_id=`, `?date=`), GET/:id, PATCH.
- `index.js` — mount the three new routers.

## Notes / rules followed
- No stored totals/derived-sum fields in this layer (no amount columns).
- `tasks.status` stays organizer-set via explicit PATCH, validated against
  the existing DB CHECK constraint — same pattern as
  `expenses.status`/`expected_donations.status`.
- FK violations (bad `festival_id`/`task_id`/`member_id`) return 400 with a
  readable message, same pattern as the other services.
- Thin routes, logic in services, ES modules — per CLAUDE.md.
- `task_assignments` DELETE is a deliberate departure from the "no DELETE"
  pattern used for FK-referenced core tables — justified because it's a
  junction table representing an informal, cancellable signup, not a fact
  or a table other rows point back into.

## Out of scope
- Anything beyond the four numbered build-order steps (this completes it).
- Auth.
- Enforcing `labor_required` against actual signup counts (explicitly
  "estimation only" per PROJECT_OVERVIEW.md).

## Verification
- `npm run dev`, exercise: create task, sign up 2 members via
  task_assignments, list assignments filtered by `task_id`, cancel one via
  DELETE, confirm it's gone from the list.
- Confirm task status PATCH validation (rejects a bogus value, accepts
  `in_progress`/`done`).
- Create availability row, PATCH `is_available` to flip it, confirm GET
  reflects the change.
- Confirm bad FK on create (bad `festival_id`/`task_id`/`member_id`) returns
  400, not 500.
- Confirm no PATCH route exists on task_assignments (404).
