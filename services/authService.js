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

export async function loginUser({ email, password }) {
  if (!email || !password) {
    const err = new Error('email and password are required');
    err.status = 400;
    throw err;
  }

  const { rows } = await pool.query(
    'SELECT user_id, email, password_hash FROM users WHERE email = $1',
    [email]
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
    { user_id: user.user_id, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
  return { token };
}
