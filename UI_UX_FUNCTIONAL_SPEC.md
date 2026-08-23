# Festival Ledger — Functional Specification

*For UI/UX design. This is a read of the backend code as it exists today, not a proposal — anything marked "not yet built" (delete, roles) should not get a button.*

**Stack:** Node.js + Express + PostgreSQL
**Auth:** JWT, single organizer role
**Modules:** 12
**Reads:** fully public (no login needed for any `GET`)

---

## Cross-cutting rules

These six rules apply to nearly every screen. Read them once — they explain why certain fields have no edit button, why some totals can't be typed into, and why a handful of entities have no delete option at all.

### 1. Money is frozen
Once a **Donation** or **Expense Payment** is saved, its `amount` can never be edited — there is no update endpoint for either.
Design correction as **delete, then re-add** — never as an inline amount edit. The delete confirmation should say so explicitly.

### 2. Totals are computed, not stored
`total_donated`, `total_paid`, and `current_balance` are summed from child rows on every request. There is no field to edit — don't design one.
They're always "live," so no staleness indicator is needed, but a deleted row will visibly shift a total the instant it's removed.

### 3. Status is a judgment call
`open`/`closed` and `open`/`settled` never flip automatically, even when the paid total matches the expected amount. An organizer must explicitly close or settle.
Design a deliberate "Mark as closed / settled" action — don't infer it from the numbers.

### 4. Delete is inconsistent by design
- **Soft-delete** (hidden, recoverable only in the database): Donations, Expense Payments, Expenses.
- **Hard-delete** (gone immediately): Tasks, Task Assignments, Availability.
- **No delete at all:** Colonies, Festivals, Members, Donors, Expected Donations.

Don't put a delete button on the last group. There is currently no "undo" for anything that can be deleted.

### 5. One role, no per-colony scoping
Registering an account makes you a full organizer with write access to *every* colony's data — there's no membership or permission model yet.
Don't design a "my colonies" filter as a security boundary; it can only ever be a convenience view.

### 6. Reads are public, writes need a session
Every `GET` works with no login. Every create, edit, and delete requires a bearer token, which expires after 7 days with no refresh.
Support a signed-out "browse" experience, and catch 401s on any write with a re-login prompt that preserves the in-progress form.

---

## How the data connects

Everything nests under a **Festival**, which nests under a **Colony** — that's the backbone for navigation:

```
Colony
 └─ Festival                                    ← current_balance is COMPUTED here:
     ├─ Expected Donations (pledge)                = Σ donations.amount
     │    └─ Donations (frozen payment log) ───────┘ − Σ expense_payments.amount
     ├─ Expenses (planned cost)                     (read fresh every request, never stored)
     │    └─ Expense Payments (frozen payment log) ─┘
     └─ Tasks
          └─ Task Assignments (volunteer signups)

Donors   ──gives──▶ Expected Donations, Donations
Members  ──signs up for──▶ Task Assignments
Members  ──marks available on──▶ Availability
Members  ··optionally attributed to·▶ Donations (collected_by), Expense Payments (paid_by)
```

The one non-obvious hop: **`current_balance` reaches straight into Donations and Expense Payments — two levels down** — rather than reading a total kept on Expected Donations or Expenses. Donations/Expense Payments are solid-bordered "money" nodes in this hierarchy; everything else is structural.

---

## 00 — Access

*One flow, one role. There's no volunteer-facing login and no per-colony permissions — anyone with an account can write anywhere.*

### Auth

Registration and login for organizers. Not a user directory — there's no admin screen to list or manage accounts.

**Fields**

| Field | Type | Required | Notes |
|---|---|---|---|
| `email` | text | Yes | Must be unique — duplicate registration is rejected. |
| `password` | text | Yes | Hashed on the server; never returned in any response, ever. |

