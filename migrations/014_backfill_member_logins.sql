-- Members will become mandatory-login users in migration 015 (task_assignments.user_id
-- and availability.user_id will be NOT NULL). Any existing member referenced by one of
-- those two tables but with no linked login yet needs a placeholder account first.
--
-- Identifier: the member's own phone if present, else a synthesized placeholder email
-- (satisfies users' "email IS NOT NULL OR phone IS NOT NULL" check without colliding
-- with real data). Password is an unusable random bcrypt hash — these accounts can only
-- be accessed after a colony admin runs POST /colonies/:id/members/:userId/reset-password.
--
-- Known edge case, left to fail loudly rather than silently guessed at: if two distinct
-- members needing backfill share the same real phone number (across different colonies),
-- the second INSERT below hits users' global phone-uniqueness constraint and this whole
-- migration rolls back. Resolution is manual (a DBA decides whether those two rows are
-- actually the same person) before re-running `npm run migrate`.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
DECLARE
  m RECORD;
  new_user_id INTEGER;
BEGIN
  FOR m IN
    SELECT DISTINCT mm.member_id, mm.name, mm.phone, mm.colony_id
    FROM members mm
    WHERE mm.user_id IS NULL
      AND (
        EXISTS (SELECT 1 FROM task_assignments ta WHERE ta.member_id = mm.member_id)
        OR EXISTS (SELECT 1 FROM availability av WHERE av.member_id = mm.member_id)
      )
  LOOP
    INSERT INTO users (name, email, phone, password_hash)
    VALUES (
      m.name,
      CASE WHEN m.phone IS NULL THEN 'legacy-member-' || m.member_id || '@placeholder.invalid' ELSE NULL END,
      m.phone,
      crypt(gen_random_uuid()::text, gen_salt('bf'))
    )
    RETURNING user_id INTO new_user_id;

    UPDATE members SET user_id = new_user_id WHERE member_id = m.member_id;

    IF m.colony_id IS NOT NULL THEN
      INSERT INTO colony_memberships (colony_id, user_id, role)
      VALUES (m.colony_id, new_user_id, 'member')
      ON CONFLICT (colony_id, user_id) DO NOTHING;
    END IF;
  END LOOP;
END $$;
