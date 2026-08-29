import bcrypt from 'bcryptjs';
import { pool } from '../db/pool.js';
import { parseRoster } from './rosterParser.js';

const UNIQUE_VIOLATION = '23505';
const SALT_ROUNDS = 10;

function forbidden(message) {
  const err = new Error(message);
  err.status = 403;
  return err;
}

export async function colonyExists(colonyId) {
  const { rows } = await pool.query('SELECT 1 FROM colony WHERE colony_id = $1', [colonyId]);
  return rows.length > 0;
}

export async function isColonyAdmin(userId, colonyId) {
  const { rows } = await pool.query(
    "SELECT 1 FROM colony_memberships WHERE colony_id = $1 AND user_id = $2 AND role = 'admin'",
    [colonyId, userId]
  );
  return rows.length > 0;
}

export async function assertColonyAdmin(userId, colonyId) {
  if (!(await isColonyAdmin(userId, colonyId))) {
    throw forbidden('you must be an admin of this colony to do that');
  }
}

export async function isAdminOfAnyColony(userId) {
  const { rows } = await pool.query(
    "SELECT 1 FROM colony_memberships WHERE user_id = $1 AND role = 'admin' LIMIT 1",
    [userId]
  );
  return rows.length > 0;
}

export async function assertAdminOfAnyColony(userId) {
  if (!(await isAdminOfAnyColony(userId))) {
    throw forbidden('you must be an admin of at least one colony to do that');
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
    `SELECT cm.colony_membership_id, cm.user_id, u.name, u.phone, cm.role, cm.created_at
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

// Shared by addMember (single) and bulkAddMembers (per-row) — caller is
// responsible for the assertColonyAdmin check, done once per request rather
// than once per row for bulk. Create-or-link: an identifier that already
// resolves to a users row is linked as-is (name/password ignored, never
// mutating an existing account as a side effect); one that doesn't resolve
// requires name+password to create a fresh account.
export async function upsertMembership(colonyId, { name, phone, password, role = 'member' }) {
  if (!phone) {
    const err = new Error('phone is required');
    err.status = 400;
    throw err;
  }
  if (!['admin', 'member'].includes(role)) {
    const err = new Error("role must be 'admin' or 'member'");
    err.status = 400;
    throw err;
  }

  const { rows: existingRows } = await pool.query(
    'SELECT user_id, name, phone FROM users WHERE phone = $1',
    [phone]
  );

  let user = existingRows[0];
  let account;

  if (user) {
    account = 'linked';
  } else {
    if (!name) {
      const err = new Error('name is required to create a new account');
      err.status = 400;
      throw err;
    }
    if (!password) {
      const err = new Error('password is required to create a new account');
      err.status = 400;
      throw err;
    }
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const { rows } = await pool.query(
      'INSERT INTO users (name, phone, password_hash) VALUES ($1, $2, $3) RETURNING user_id, name, phone',
      [name, phone, passwordHash]
    );
    user = rows[0];
    account = 'created';
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO colony_memberships (colony_id, user_id, role)
       VALUES ($1, $2, $3) RETURNING colony_membership_id, colony_id, user_id, role, created_at`,
      [colonyId, user.user_id, role]
    );
    return { ...rows[0], name: user.name, phone: user.phone, account };
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) {
      const e = new Error('that user is already a member of this colony');
      e.status = 409;
      throw e;
    }
    throw err;
  }
}

export async function addMember(colonyId, actingUserId, body) {
  await assertColonyAdmin(actingUserId, colonyId);
  return upsertMembership(colonyId, body);
}

export async function bulkAddMembers(colonyId, actingUserId, { file, initial_password } = {}) {
  if (!file) {
    const err = new Error('file is required');
    err.status = 400;
    throw err;
  }
  await assertColonyAdmin(actingUserId, colonyId);

  const rows = await parseRoster(file);

  const created = [];
  const skipped = [];
  const errors = [];

  for (let i = 0; i < rows.length; i++) {
    const rowNumber = i + 1;
    const row = rows[i];
    const name = row.name?.trim() || null;
    const phone = row.phone?.trim() || null;
    const password = row.password?.trim() || initial_password?.trim() || null;
    const role = row.role?.trim() || 'member';

    if (!name) {
      errors.push({ row: rowNumber, phone, reason: 'name is required' });
      continue;
    }

    try {
      const membership = await upsertMembership(colonyId, { name, phone, password, role });
      created.push({ row: rowNumber, ...membership });
    } catch (err) {
      if (err.status === 409) {
        skipped.push({ row: rowNumber, phone, reason: err.message });
      } else {
        errors.push({ row: rowNumber, phone, reason: err.message });
      }
    }
  }

  return { created, skipped, errors };
}

export async function resetMemberPassword(colonyId, actingUserId, targetUserId, { password }) {
  await assertColonyAdmin(actingUserId, colonyId);
  if (!password) {
    const err = new Error('password is required');
    err.status = 400;
    throw err;
  }
  const { rows } = await pool.query(
    'SELECT 1 FROM colony_memberships WHERE colony_id = $1 AND user_id = $2',
    [colonyId, targetUserId]
  );
  if (!rows[0]) {
    const err = new Error('membership not found');
    err.status = 404;
    throw err;
  }
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  await pool.query('UPDATE users SET password_hash = $2 WHERE user_id = $1', [targetUserId, passwordHash]);
  return { user_id: Number(targetUserId) };
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