**Endpoints**

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/auth/register` | — | Creates the account, returns id + email (no token) |
| POST | `/auth/login` | — | Returns `{ token }` — a JWT valid 7 days |

**Design notes**
- Login and registration are the only two screens in this module — there is no "forgot password," no email verification, and no profile/settings screen for the account itself.
- A wrong password and an unregistered email return the *identical* message ("invalid credentials") — don't design the login error to reveal which one it was.
- Persist the token client-side and show a simple "signed in as [email]" state somewhere global. Since it silently expires after 7 days, the first write action after expiry should catch the 401 and reopen login without losing the user's in-progress form.

---

## 01 — Foundation

*The directories every other module hangs off: where a festival happens, and who's involved — as organizers, volunteers, or donors.*

### Colonies

The top of the hierarchy — a housing colony or neighborhood running its own festival(s). Likely the first thing shown after login, or a picker at the app's entry point.

**Fields**

| Field | Type | Required | Notes |
|---|---|---|---|
| `colony_id` | integer | auto | Primary key. |
| `name` | text | Yes | — |
| `location` | text | No | Freeform — no structured address, no map coordinates. |

**Endpoints**

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/colonies` | 🔒 | create |
| GET | `/colonies` | — | list, no filters |
| GET | `/colonies/:id` | — | detail |
| PATCH | `/colonies/:id` | 🔒 | edit name / location |

**Design notes**
- No delete — every festival references a colony, so removing one is a backend decision that hasn't been made yet. Don't add a delete button here.
- `location` is a plain text field, not a structured address — design it as a single line, not a multi-field address form.

### Festivals

One edition of an event within a colony (e.g. "Ganesh Chaturthi 2026"). This is the scope that almost everything else — donations, expenses, tasks — hangs off. Its dashboard is likely the app's main screen.

**Fields**

| Field | Type | Required | Notes |
|---|---|---|---|
| `festival_id` | integer | auto | Primary key. |
| `colony_id` | integer (FK) | Yes | Set at creation, not editable after. |
| `name` | text | Yes | — |
| `year` | integer | Yes | Same colony can run several festivals across years — design a festival switcher, not a single fixed one. |
| `current_balance` | numeric | **computed** | Donations linked to this festival minus its expense payments. **Walk-in donations with no linked pledge are excluded** from this number. |

**Endpoints**

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/festivals` | 🔒 | create |
| GET | `/festivals?colony_id=` | — | list, filterable by colony |
| GET | `/festivals/:id` | — | detail, includes current_balance |
| PATCH | `/festivals/:id` | 🔒 | edit name / year only |

**Design notes**
- `current_balance` is the natural headline number for a festival dashboard — treat it as a stat, never as an editable field, and consider a small info affordance explaining the walk-in-donation exclusion since organizers will ask why it doesn't match their mental total.
- No delete, and `colony_id` can't be changed after creation — a festival can't be "moved" to another colony.

### Members

The people directory for organizers and volunteers, unified into one table. Reused as a picker across four other modules: who collected a donation, who paid an expense, who's assigned to a task, who's marked available.

**Fields**

| Field | Type | Required | Notes |
|---|---|---|---|
| `member_id` | integer | auto | Primary key. |
| `name` | text | Yes | — |
| `phone` | text | No | — |

**Endpoints**

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/members` | 🔒 | create |
| GET | `/members` | — | list, no filters |
| GET | `/members/:id` | — | detail |
| PATCH | `/members/:id` | 🔒 | edit name / phone |

**Design notes**
- Design one "person picker" component (search-by-name, shows phone) and reuse it everywhere a member is chosen — a donation's "collected by," an expense payment's "paid by," a task's volunteer list, an availability entry. Consistency here saves real design time.
- A Member detail screen naturally wants to roll up "tasks signed up for" (via `task-assignments?member_id=`) and availability, even though the API doesn't bundle that for you — plan on multiple calls.
- No delete — a member can't be removed once created, even if unused.

### Donors

External people who give money — kept separate from Members because giving isn't the same relationship as organizing or volunteering. Structurally identical to Members, so the two list/detail layouts can share a pattern.

**Fields**

| Field | Type | Required | Notes |
|---|---|---|---|
| `donor_id` | integer | auto | Primary key. |
| `name` | text | Yes | — |
| `phone` | text | No | — |

