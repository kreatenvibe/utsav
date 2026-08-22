ALTER TABLE tasks
  ALTER COLUMN status SET DEFAULT 'planned';

ALTER TABLE tasks
  ADD CONSTRAINT tasks_status_check CHECK (status IN ('planned', 'in_progress', 'done'));
