import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from '../db/pool.js';

const SALT_ROUNDS = 10;

function signToken(user) {
  return jwt.sign({ user_id: user.user_id, phone: user.phone }, process.env.JWT_SECRET, {
    expiresIn: '7d',
  });
}

export async function loginUser({ phone, password }) {
  if (!phone || !password) {
    const err = new Error('phone and password are required');
    err.status = 400;
    throw err;
  }

  const { rows } = await pool.query(
    'SELECT user_id, phone, password_hash FROM users WHERE phone = $1',
    [phone]
  );
  const user = rows[0];

  const invalid = () => {
    const err = new Error('invalid credentials');
    err.status = 401;
    return err;
  };

  if (!user) {
    throw invalid();
  }

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) {
    throw invalid();
  }

  return { token: signToken(user) };
}

// Creates the very first users row in a fresh deployment, now that
// self-registration is gone and every other account is created by a colony
// admin. Only succeeds while the users table is empty — the LOCK TABLE keeps
// the count-then-insert atomic so two near-simultaneous calls can't both
// pass the check and both insert.
export async function bootstrapFirstUser({ name, phone, password }) {
  if (!name || !phone || !password) {
    const err = new Error('name, phone, and password are required');
    err.status = 400;
    throw err;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE users IN EXCLUSIVE MODE');

    const { rows: countRows } = await client.query('SELECT COUNT(*) FROM users');
    if (Number(countRows[0].count) > 0) {
      const err = new Error('setup already completed');
      err.status = 403;
      throw err;
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const { rows } = await client.query(
      'INSERT INTO users (name, phone, password_hash) VALUES ($1, $2, $3) RETURNING user_id, phone',
      [name, phone, passwordHash]
    );

    await client.query('COMMIT');
    return { token: signToken(rows[0]) };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function changePassword(userId, { current_password, new_password }) {
  if (!current_password || !new_password) {
    const err = new Error('current_password and new_password are required');
    err.status = 400;
    throw err;
  }

  const { rows } = await pool.query('SELECT password_hash FROM users WHERE user_id = $1', [userId]);
  const user = rows[0];
  if (!user) {
    const err = new Error('user not found');
    err.status = 404;
    throw err;
  }

  const match = await bcrypt.compare(current_password, user.password_hash);
  if (!match) {
    const err = new Error('current password is incorrect');
    err.status = 401;
    throw err;
  }

  const passwordHash = await bcrypt.hash(new_password, SALT_ROUNDS);
  await pool.query('UPDATE users SET password_hash = $2 WHERE user_id = $1', [userId, passwordHash]);
}
