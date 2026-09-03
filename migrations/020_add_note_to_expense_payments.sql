ALTER TABLE expense_payments ADD COLUMN note TEXT;

UPDATE expense_payments SET note = '' WHERE note IS NULL;

ALTER TABLE expense_payments ALTER COLUMN note SET NOT NULL;
