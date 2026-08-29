ALTER TABLE users DROP CONSTRAINT users_email_or_phone_check;
ALTER TABLE users DROP COLUMN email;

DROP INDEX IF EXISTS users_phone_unique;
ALTER TABLE users ALTER COLUMN phone SET NOT NULL;
ALTER TABLE users ADD CONSTRAINT users_phone_key UNIQUE (phone);
