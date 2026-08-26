import { pool } from '../db/pool.js';
import { colonyExists, assertColonyAdmin } from './colonyMembershipService.js';

const FK_VIOLATION = '23503';
const UNIQUE_VIOLATION = '23505';

export async function createMember({ name, phone, colony_id }, actingUserId) {
  if (!name) {
    const err = new Error('name is required');
    err.status = 400;
    throw err;
  }
  if (colony_id && (await colonyExists(colony_id))) {
    await assertColonyAdmin(actingUserId, colony_id);
  }
  try {
    const { rows } = await pool.query(
      'INSERT INTO members (name, phone, colony_id) VALUES ($1, $2, $3) RETURNING *',
      [name, phone ?? null, colony_id ?? null]
    );
    return rows[0];
  } catch (err) {
    if (err.code === FK_VIOLATION) {
      const e = new Error('colony_id does not reference an existing colony');
      e.status = 400;
      throw e;
    }
    if (err.code === UNIQUE_VIOLATION) {
      const e = new Error('a member with that phone already exists in this colony');
      e.status = 409;
      throw e;
    }
    throw err;
  }
}

export async function listMembers({ colony_id } = {}) {
  if (colony_id) {
    const { rows } = await pool.query(
      'SELECT * FROM members WHERE colony_id = $1 ORDER BY member_id',
      [colony_id]
    );
    return rows;
  }
  const { rows } = await pool.query('SELECT * FROM members ORDER BY member_id');
  return rows;
}

export async function getMember(id) {
  const { rows } = await pool.query('SELECT * FROM members WHERE member_id = $1', [id]);
  if (!rows[0]) {
    const err = new Error('member not found');
    err.status = 404;
    throw err;
  }
  return rows[0];
}

export async function updateMember(id, { name, phone }) {
  await getMember(id);
  const { rows } = await pool.query(
    `UPDATE members SET
       name = COALESCE($2, name),
       phone = COALESCE($3, phone)
     WHERE member_id = $1
     RETURNING *`,
    [id, name ?? null, phone ?? null]
  );
  return rows[0];
}
