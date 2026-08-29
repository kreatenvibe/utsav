import { pool } from '../db/pool.js';
import { colonyIdForTask, assertColonyAdmin } from './colonyMembershipService.js';

const FK_VIOLATION = '23503';

const BASE_SELECT = `
  SELECT ta.*, u.name AS user_name, u.email AS user_email, u.phone AS user_phone
  FROM task_assignments ta
  JOIN users u ON u.user_id = ta.user_id
`;

function shape(row) {
  if (!row) return row;
  const { user_name, user_email, user_phone, ...rest } = row;
  return { ...rest, user: { name: user_name, email: user_email, phone: user_phone } };
}

export async function createTaskAssignment({ task_id, user_id }, actingUserId) {
  if (!task_id || !user_id) {
    const err = new Error('task_id and user_id are required');
    err.status = 400;
    throw err;
  }
  const colonyId = await colonyIdForTask(task_id);
  if (colonyId !== null) {
    await assertColonyAdmin(actingUserId, colonyId);
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO task_assignments (task_id, user_id)
       VALUES ($1, $2) RETURNING assignment_id`,
      [task_id, user_id]
    );
    return getTaskAssignment(rows[0].assignment_id);
  } catch (err) {
    if (err.code === FK_VIOLATION) {
      const e = new Error('task_id or user_id does not reference an existing row');
      e.status = 400;
      throw e;
    }
    throw err;
  }
}

export async function listTaskAssignments({ task_id, user_id } = {}) {
  const conditions = [];
  const params = [];
  if (task_id) {
    params.push(task_id);
    conditions.push(`ta.task_id = $${params.length}`);
  }
  if (user_id) {
    params.push(user_id);
    conditions.push(`ta.user_id = $${params.length}`);
  }
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `${BASE_SELECT}${where} ORDER BY ta.assignment_id`,
    params
  );
  return rows.map(shape);
}

export async function getTaskAssignment(id) {
  const { rows } = await pool.query(`${BASE_SELECT} WHERE ta.assignment_id = $1`, [id]);
  if (!rows[0]) {
    const err = new Error('task assignment not found');
    err.status = 404;
    throw err;
  }
  return shape(rows[0]);
}

export async function deleteTaskAssignment(id, actingUserId) {
  const { rows } = await pool.query('SELECT * FROM task_assignments WHERE assignment_id = $1', [id]);
  if (!rows[0]) {
    const err = new Error('task assignment not found');
    err.status = 404;
    throw err;
  }
  const colonyId = await colonyIdForTask(rows[0].task_id);
  await assertColonyAdmin(actingUserId, colonyId);
  await pool.query('DELETE FROM task_assignments WHERE assignment_id = $1', [id]);
}
