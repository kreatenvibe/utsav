CREATE TABLE colony (
  colony_id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  location TEXT
);

CREATE TABLE festival (
  festival_id SERIAL PRIMARY KEY,
  colony_id INTEGER NOT NULL REFERENCES colony(colony_id),
  name TEXT NOT NULL,
  year INTEGER NOT NULL,
  current_balance NUMERIC NOT NULL DEFAULT 0
);

CREATE TABLE members (
  member_id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT
);
