ALTER TABLE donations ADD COLUMN festival_id INTEGER REFERENCES festival(festival_id);
CREATE INDEX idx_donations_festival_id ON donations(festival_id);
