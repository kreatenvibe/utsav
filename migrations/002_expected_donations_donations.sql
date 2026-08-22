CREATE TABLE donors (
  donor_id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT
);

CREATE TABLE expected_donations (
  expected_id SERIAL PRIMARY KEY,
  donor_id INTEGER NOT NULL REFERENCES donors(donor_id),
  festival_id INTEGER NOT NULL REFERENCES festival(festival_id),
  expected_amount NUMERIC NOT NULL,
  year INTEGER NOT NULL,
  purpose TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed'))
);

CREATE TABLE donations (
  donation_id SERIAL PRIMARY KEY,
  donor_id INTEGER NOT NULL REFERENCES donors(donor_id),
  expected_id INTEGER REFERENCES expected_donations(expected_id),
  amount NUMERIC NOT NULL,
  date DATE NOT NULL,
  collected_by INTEGER REFERENCES members(member_id)
);
