-- Repoint every members-dependent FK at users instead, then drop members entirely.
-- Migration 014 guaranteed every task_assignments/availability member has a linked
-- user_id; the NOT NULL below will fail loudly if that invariant somehow doesn't hold.

ALTER TABLE task_assignments ADD COLUMN user_id INTEGER REFERENCES users(user_id);
UPDATE task_assignments ta SET user_id = m.user_id FROM members m WHERE m.member_id = ta.member_id;
ALTER TABLE task_assignments ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE task_assignments DROP COLUMN member_id;

ALTER TABLE availability ADD COLUMN user_id INTEGER REFERENCES users(user_id);
UPDATE availability av SET user_id = m.user_id FROM members m WHERE m.member_id = av.member_id;
ALTER TABLE availability ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE availability DROP COLUMN member_id;

-- collected_by / paid_by stay nullable, attribution-only — a member with no linked
-- user (never referenced task_assignments/availability, so migration 014 skipped it)
-- simply loses attribution here, which is acceptable per the plan (not a financial fact).
ALTER TABLE donations ADD COLUMN collected_by_user_id INTEGER REFERENCES users(user_id);
UPDATE donations d SET collected_by_user_id = m.user_id FROM members m WHERE m.member_id = d.collected_by;
ALTER TABLE donations DROP COLUMN collected_by;
ALTER TABLE donations RENAME COLUMN collected_by_user_id TO collected_by;

ALTER TABLE expense_payments ADD COLUMN paid_by_user_id INTEGER REFERENCES users(user_id);
UPDATE expense_payments ep SET paid_by_user_id = m.user_id FROM members m WHERE m.member_id = ep.paid_by;
ALTER TABLE expense_payments DROP COLUMN paid_by;
ALTER TABLE expense_payments RENAME COLUMN paid_by_user_id TO paid_by;

DROP TABLE members;
