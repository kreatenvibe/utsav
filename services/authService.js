import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from '../db/pool.js';

const SALT_ROUNDS = 10;

export async function registerUser({ email, password }) {
  if (!email || !password) {
    const err = new Error('email and password are required');
    err.status = 400;
    throw err;
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  try {
    const { rows } = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING user_id, email',
      [email, passwordHash]
    );
    return rows[0];
  } catch (err) {
    if (err.code === '23505') {
      const conflict = new Error('email already registered');
      conflict.status = 409;
      throw conflict;
    }
    throw err;
  }
}

export async function loginUser({ email, phone, password }) {
  if (!password || (!email && !phone)) {
    const err = new Error('password and either email or phone are required');
    err.status = 400;
    throw err;
  }
  if (email && phone) {
    const err = new Error('provide either email or phone, not both');
    err.status = 400;
    throw err;
  }

  const column = email ? 'email' : 'phone';
  const identifier = email || phone;
  const { rows } = await pool.query(
    `SELECT user_id, email, phone, password_hash FROM users WHERE ${column} = $1`,
    [identifier]
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

  const token = jwt.sign(
    { user_id: user.user_id, email: user.email, phone: user.phone },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
  return { token };
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
