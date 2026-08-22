import { pool } from '../db/pool.js';

export async function createColony({ name, location }) {
  if (!name) {
    const err = new Error('name is required');
    err.status = 400;
    throw err;
  }
  const { rows } = await pool.query(
    'INSERT INTO colony (name, location) VALUES ($1, $2) RETURNING *',
    [name, location ?? null]
  );
  return rows[0];
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

export async function updateColony(id, { name, location }) {
  await getColony(id);
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
