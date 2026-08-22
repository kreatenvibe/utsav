import { pool } from '../db/pool.js';

const FK_VIOLATION = '23503';

export async function createExpensePayment({ expense_id, amount, date, paid_by }) {
  if (!expense_id || !amount || !date) {
    const err = new Error('expense_id, amount, and date are required');
    err.status = 400;
    throw err;
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO expense_payments (expense_id, amount, date, paid_by)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [expense_id, amount, date, paid_by ?? null]
    );
    return rows[0];
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
  const conditions = ['deleted_at IS NULL'];
  const params = [];
  if (expense_id) {
    params.push(expense_id);
    conditions.push(`expense_id = $${params.length}`);
  }
  const { rows } = await pool.query(
    `SELECT * FROM expense_payments WHERE ${conditions.join(' AND ')} ORDER BY payment_id`,
    params
  );
  return rows;
}

export async function getExpensePayment(id) {
  const { rows } = await pool.query(
    'SELECT * FROM expense_payments WHERE payment_id = $1 AND deleted_at IS NULL',
    [id]
  );
  if (!rows[0]) {
    const err = new Error('expense payment not found');
    err.status = 404;
    throw err;
  }
  return rows[0];
}

export async function deleteExpensePayment(id) {
  await getExpensePayment(id);
  await pool.query('UPDATE expense_payments SET deleted_at = now() WHERE payment_id = $1', [id]);
}
