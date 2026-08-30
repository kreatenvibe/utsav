-- Collapse pre-existing duplicate (user_id, date) rows before the constraint
-- can be added, keeping the most recently inserted row per pair.
DELETE FROM availability a
USING availability b
WHERE a.user_id = b.user_id
  AND a.date = b.date
  AND a.availability_id < b.availability_id;

ALTER TABLE availability
ADD CONSTRAINT uq_availability_user_date UNIQUE (user_id, date);
