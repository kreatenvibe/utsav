# Plan: Colony, Festival, Members routes/services

## Goal
First set of API routes. Colony/Festival/Members are foundational — every
other table FKs into `festival_id` or `member_id` — so build these CRUD
endpoints before donations/expenses/tasks routes.

## Files to add
- `services/colonyService.js` — `createColony`, `listColonies`, `getColony`,
  `updateColony` (name/location only).
- `services/festivalService.js` — `createFestival`, `listFestivals` (optional
  `?colony_id=` filter), `getFestival`, `updateFestival` (name/year only —
  `current_balance` is not settable via this route, it's cached/derived and
  has no writer yet since donations/expenses routes don't exist).
- `services/memberService.js` — `createMember`, `listMembers`, `getMember`,
  `updateMember` (name/phone only).
- `routes/colonies.js` — thin handlers, mounted at `/colonies`:
  - `POST /colonies`
  - `GET /colonies`
  - `GET /colonies/:id`
  - `PATCH /colonies/:id`
- `routes/festivals.js` — mounted at `/festivals`:
  - `POST /festivals`
  - `GET /festivals` (supports `?colony_id=`)
  - `GET /festivals/:id`
  - `PATCH /festivals/:id`
- `routes/members.js` — mounted at `/members`:
  - `POST /members`
  - `GET /members`
  - `GET /members/:id`
  - `PATCH /members/:id`
- `index.js` — add `express.json()` middleware and mount the three routers.

## Notes / rules followed
- Route handlers stay thin (parse req, call service, send res); all query
  logic lives in `services/*.js`, per CLAUDE.md.
- No DELETE endpoints for now — nothing in the schema/rules calls for hard
  deletes, and colony/festival/members are referenced by FKs everywhere
  (deleting would need cascade decisions that are out of scope here). Flagging
  this choice — say if you want DELETE included.
- `current_balance` deliberately left out of the festival PATCH body — it's
  the one cached total in the schema and per PROJECT_OVERVIEW.md rules it
  should be maintained by application logic (once donations/expenses exist),
  not hand-edited via the API.
- No auth/authz in this step — out of scope until asked for.
- Basic validation: required fields checked in the service layer, 400 on
  missing fields, 404 on missing id, matching the plain-Express style already
  in `index.js`.

## Out of scope (later)
- Routes for donors, expected_donations, donations, expenses,
  expense_payments, tasks, task_assignments, availability.
- Logic that updates `festival.current_balance` from donations/expenses.
- Auth.

## Verification
- `npm run dev`, exercise each endpoint with curl/Postman: create a colony,
  create a festival under it, create a member, fetch/list/update each.
- Confirm FK violation (bad `colony_id` on festival create) returns a
  reasonable error, not a raw 500 stack trace.
