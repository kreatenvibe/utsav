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

const PHONE_UNIQUE_VIOLATION = '23505';

// Plain self-service registration — a users row identical to one created by
// a colony admin (no role flag, zero colonies). Works on every call,
// repeatedly; there is no "first account" concept in this API.
export async function registerUser({ name, phone, password }) {
  if (!name || !phone || !password) {
    const err = new Error('name, phone, and password are required');
    err.status = 400;
    throw err;
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  try {
    const { rows } = await pool.query(
      'INSERT INTO users (name, phone, password_hash) VALUES ($1, $2, $3) RETURNING user_id, phone',
      [name, phone, passwordHash]
    );
    return { token: signToken(rows[0]) };
  } catch (err) {
    if (err.code === PHONE_UNIQUE_VIOLATION) {
      const e = new Error('phone already registered');
      e.status = 409;
      throw e;
    }
    throw err;
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
