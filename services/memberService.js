import { pool } from '../db/pool.js';

export async function createMember({ name, phone }) {
  if (!name) {
    const err = new Error('name is required');
    err.status = 400;
    throw err;
  }
  const { rows } = await pool.query(
    'INSERT INTO members (name, phone) VALUES ($1, $2) RETURNING *',
    [name, phone ?? null]
  );
  return rows[0];
}

export async function listMembers() {
  const { rows } = await pool.query('SELECT * FROM members ORDER BY member_id');
  return rows;
}

export async function getMember(id) {
  const { rows } = await pool.query('SELECT * FROM members WHERE member_id = $1', [id]);
  if (!rows[0]) {
    const err = new Error('member not found');
    err.status = 404;
    throw err;
  }
  return rows[0];
}

export async function updateMember(id, { name, phone }) {
  await getMember(id);
  const { rows } = await pool.query(
    `UPDATE members SET
       name = COALESCE($2, name),
       phone = COALESCE($3, phone)
     WHERE member_id = $1
     RETURNING *`,
    [id, name ?? null, phone ?? null]
  );
  return rows[0];
}