**Endpoints**

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/donors` | 🔒 | create |
| GET | `/donors` | — | list, no filters |
| GET | `/donors/:id` | — | detail |
| PATCH | `/donors/:id` | 🔒 | edit name / phone |

**Design notes**
- A Donor detail screen should roll up their pledges (Expected Donations) and actual gifts (Donations) via `?donor_id=` filters — that's likely more useful to an organizer than the bare name/phone record itself.
- No delete, same as Members.

---

## 02 — Donations

*A pledge (Expected Donation) and the actual money against it (Donations) are two different objects on purpose — a pledge can be partially paid, fully paid, written off, or never formally made at all (a walk-in gift).*

### Expected Donations

A donor's pledge for a festival: what they said they'd give. Tracked separately from what they've actually paid.

**Fields**

| Field | Type | Required | Notes |
|---|---|---|---|
| `expected_id` | integer | auto | Primary key. |
| `donor_id` | integer (FK) | Yes | — |
| `festival_id` | integer (FK) | Yes | — |
| `expected_amount` | numeric | Yes | Editable later — this is a pledge estimate, not a frozen payment. |
| `year` | integer | Yes | Editable. |
| `purpose` | text | No | Freeform note, e.g. "decoration sponsorship." |
| `status` | `open` / `closed` | default open | Organizer-set, not auto-derived from payment totals. |
| `total_donated` | numeric | **computed** | Sum of every non-deleted Donation linked to this pledge. |

**Endpoints**

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/expected-donations` | 🔒 | create |
| GET | `/expected-donations?festival_id=&donor_id=&status=` | — | list, filterable |
| GET | `/expected-donations/:id` | — | detail, includes total_donated |
| PATCH | `/expected-donations/:id` | 🔒 | edit amount / year / purpose / status |

**Design notes**
- This is a progress-bar screen: `expected_amount` vs `total_donated`, with the individual Donation rows listed underneath as a drill-in. A "Log a payment" action here should pre-fill this pledge's `expected_id`.
- "Mark as closed" is a deliberate organizer action, not automatic — it makes sense even on an underpaid pledge (e.g. an organizer writing off a shortfall), so don't gate the button on `total_donated ≥ expected_amount`.
- No delete on this entity — a pledge can be edited or closed, never removed.

### Donations

A single actual payment from a donor — the frozen, auditable fact. Can be logged against a pledge, or as a walk-in gift with no pledge at all.

**Fields**

| Field | Type | Required | Notes |
|---|---|---|---|
| `donation_id` | integer | auto | Primary key. |
| `donor_id` | integer (FK) | Yes | — |
| `expected_id` | integer (FK) | No | Null = walk-in gift with no linked pledge. This also excludes it from any festival's `current_balance`. |
| `amount` | numeric | Yes | **Frozen** — never editable after creation. |
| `date` | date | Yes | Plain calendar date, no time-of-day. |
| `collected_by` | integer (FK → Members) | No | Attribution only, optional. |

**Endpoints**

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/donations` | 🔒 | create |
| GET | `/donations?donor_id=&expected_id=` | — | list, filterable |
| GET | `/donations/:id` | — | detail |
| DELETE | `/donations/:id` | 🔒 | soft delete — **no PATCH exists at all** |

**Design notes**
- Two distinct entry points need designing: **logging a payment against a pledge** (from the Expected Donation screen, `expected_id` pre-filled) and a **standalone "record a walk-in donation"** flow (no pledge, likely from a global quick-add), which asks for a donor first if one doesn't already exist.
- Because `amount` can never be edited, the only "fix a typo" path is delete-and-recreate — say so plainly in the delete confirmation, e.g. "This can't be edited. Deleting removes it from all totals; you'll need to re-enter it correctly."

---

## 03 — Expenses

*The mirror image of the donations pair: a planned line item (Expense) and the frozen payments made against it (Expense Payments) — advance, final, or however many installments it took.*

### Expenses

A planned cost for the festival — a vendor, a budget line, a purpose. Tracks what was planned separately from what's actually been paid out.

**Fields**

| Field | Type | Required | Notes |
|---|---|---|---|
| `expense_id` | integer | auto | Primary key. |
| `festival_id` | integer (FK) | Yes | — |
| `purpose` | text | No | What it's for, e.g. "tent rental." |
| `vendor_name` | text | No | Freeform, not a linked Vendor entity. |
| `amount_planned` | numeric | Yes | Editable budget estimate. |
| `status` | `open` / `settled` | default open | Organizer-set. |
| `total_paid` | numeric | **computed** | Sum of every non-deleted Expense Payment against this line. |

**Endpoints**

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/expenses` | 🔒 | create |
| GET | `/expenses?festival_id=&status=` | — | list, filterable |
| GET | `/expenses/:id` | — | detail, includes total_paid |
| PATCH | `/expenses/:id` | 🔒 | edit purpose / vendor / amount_planned / status |
| DELETE | `/expenses/:id` | 🔒 | soft delete |

