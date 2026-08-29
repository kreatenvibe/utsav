ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ADD COLUMN phone TEXT;

CREATE UNIQUE INDEX users_phone_unique ON users (phone) WHERE phone IS NOT NULL;

ALTER TABLE users ADD CONSTRAINT users_email_or_phone_check CHECK (email IS NOT NULL OR phone IS NOT NULL);
