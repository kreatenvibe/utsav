import { pool } from '../db/pool.js';

const FK_VIOLATION = '23503';

export async function createAvailability({ member_id, date, is_available }) {
  if (!member_id || !date || typeof is_available !== 'boolean') {
    const err = new Error('member_id, date, and is_available (boolean) are required');
    err.status = 400;
    throw err;
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO availability (member_id, date, is_available)
       VALUES ($1, $2, $3) RETURNING *`,
      [member_id, date, is_available]
    );
    return rows[0];
  } catch (err) {
    if (err.code === FK_VIOLATION) {
      const e = new Error('member_id does not reference an existing row');
      e.status = 400;
      throw e;
    }
    throw err;
  }
}

export async function listAvailability({ member_id, date } = {}) {
  const conditions = [];
  const params = [];
  if (member_id) {
    params.push(member_id);
    conditions.push(`member_id = $${params.length}`);
  }
  if (date) {
    params.push(date);
    conditions.push(`date = $${params.length}`);
  }
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT * FROM availability${where} ORDER BY availability_id`,
    params
  );
  return rows;
}

export async function getAvailability(id) {
  const { rows } = await pool.query('SELECT * FROM availability WHERE availability_id = $1', [id]);
  if (!rows[0]) {
    const err = new Error('availability not found');
    err.status = 404;
    throw err;
  }
  return rows[0];
}

export async function updateAvailability(id, { is_available }) {
  await getAvailability(id);
  if (typeof is_available !== 'boolean') {
    const err = new Error('is_available (boolean) is required');
    err.status = 400;
    throw err;
  }
  await pool.query(
    'UPDATE availability SET is_available = $2 WHERE availability_id = $1',
    [id, is_available]
  );
  return getAvailability(id);
}

export async function deleteAvailability(id) {
  await getAvailability(id);
  await pool.query('DELETE FROM availability WHERE availability_id = $1', [id]);
}