**Design notes**
- Same progress-bar pattern as Expected Donations: `amount_planned` vs `total_paid`, with payments listed beneath. Consider flagging when `total_paid` exceeds `amount_planned` — the API allows overpayment against a budget with no warning of its own.
- Deleting an Expense hides its whole payment history too (soft delete cascades visually, since the parent 404s). Warn for that in the confirmation, not just "delete this expense."

### Expense Payments

A single actual payment made toward an expense — advance, installment, or final settlement. Frozen once logged, same as a Donation.

**Fields**

| Field | Type | Required | Notes |
|---|---|---|---|
| `payment_id` | integer | auto | Primary key. |
| `expense_id` | integer (FK) | Yes | — |
| `amount` | numeric | Yes | **Frozen** — never editable after creation. |
| `date` | date | Yes | Plain calendar date. |
| `paid_by` | integer (FK → Members) | No | Attribution only, optional. |

**Endpoints**

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/expense-payments` | 🔒 | create |
| GET | `/expense-payments?expense_id=` | — | list, filterable |
| GET | `/expense-payments/:id` | — | detail |
| DELETE | `/expense-payments/:id` | 🔒 | soft delete — **no PATCH exists at all** |

**Design notes**
- Entry flow is a single "Log a payment" form on the parent Expense screen, `expense_id` pre-filled. Same delete-not-edit correction pattern as Donations.

---

## 04 — Volunteering

*Loosely-tracked work coordination — a task board and an informal signup sheet, not a shift scheduler. Nothing here enforces headcount or prevents double-booking; it's for visibility, not control.*

### Tasks

A piece of work the festival needs done — set up the pandal, arrange sound, coordinate prasad. Has a three-stage status and an optional target headcount.

**Fields**

| Field | Type | Required | Notes |
|---|---|---|---|
| `task_id` | integer | auto | Primary key. |
| `festival_id` | integer (FK) | Yes | — |
| `title` | text | Yes | — |
| `planned_date` | date | No | — |
| `labor_required` | integer | No | A target headcount — purely informational, never enforced against actual signups. |
| `status` | `planned` / `in_progress` / `done` | default planned | Database-enforced fixed set — a 4th value is rejected outright. |

**Endpoints**

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/tasks` | 🔒 | create |
| GET | `/tasks?festival_id=&status=` | — | list, filterable |
| GET | `/tasks/:id` | — | detail |
| PATCH | `/tasks/:id` | 🔒 | edit title / date / headcount / status |
| DELETE | `/tasks/:id` | 🔒 | hard delete — **blocked if volunteers are signed up** |

**Design notes**
- The 3-value status is a natural fit for a kanban board (Planned / In Progress / Done) or a simple stepper on a task card — don't design a free-text or open-ended status field.
- Show "X of Y signed up" by comparing the live Task Assignments count to `labor_required` — but this is informational only, never a cap. The form should not block a signup past the target number.
- Delete is refused outright if anyone is signed up. Either disable the delete action while assignments exist (with a tooltip explaining why), or catch the error and route the user to remove volunteers first.

### Task Assignments

A volunteer's informal signup for a task — a join row, nothing more. No role, no shift time, no confirmation step.

**Fields**

| Field | Type | Required | Notes |
|---|---|---|---|
| `assignment_id` | integer | auto | Primary key. |
| `task_id` | integer (FK) | Yes | — |
| `member_id` | integer (FK) | Yes | — |
| `signed_up_at` | timestamp | auto | Set by the server at creation. |

