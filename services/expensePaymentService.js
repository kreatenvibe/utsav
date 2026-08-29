import { pool } from '../db/pool.js';
import { colonyIdForExpense, assertColonyAdmin } from './colonyMembershipService.js';

const FK_VIOLATION = '23503';

const BASE_SELECT = `
  SELECT ep.*, u.user_id AS payer_user_id, u.name AS payer_name,
    u.email AS payer_email, u.phone AS payer_phone
  FROM expense_payments ep
  LEFT JOIN users u ON u.user_id = ep.paid_by
`;

function shape(row) {
  if (!row) return row;
  const { payer_user_id, payer_name, payer_email, payer_phone, ...rest } = row;
  return {
    ...rest,
    payer: payer_user_id
      ? { user_id: payer_user_id, name: payer_name, email: payer_email, phone: payer_phone }
      : null,
  };
}

export async function createExpensePayment({ expense_id, amount, date, paid_by }, actingUserId) {
  if (!expense_id || !amount || !date) {
    const err = new Error('expense_id, amount, and date are required');
    err.status = 400;
    throw err;
  }
  const colonyId = await colonyIdForExpense(expense_id);
  if (colonyId !== null) {
    await assertColonyAdmin(actingUserId, colonyId);
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO expense_payments (expense_id, amount, date, paid_by)
       VALUES ($1, $2, $3, $4) RETURNING payment_id`,
      [expense_id, amount, date, paid_by ?? null]
    );
    return getExpensePayment(rows[0].payment_id);
  } catch (err) {
    if (err.code === FK_VIOLATION) {
      const e = new Error('expense_id or paid_by does not reference an existing row');
      e.status = 400;
      throw e;
    }
    throw err;
  }
}

export async function listExpensePayments({ expense_id } = {}) {
  const conditions = ['ep.deleted_at IS NULL'];
  const params = [];
  if (expense_id) {
    params.push(expense_id);
    conditions.push(`ep.expense_id = $${params.length}`);
  }
  const { rows } = await pool.query(
    `${BASE_SELECT} WHERE ${conditions.join(' AND ')} ORDER BY ep.payment_id`,
    params
  );
  return rows.map(shape);
}

export async function getExpensePayment(id) {
  const { rows } = await pool.query(
    `${BASE_SELECT} WHERE ep.payment_id = $1 AND ep.deleted_at IS NULL`,
    [id]
  );
  if (!rows[0]) {
    const err = new Error('expense payment not found');
    err.status = 404;
    throw err;
  }
  return shape(rows[0]);
}

export async function deleteExpensePayment(id, actingUserId) {
  const { rows } = await pool.query(
    'SELECT * FROM expense_payments WHERE payment_id = $1 AND deleted_at IS NULL',
    [id]
  );
  if (!rows[0]) {
    const err = new Error('expense payment not found');
    err.status = 404;
    throw err;
  }
  const colonyId = await colonyIdForExpense(rows[0].expense_id);
  await assertColonyAdmin(actingUserId, colonyId);
  await pool.query('UPDATE expense_payments SET deleted_at = now() WHERE payment_id = $1', [id]);
}
