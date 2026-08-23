CREATE TABLE colony_memberships (
  colony_membership_id SERIAL PRIMARY KEY,
  colony_id INTEGER NOT NULL REFERENCES colony(colony_id),
  user_id INTEGER NOT NULL REFERENCES users(user_id),
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (colony_id, user_id)
);
