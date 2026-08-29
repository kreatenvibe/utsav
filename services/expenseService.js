import { pool } from '../db/pool.js';
import { colonyIdForFestival, assertColonyAdmin } from './colonyMembershipService.js';

const FK_VIOLATION = '23503';

const BASE_SELECT = `
  SELECT e.*, COALESCE(SUM(ep.amount), 0) AS total_paid
  FROM expenses e
  LEFT JOIN expense_payments ep ON ep.expense_id = e.expense_id AND ep.deleted_at IS NULL
`;
const GROUP_BY = ' GROUP BY e.expense_id ORDER BY e.expense_id';

export async function createExpense({ festival_id, purpose, vendor_name, amount_planned }, actingUserId) {
  if (!festival_id || !amount_planned) {
    const err = new Error('festival_id and amount_planned are required');
    err.status = 400;
    throw err;
  }
  const colonyId = await colonyIdForFestival(festival_id);
  if (colonyId !== null) {
    await assertColonyAdmin(actingUserId, colonyId);
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO expenses (festival_id, purpose, vendor_name, amount_planned)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [festival_id, purpose ?? null, vendor_name ?? null, amount_planned]
    );
    return rows[0];
  } catch (err) {
    if (err.code === FK_VIOLATION) {
      const e = new Error('festival_id does not reference an existing row');
      e.status = 400;
      throw e;
    }
    throw err;
  }
}

export async function listExpenses({ festival_id, status } = {}) {
  const conditions = ['e.deleted_at IS NULL'];
  const params = [];
  if (festival_id) {
    params.push(festival_id);
    conditions.push(`e.festival_id = $${params.length}`);
  }
  if (status) {
    params.push(status);
    conditions.push(`e.status = $${params.length}`);
  }
  const where = ` WHERE ${conditions.join(' AND ')}`;
  const { rows } = await pool.query(BASE_SELECT + where + GROUP_BY, params);
  return rows;
}

export async function getExpense(id) {
  const { rows } = await pool.query(
    BASE_SELECT + ' WHERE e.expense_id = $1 AND e.deleted_at IS NULL' + GROUP_BY,
    [id]
  );
  if (!rows[0]) {
    const err = new Error('expense not found');
    err.status = 404;
    throw err;
  }
  return rows[0];
}

export async function deleteExpense(id, actingUserId) {
  const existing = await getExpense(id);
  const colonyId = await colonyIdForFestival(existing.festival_id);
  await assertColonyAdmin(actingUserId, colonyId);
  await pool.query('UPDATE expenses SET deleted_at = now() WHERE expense_id = $1', [id]);
}

export async function updateExpense(id, { purpose, vendor_name, amount_planned, status }, actingUserId) {
  const existing = await getExpense(id);
  const colonyId = await colonyIdForFestival(existing.festival_id);
  await assertColonyAdmin(actingUserId, colonyId);
  if (status && !['open', 'settled'].includes(status)) {
    const err = new Error("status must be 'open' or 'settled'");
    err.status = 400;
    throw err;
  }
  await pool.query(
    `UPDATE expenses SET
       purpose = COALESCE($2, purpose),
       vendor_name = COALESCE($3, vendor_name),
       amount_planned = COALESCE($4, amount_planned),
       status = COALESCE($5, status)
     WHERE expense_id = $1`,
    [id, purpose ?? null, vendor_name ?? null, amount_planned ?? null, status ?? null]
  );
  return getExpense(id);
}
