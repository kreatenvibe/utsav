import { pool } from '../db/pool.js';
import { parseRoster } from './rosterParser.js';
import { assertAdminOfAnyColony } from './colonyMembershipService.js';

export async function createDonor({ name, phone }, actingUserId) {
  await assertAdminOfAnyColony(actingUserId);
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

export async function listDonors({ search } = {}) {
  if (search) {
    const { rows } = await pool.query(
      'SELECT * FROM donors WHERE name ILIKE $1 OR phone ILIKE $1 ORDER BY donor_id',
      [`%${search}%`]
    );
    return rows;
  }
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

export async function bulkImportDonors(file, actingUserId) {
  await assertAdminOfAnyColony(actingUserId);
  if (!file) {
    const err = new Error('file is required');
    err.status = 400;
    throw err;
  }

  const rows = await parseRoster(file);

  const created = [];
  const skipped = [];
  const errors = [];

  for (let i = 0; i < rows.length; i++) {
    const rowNumber = i + 1;
    const row = rows[i];
    const name = row.name?.trim();
    const phone = row.phone?.trim() || null;

    if (!name) {
      errors.push({ row: rowNumber, name: null, reason: 'name is required' });
      continue;
    }

    try {
      const { rows: donorRows } = await pool.query(
        'INSERT INTO donors (name, phone) VALUES ($1, $2) RETURNING donor_id',
        [name, phone]
      );
      created.push({ row: rowNumber, donor_id: donorRows[0].donor_id, name, phone });
    } catch (err) {
      errors.push({ row: rowNumber, name, reason: err.message });
    }
  }

  return { created, skipped, errors };
}

export async function updateDonor(id, { name, phone }, actingUserId) {
  await assertAdminOfAnyColony(actingUserId);
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
