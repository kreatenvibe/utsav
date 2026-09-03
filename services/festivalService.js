import { pool } from '../db/pool.js';
import { colonyExists, assertColonyAdmin } from './colonyMembershipService.js';

const FK_VIOLATION = '23503';

const BASE_SELECT = `
  SELECT f.*,
    COALESCE((
      SELECT SUM(d.amount) FROM donations d
      JOIN expected_donations ed ON ed.expected_id = d.expected_id
      WHERE ed.festival_id = f.festival_id AND d.deleted_at IS NULL
    ), 0)
    +
    COALESCE((
      SELECT SUM(d2.amount) FROM donations d2
      WHERE d2.festival_id = f.festival_id AND d2.expected_id IS NULL AND d2.deleted_at IS NULL
    ), 0)
    -
    COALESCE((
      SELECT SUM(ep.amount) FROM expense_payments ep
      JOIN expenses e ON e.expense_id = ep.expense_id
      WHERE e.festival_id = f.festival_id AND ep.deleted_at IS NULL AND e.deleted_at IS NULL
    ), 0) AS current_balance
  FROM festival f
`;

export async function createFestival({ colony_id, name, year }, actingUserId) {
  if (!colony_id || !name || !year) {
    const err = new Error('colony_id, name, and year are required');
    err.status = 400;
    throw err;
  }
  if (await colonyExists(colony_id)) {
    await assertColonyAdmin(actingUserId, colony_id);
  }
  try {
    const { rows } = await pool.query(
      'INSERT INTO festival (colony_id, name, year) VALUES ($1, $2, $3) RETURNING *',
      [colony_id, name, year]
    );
    return rows[0];
  } catch (err) {
    if (err.code === FK_VIOLATION) {
      const e = new Error('colony_id does not reference an existing colony');
      e.status = 400;
      throw e;
    }
    throw err;
  }
}

export async function listFestivals({ colony_id } = {}) {
  if (colony_id) {
    const { rows } = await pool.query(
      BASE_SELECT + ' WHERE f.colony_id = $1 ORDER BY f.festival_id',
      [colony_id]
    );
    return rows;
  }
  const { rows } = await pool.query(BASE_SELECT + ' ORDER BY f.festival_id');
  return rows;
}

export async function getFestival(id) {
  const { rows } = await pool.query(BASE_SELECT + ' WHERE f.festival_id = $1', [id]);
  if (!rows[0]) {
    const err = new Error('festival not found');
    err.status = 404;
    throw err;
  }
  return rows[0];
}

export async function updateFestival(id, { name, year }, actingUserId) {
  const existing = await getFestival(id);
  await assertColonyAdmin(actingUserId, existing.colony_id);
  await pool.query(
    `UPDATE festival SET
       name = COALESCE($2, name),
       year = COALESCE($3, year)
     WHERE festival_id = $1`,
    [id, name ?? null, year ?? null]
  );
  return getFestival(id);
}
