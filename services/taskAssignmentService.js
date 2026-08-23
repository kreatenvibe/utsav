import { pool } from '../db/pool.js';
import { colonyIdForTask, assertColonyMember } from './colonyMembershipService.js';

const FK_VIOLATION = '23503';

export async function createTaskAssignment({ task_id, member_id }, actingUserId) {
  if (!task_id || !member_id) {
    const err = new Error('task_id and member_id are required');
    err.status = 400;
    throw err;
  }
  const colonyId = await colonyIdForTask(task_id);
  if (colonyId !== null) {
    await assertColonyMember(actingUserId, colonyId);
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO task_assignments (task_id, member_id)
       VALUES ($1, $2) RETURNING *`,
      [task_id, member_id]
    );
    return rows[0];
  } catch (err) {
    if (err.code === FK_VIOLATION) {
      const e = new Error('task_id or member_id does not reference an existing row');
      e.status = 400;
      throw e;
    }
    throw err;
  }
}

export async function listTaskAssignments({ task_id, member_id } = {}) {
  const conditions = [];
  const params = [];
  if (task_id) {
    params.push(task_id);
    conditions.push(`task_id = $${params.length}`);
  }
  if (member_id) {
    params.push(member_id);
    conditions.push(`member_id = $${params.length}`);
  }
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT * FROM task_assignments${where} ORDER BY assignment_id`,
    params
  );
  return rows;
}

export async function getTaskAssignment(id) {
  const { rows } = await pool.query('SELECT * FROM task_assignments WHERE assignment_id = $1', [id]);
  if (!rows[0]) {
    const err = new Error('task assignment not found');
    err.status = 404;
    throw err;
  }
  return rows[0];
}

export async function deleteTaskAssignment(id, actingUserId) {
  const existing = await getTaskAssignment(id);
  const colonyId = await colonyIdForTask(existing.task_id);
  await assertColonyMember(actingUserId, colonyId);
  await pool.query('DELETE FROM task_assignments WHERE assignment_id = $1', [id]);
}
