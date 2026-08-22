CREATE TABLE tasks (
  task_id SERIAL PRIMARY KEY,
  festival_id INTEGER NOT NULL REFERENCES festival(festival_id),
  title TEXT NOT NULL,
  planned_date DATE,
  labor_required INTEGER,
  status TEXT NOT NULL DEFAULT 'open'
);

CREATE TABLE task_assignments (
  assignment_id SERIAL PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(task_id),
  member_id INTEGER NOT NULL REFERENCES members(member_id),
  signed_up_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE availability (
  availability_id SERIAL PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(member_id),
  date DATE NOT NULL,
  is_available BOOLEAN NOT NULL
);
