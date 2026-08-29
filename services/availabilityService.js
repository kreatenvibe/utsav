import { pool } from '../db/pool.js';
import { assertAdminOfAnyColony } from './colonyMembershipService.js';

const FK_VIOLATION = '23503';

const BASE_SELECT = `
  SELECT av.*, u.name AS user_name, u.email AS user_email, u.phone AS user_phone
  FROM availability av
  JOIN users u ON u.user_id = av.user_id
`;

function shape(row) {
  if (!row) return row;
  const { user_name, user_email, user_phone, ...rest } = row;
  return { ...rest, user: { name: user_name, email: user_email, phone: user_phone } };
}

export async function createAvailability({ user_id, date, is_available }, actingUserId) {
  if (!user_id || !date || typeof is_available !== 'boolean') {
    const err = new Error('user_id, date, and is_available (boolean) are required');
    err.status = 400;
    throw err;
  }
  await assertAdminOfAnyColony(actingUserId);
  try {
    const { rows } = await pool.query(
      `INSERT INTO availability (user_id, date, is_available)
       VALUES ($1, $2, $3) RETURNING availability_id`,
      [user_id, date, is_available]
    );
    return getAvailability(rows[0].availability_id);
  } catch (err) {
    if (err.code === FK_VIOLATION) {
      const e = new Error('user_id does not reference an existing row');
      e.status = 400;
      throw e;
    }
    throw err;
  }
}

export async function listAvailability({ user_id, date } = {}) {
  const conditions = [];
  const params = [];
  if (user_id) {
    params.push(user_id);
    conditions.push(`av.user_id = $${params.length}`);
  }
  if (date) {
    params.push(date);
    conditions.push(`av.date = $${params.length}`);
  }
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `${BASE_SELECT}${where} ORDER BY av.availability_id`,
    params
  );
  return rows.map(shape);
}

export async function getAvailability(id) {
  const { rows } = await pool.query(`${BASE_SELECT} WHERE av.availability_id = $1`, [id]);
  if (!rows[0]) {
    const err = new Error('availability not found');
    err.status = 404;
    throw err;
  }
  return shape(rows[0]);
}

export async function updateAvailability(id, { is_available }, actingUserId) {
  await getAvailability(id);
  await assertAdminOfAnyColony(actingUserId);
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

export async function deleteAvailability(id, actingUserId) {
  await getAvailability(id);
  await assertAdminOfAnyColony(actingUserId);
  await pool.query('DELETE FROM availability WHERE availability_id = $1', [id]);
}
