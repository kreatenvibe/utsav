ALTER TABLE donors ADD COLUMN colony_id INTEGER;

-- Backfill from each donor's existing pledge, if any.
UPDATE donors d
SET colony_id = (
  SELECT f.colony_id
  FROM expected_donations ed
  JOIN festival f ON f.festival_id = ed.festival_id
  WHERE ed.donor_id = d.donor_id
  LIMIT 1
)
WHERE d.colony_id IS NULL;

-- Any donor with no pledge at all falls back to the first colony.
UPDATE donors
SET colony_id = (SELECT colony_id FROM colony ORDER BY colony_id ASC LIMIT 1)
WHERE colony_id IS NULL;

-- Only reachable if no colony exists yet to fall back to.
DELETE FROM donors WHERE colony_id IS NULL;

ALTER TABLE donors ALTER COLUMN colony_id SET NOT NULL;
ALTER TABLE donors ADD CONSTRAINT fk_donors_colony FOREIGN KEY (colony_id) REFERENCES colony(colony_id) ON DELETE CASCADE;
CREATE INDEX idx_donors_colony_id ON donors(colony_id);
CREATE INDEX idx_donors_colony_name ON donors(colony_id, name);
