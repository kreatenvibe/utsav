import { pool } from '../db/pool.js';

export async function createDonor({ name, phone }) {
  if (!name) {
    const err = new Error('name is required');
    err.status = 400;
    throw err;
  }
  const { rows } = await pool.query(
    'INSERT INTO donors (name, phone) VALUES ($1, $2) RETURNING *',
    [name, phone ?? null]
  );
  return rows[0];
}

export async function listDonors() {
  const { rows } = await pool.query('SELECT * FROM donors ORDER BY donor_id');
  return rows;
}

export async function getDonor(id) {
  const { rows } = await pool.query('SELECT * FROM donors WHERE donor_id = $1', [id]);
  if (!rows[0]) {
    const err = new Error('donor not found');
    err.status = 404;
    throw err;
  }
  return rows[0];
}

export async function updateDonor(id, { name, phone }) {
  await getDonor(id);
  const { rows } = await pool.query(
    `UPDATE donors SET
       name = COALESCE($2, name),
       phone = COALESCE($3, phone)
     WHERE donor_id = $1
     RETURNING *`,
    [id, name ?? null, phone ?? null]
  );
  return rows[0];
}
