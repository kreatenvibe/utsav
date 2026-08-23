import { pool } from '../db/pool.js';

const UNIQUE_VIOLATION = '23505';

function forbidden(message) {
  const err = new Error(message);
  err.status = 403;
  return err;
}

export async function colonyExists(colonyId) {
  const { rows } = await pool.query('SELECT 1 FROM colony WHERE colony_id = $1', [colonyId]);
  return rows.length > 0;
}

export async function isColonyMember(userId, colonyId) {
  const { rows } = await pool.query(
    'SELECT 1 FROM colony_memberships WHERE colony_id = $1 AND user_id = $2',
    [colonyId, userId]
  );
  return rows.length > 0;
}

export async function isColonyAdmin(userId, colonyId) {
  const { rows } = await pool.query(
    "SELECT 1 FROM colony_memberships WHERE colony_id = $1 AND user_id = $2 AND role = 'admin'",
    [colonyId, userId]
  );
  return rows.length > 0;
}

export async function assertColonyMember(userId, colonyId) {
  if (!(await isColonyMember(userId, colonyId))) {
    throw forbidden('you are not a member of this colony');
  }
}

export async function assertColonyAdmin(userId, colonyId) {
  if (!(await isColonyAdmin(userId, colonyId))) {
    throw forbidden('you must be an admin of this colony to do that');
  }
}

export async function colonyIdForFestival(festivalId) {
  const { rows } = await pool.query('SELECT colony_id FROM festival WHERE festival_id = $1', [festivalId]);
  return rows[0]?.colony_id ?? null;
}

export async function colonyIdForExpense(expenseId) {
  const { rows } = await pool.query(
    `SELECT f.colony_id FROM expenses e
     JOIN festival f ON f.festival_id = e.festival_id
     WHERE e.expense_id = $1`,
    [expenseId]
  );
  return rows[0]?.colony_id ?? null;
}

export async function colonyIdForTask(taskId) {
  const { rows } = await pool.query(
    `SELECT f.colony_id FROM tasks t
     JOIN festival f ON f.festival_id = t.festival_id
     WHERE t.task_id = $1`,
    [taskId]
  );
  return rows[0]?.colony_id ?? null;
}

export async function colonyIdForExpectedDonation(expectedId) {
  const { rows } = await pool.query(
    `SELECT f.colony_id FROM expected_donations ed
     JOIN festival f ON f.festival_id = ed.festival_id
     WHERE ed.expected_id = $1`,
    [expectedId]
  );
  return rows[0]?.colony_id ?? null;
}

export async function listMyColonies(userId) {
  const { rows } = await pool.query(
    `SELECT c.*, cm.role
     FROM colony c
     JOIN colony_memberships cm ON cm.colony_id = c.colony_id
     WHERE cm.user_id = $1
     ORDER BY c.colony_id`,
    [userId]
  );
  return rows;
}

export async function listColonyMembers(colonyId) {
  const { rows } = await pool.query(
    `SELECT cm.colony_membership_id, cm.user_id, u.email, cm.role, cm.created_at
     FROM colony_memberships cm
     JOIN users u ON u.user_id = cm.user_id
     WHERE cm.colony_id = $1
     ORDER BY cm.colony_membership_id`,
    [colonyId]
  );
  return rows;
}

async function isSoleAdmin(colonyId, userId) {
  const { rows } = await pool.query(
    `SELECT role, (SELECT COUNT(*) FROM colony_memberships WHERE colony_id = $1 AND role = 'admin') AS admin_count
     FROM colony_memberships WHERE colony_id = $1 AND user_id = $2`,
    [colonyId, userId]
  );
  const membership = rows[0];
  return membership?.role === 'admin' && Number(membership.admin_count) <= 1;
}

export async function addMember(colonyId, actingUserId, { email, role = 'member' }) {
  await assertColonyAdmin(actingUserId, colonyId);
  if (!email) {
    const err = new Error('email is required');
    err.status = 400;
    throw err;
  }
  if (!['admin', 'member'].includes(role)) {
    const err = new Error("role must be 'admin' or 'member'");
    err.status = 400;
    throw err;
  }
  const { rows: userRows } = await pool.query('SELECT user_id FROM users WHERE email = $1', [email]);
  if (!userRows[0]) {
    const err = new Error('no registered user with that email');
    err.status = 404;
    throw err;
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO colony_memberships (colony_id, user_id, role)
       VALUES ($1, $2, $3) RETURNING colony_membership_id, colony_id, user_id, role, created_at`,
      [colonyId, userRows[0].user_id, role]
    );
    return rows[0];
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) {
      const e = new Error('that user is already a member of this colony');
      e.status = 409;
      throw e;
    }
    throw err;
  }
}

export async function updateMemberRole(colonyId, actingUserId, targetUserId, role) {
  await assertColonyAdmin(actingUserId, colonyId);
  if (!['admin', 'member'].includes(role)) {
    const err = new Error("role must be 'admin' or 'member'");
    err.status = 400;
    throw err;
  }
  if (role === 'member' && (await isSoleAdmin(colonyId, targetUserId))) {
    const err = new Error('cannot remove the last admin of a colony');
    err.status = 400;
    throw err;
  }
  const { rows } = await pool.query(
    `UPDATE colony_memberships SET role = $3
     WHERE colony_id = $1 AND user_id = $2
     RETURNING colony_membership_id, colony_id, user_id, role, created_at`,
    [colonyId, targetUserId, role]
  );
  if (!rows[0]) {
    const err = new Error('membership not found');
    err.status = 404;
    throw err;
  }
  return rows[0];
}

export async function removeMember(colonyId, actingUserId, targetUserId) {
  await assertColonyAdmin(actingUserId, colonyId);
  if (await isSoleAdmin(colonyId, targetUserId)) {
    const err = new Error('cannot remove the last admin of a colony');
    err.status = 400;
    throw err;
  }
  const { rowCount } = await pool.query(
    'DELETE FROM colony_memberships WHERE colony_id = $1 AND user_id = $2',
    [colonyId, targetUserId]
  );
  if (!rowCount) {
    const err = new Error('membership not found');
    err.status = 404;
    throw err;
  }
}
