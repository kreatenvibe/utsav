ALTER TABLE members ADD COLUMN colony_id INTEGER REFERENCES colony(colony_id);

CREATE UNIQUE INDEX members_colony_id_phone_unique
  ON members (colony_id, phone)
  WHERE colony_id IS NOT NULL;
