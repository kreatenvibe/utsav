import { pool } from '../db/pool.js';

export async function searchUsers({ search } = {}) {
  if (search) {
    const { rows } = await pool.query(
      'SELECT user_id, email, phone FROM users WHERE email ILIKE $1 OR phone ILIKE $1 ORDER BY user_id',
      [`%${search}%`]
    );
    return rows;
  }
  const { rows } = await pool.query('SELECT user_id, email, phone FROM users ORDER BY user_id');
  return rows;
}
