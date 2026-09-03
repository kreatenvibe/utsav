# Let walk-in donations attribute to a festival

## Why
`festival.current_balance` sums donations reached via `expected_donations.festival_id`
only. A walk-in donation (`expected_id IS NULL`) has no FK path to any festival,
so cash collected at a festival with no pledge on file silently never counts
toward that festival's balance. This adds an optional, mutually-exclusive
`festival_id` on `donations` so a walk-in can opt in.

## Migration: `migrations/019_add_festival_id_to_donations.sql`
- `ALTER TABLE donations ADD COLUMN festival_id INTEGER REFERENCES festival(festival_id);`
  Nullable, no backfill (existing rows stay `NULL`, same as everywhere else in
  this schema keeps its FKs `ON DELETE`-clause-free — no deviation like
  `donors.colony_id` needed here since there's no cascade-delete concern).
- `CREATE INDEX idx_donations_festival_id ON donations(festival_id);`

## Service layer: `services/donationService.js`
**Mutual exclusivity, resolved simply**: rather than "derive from
`expected_donations` and overwrite/ignore a conflicting client value," the
column is only ever populated on the walk-in path. If `expected_id` is set,
`festival_id` is not stored (stays `NULL`) — current behavior for
pledge-linked balance math already works via the existing `expected_donations`
join, so nothing needs to change there. This is the reading that matches the
task's own final, authoritative rule ("`expected_id` and this direct
`festival_id` are mutually exclusive by convention — enforce that: reject a
request that sets both") and the required test ("a request that sets both...
rejected with 400") — it's the simplest implementation that satisfies it
without inventing a redundant derive-and-store step.

`createDonation({ donor_id, expected_id, festival_id, amount, date, collected_by }, actingUserId)`:
1. Existing required-field check unchanged.
2. New: if both `expected_id` and `festival_id` are present → 400
   `"expected_id and festival_id cannot both be set"`.
3. `expected_id` branch: unchanged (`colonyIdForExpectedDonation` +
   `assertColonyAdmin` when it resolves). Insert `festival_id: null`.
4. Walk-in branch (`expected_id` falsy): `assertAdminOfAnyColony` unchanged.
   If `festival_id` is present, validate it exists — reuse
   `colonyIdForFestival` from `colonyMembershipService.js` (already does
   `SELECT colony_id FROM festival WHERE festival_id = $1`); `null` back means
   "doesn't exist" → 404 `"festival not found"`. No colony-admin-of-that-
   festival's-colony check (spec: keep the existing any-colony gate for
   walk-ins as-is). Insert the given `festival_id`.
5. `deleteDonation`: unchanged — festival_id doesn't affect the delete gate.

## `services/festivalService.js` — `current_balance` computation
Add a second summand alongside the existing pledge-linked subquery:
```sql
COALESCE((
  SELECT SUM(d2.amount) FROM donations d2
  WHERE d2.festival_id = f.festival_id
    AND d2.expected_id IS NULL
    AND d2.deleted_at IS NULL
), 0)
```
`d2.expected_id IS NULL` is defense-in-depth (belt-and-suspenders alongside
the write-time 400) so a future bypass of the service layer can't
double-count a row that somehow has both set.

## Routes: `routes/donations.js`
No changes needed — `req.body` already passes `festival_id` through to the
service, and `GET /donations`/`GET /donations/:id` already return `d.*` from
`donationService.js`'s `BASE_SELECT`, which will include the new column
automatically.

## Tests: new `test/donations.test.js`
Following `test/colonyMembership.test.js`'s conventions (direct-insert users,
`POST /colonies` + `POST /festivals` + a colony-admin token, cleanup in
`after`). Cases:
1. Walk-in donation with `festival_id` set → appears in that festival's
   `GET /festivals/:id` `current_balance`.
2. Walk-in donation with no `festival_id` → still excluded from every
   festival's `current_balance` (existing behavior, made explicit).
3. `POST /donations` with both `expected_id` and `festival_id` → 400.
4. `POST /donations` walk-in with a nonexistent `festival_id` → 404.

## Docs: `docs/BACKEND_ANALYSIS.md`
- §3 `donations` entity: add `festival_id` (nullable FK, walk-in-only —
  mutually exclusive with `expected_id`, enforced 400).
- §3 "Derived/calculated values": rewrite the `current_balance` formula and
  drop the "Walk-in donations are excluded" line — replace with "a walk-in
  can optionally carry `festival_id` to count toward that festival's
  balance; a walk-in with no `festival_id` is still excluded."
- §4 Donations table/body: create body gains optional `festival_id`; note
  the 400 on setting both fields and the 404 on a bad `festival_id`.
- §5 authorization note for walk-ins: unchanged gate, just mention
  `festival_id` is accepted without a colony-specific check.
- §6 workflow step 6 (walk-in donation): update to describe the optional
  `festival_id` and its effect on balance.
- §8 "Log a Walk-in Donation" screen: mention the optional festival picker
  and that only donations tagged this way count toward that festival's
  balance now.

## PROGRESS.md
Add a "Done" entry once implemented, per the project workflow rule.
