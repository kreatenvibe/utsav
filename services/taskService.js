import { pool } from '../db/pool.js';
import { colonyIdForFestival, assertColonyMember } from './colonyMembershipService.js';

const FK_VIOLATION = '23503';
const CHECK_VIOLATION = '23514';

export async function createTask({ festival_id, title, planned_date, labor_required }, actingUserId) {
  if (!festival_id || !title) {
    const err = new Error('festival_id and title are required');
    err.status = 400;
    throw err;
  }
  const colonyId = await colonyIdForFestival(festival_id);
  if (colonyId !== null) {
    await assertColonyMember(actingUserId, colonyId);
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO tasks (festival_id, title, planned_date, labor_required)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [festival_id, title, planned_date ?? null, labor_required ?? null]
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

export async function listTasks({ festival_id, status } = {}) {
  const conditions = [];
  const params = [];
  if (festival_id) {
    params.push(festival_id);
    conditions.push(`festival_id = $${params.length}`);
  }
  if (status) {
    params.push(status);
    conditions.push(`status = $${params.length}`);
  }
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT * FROM tasks${where} ORDER BY task_id`,
    params
  );
  return rows;
}

export async function getTask(id) {
  const { rows } = await pool.query('SELECT * FROM tasks WHERE task_id = $1', [id]);
  if (!rows[0]) {
    const err = new Error('task not found');
    err.status = 404;
    throw err;
  }
  return rows[0];
}

export async function updateTask(id, { title, planned_date, labor_required, status }, actingUserId) {
  const existing = await getTask(id);
  const colonyId = await colonyIdForFestival(existing.festival_id);
  await assertColonyMember(actingUserId, colonyId);
  try {
    await pool.query(
      `UPDATE tasks SET
         title = COALESCE($2, title),
         planned_date = COALESCE($3, planned_date),
         labor_required = COALESCE($4, labor_required),
         status = COALESCE($5, status)
       WHERE task_id = $1`,
      [id, title ?? null, planned_date ?? null, labor_required ?? null, status ?? null]
    );
  } catch (err) {
    if (err.code === CHECK_VIOLATION) {
      const e = new Error("status must be 'planned', 'in_progress', or 'done'");
      e.status = 400;
      throw e;
    }
    throw err;
  }
  return getTask(id);
}

export async function deleteTask(id, actingUserId) {
  const existing = await getTask(id);
  const colonyId = await colonyIdForFestival(existing.festival_id);
  await assertColonyMember(actingUserId, colonyId);
  try {
    await pool.query('DELETE FROM tasks WHERE task_id = $1', [id]);
  } catch (err) {
    if (err.code === FK_VIOLATION) {
      const e = new Error('cannot delete task with existing task_assignments; remove those first');
      e.status = 400;
      throw e;
    }
    throw err;
  }
}
