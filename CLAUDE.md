# Festival Management Backend

## What this is
Backend for a community festival management app (donations, expenses, tasks, volunteers, multi-colony support). See PROJECT_OVERVIEW.md for full schema.

## Stack
- Node.js + Express
- PostgreSQL

## Code style
- Use ES modules (import/export), not CommonJS
- Keep route handlers thin; business logic in separate service files

## Rules
- Money fields (amounts paid/received) are never edited after creation — only new rows are added
- Totals (donated_amount, paid_amount, balance) are calculated by summing related rows, not stored as counters
- Status fields (open/closed/settled) are set explicitly, not auto-derived
- current_balance is always computed, never stored — this overrides any other doc that says otherwise.

## Workflow
- Read PROGRESS.md at the start of every session before doing anything
- Update PROGRESS.md after finishing a feature (mark done, note any lessons learned)
- Write a short plan to plans/<feature-name>.md before implementing a new feature; review before coding starts
