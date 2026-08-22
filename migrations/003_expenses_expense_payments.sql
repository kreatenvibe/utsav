CREATE TABLE expenses (
  expense_id SERIAL PRIMARY KEY,
  festival_id INTEGER NOT NULL REFERENCES festival(festival_id),
  purpose TEXT,
  vendor_name TEXT,
  amount_planned NUMERIC NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'settled'))
);

CREATE TABLE expense_payments (
  payment_id SERIAL PRIMARY KEY,
  expense_id INTEGER NOT NULL REFERENCES expenses(expense_id),
  amount NUMERIC NOT NULL,
  date DATE NOT NULL,
  paid_by INTEGER REFERENCES members(member_id)
);
