import { pool } from '../db/pool.js';
import { assertColonyAdmin } from './colonyMembershipService.js';

export async function createColony({ name, location }, actingUserId) {
  if (!name) {
    const err = new Error('name is required');
    err.status = 400;
    throw err;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'INSERT INTO colony (name, location) VALUES ($1, $2) RETURNING *',
      [name, location ?? null]
    );
    const colony = rows[0];
    await client.query(
      `INSERT INTO colony_memberships (colony_id, user_id, role) VALUES ($1, $2, 'admin')`,
      [colony.colony_id, actingUserId]
    );
    await client.query('COMMIT');
    return colony;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function listColonies() {
  const { rows } = await pool.query('SELECT * FROM colony ORDER BY colony_id');
  return rows;
}

export async function getColony(id) {
  const { rows } = await pool.query('SELECT * FROM colony WHERE colony_id = $1', [id]);
  if (!rows[0]) {
    const err = new Error('colony not found');
    err.status = 404;
    throw err;
  }
  return rows[0];
}

export async function updateColony(id, { name, location }, actingUserId) {
  await getColony(id);
  await assertColonyAdmin(actingUserId, id);
  const { rows } = await pool.query(
    `UPDATE colony SET
       name = COALESCE($2, name),
       location = COALESCE($3, location)
     WHERE colony_id = $1
     RETURNING *`,
    [id, name ?? null, location ?? null]
  );
  return rows[0];
}