**Endpoints**

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/task-assignments` | 🔒 | sign a member up for a task |
| GET | `/task-assignments?task_id=&member_id=` | — | list, filterable either direction |
| GET | `/task-assignments/:id` | — | detail |
| DELETE | `/task-assignments/:id` | 🔒 | cancel a signup — **no PATCH exists** |

**Design notes**
- Design this as "add volunteer" / "remove volunteer" chips on the Task detail screen, not a form with fields — there's nothing to edit on a signup, only add or cancel. The same list, filtered by `member_id`, is what a Member's profile shows as "signed up for."

### Availability

A member's yes/no availability on a specific date. Date-level only — there's no time-of-day granularity, so it can't answer "free from 2–5pm," only "free that day."

**Fields**

| Field | Type | Required | Notes |
|---|---|---|---|
| `availability_id` | integer | auto | Primary key. |
| `member_id` | integer (FK) | Yes | Identity field — not editable after creation. |
| `date` | date | Yes | Identity field — not editable after creation. |
| `is_available` | boolean | Yes | The only field PATCH can touch. |

**Endpoints**

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/availability` | 🔒 | create |
| GET | `/availability?member_id=&date=` | — | list, filterable |
| GET | `/availability/:id` | — | detail |
| PATCH | `/availability/:id` | 🔒 | flip is_available only |
| DELETE | `/availability/:id` | 🔒 | hard delete |

**Design notes**
- A per-member calendar grid of yes/no toggles fits this well — each cell is a date, and clicking toggles or creates an availability row. To change which date a row refers to, the API requires delete-and-recreate, not an edit, so a drag-to-move interaction on a calendar wouldn't map cleanly to the backend.
- Cross-reference against Tasks' `planned_date` and `labor_required` to help organizers see who's free on a day they need people — the API won't do this join for you.

---

## Suggested screen inventory

One reasonable way to group these modules into actual screens. Not prescriptive — but a starting information architecture that covers every field above.

| Screen | Built from | Primary actions |
|---|---|---|
| Sign in / Register | Auth | Log in, create an organizer account. No signed-out actions beyond browsing. |
| Colony picker | Colonies | Select or add a colony. Likely the entry point after login. |
| Festival dashboard | Festivals (+ computed current_balance) | Switch festival year, see the headline balance, jump into Donations / Expenses / Tasks / Volunteers. |
| Donors directory | Donors | Search/add donors; each opens to their pledges and gifts. |
| Pledges (Expected Donations) | Expected Donations + Donations | List by status/festival; detail shows progress bar + payment log; log a payment; close a pledge. |
| Log a walk-in donation | Donations (expected_id empty) | Quick-add flow for a gift with no prior pledge. |
| Budget lines (Expenses) | Expenses + Expense Payments | List by status/festival; detail shows planned vs. paid + payment log; log a payment; settle a line. |
| Task board | Tasks + Task Assignments | Kanban or list by status; detail shows headcount progress and the volunteer chip list. |
| Volunteer roster | Members + Task Assignments + Availability | Directory of people; profile rolls up their signups and availability calendar. |
| Member / Donor profile | Members or Donors | Edit name/phone; shared layout pattern between the two directories. |

---

## Errors & edge states

Every error message below comes verbatim from the API — they're already written for a human, so surfacing the message text directly is usually the right call rather than writing a parallel set of UI copy.

| Status | When | Example message | Suggested treatment |
|---|---|---|---|
| 400 | Required field missing | `name is required` | Inline field error, use the message as-is. |
| 400 | A picked id doesn't exist | `colony_id does not reference an existing colony` | Form-level banner; refresh the picker's options — it's likely stale. |
| 400 | Invalid status value | `status must be 'open' or 'closed'` | Shouldn't normally fire if status is a fixed select, not free text — keep as a fallback. |
| 400 | Deleting a task with signups | `cannot delete task with existing task_assignments; remove those first` | Disable delete proactively when the assignment count > 0, with a tooltip. |
| 401 | Missing, invalid, or expired token on any write | `invalid or expired token` | Re-prompt login, preserving the in-progress form. |
| 404 | Unknown id, or a soft-deleted row (reads identically to gone) | `donation not found` | Standard "not found" empty state — no partial data. |
| 409 | Registering an email already in use | `email already registered` | Inline error on the email field, with a link to log in instead. |

---

*festival-management backend · PostgreSQL schema as of migrations 001–008 · read against the code, not a proposal*
