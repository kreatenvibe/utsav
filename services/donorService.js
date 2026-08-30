import { pool } from '../db/pool.js';
import { parseRoster } from './rosterParser.js';
import { assertColonyAdmin } from './colonyMembershipService.js';

function requireColonyId(colony_id) {
  if (colony_id === undefined || colony_id === null || Number.isNaN(Number(colony_id))) {
    const err = new Error('colony_id is required and must be a number');
    err.status = 400;
    throw err;
  }
}

export async function createDonor({ colony_id, name, phone }, actingUserId) {
  requireColonyId(colony_id);
  await assertColonyAdmin(actingUserId, colony_id);
  if (!name) {
    const err = new Error('name is required');
    err.status = 400;
    throw err;
  }
  const { rows } = await pool.query(
    'INSERT INTO donors (colony_id, name, phone) VALUES ($1, $2, $3) RETURNING *',
    [colony_id, name, phone ?? null]
  );
  return rows[0];
}

export async function listDonors({ colony_id, search } = {}) {
  const conditions = [];
  const params = [];
  if (colony_id) {
    params.push(colony_id);
    conditions.push(`colony_id = $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(name ILIKE $${params.length} OR phone ILIKE $${params.length})`);
  }
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await pool.query(`SELECT * FROM donors${where} ORDER BY name ASC`, params);
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

export async function bulkImportDonors(colony_id, file, actingUserId) {
  requireColonyId(colony_id);
  await assertColonyAdmin(actingUserId, colony_id);
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
        'INSERT INTO donors (colony_id, name, phone) VALUES ($1, $2, $3) RETURNING donor_id',
        [colony_id, name, phone]
      );
      created.push({ row: rowNumber, donor_id: donorRows[0].donor_id, name, phone });
    } catch (err) {
      errors.push({ row: rowNumber, name, reason: err.message });
    }
  }

  return { created, skipped, errors };
}

export async function updateDonor(id, { name, phone }, actingUserId) {
  const donor = await getDonor(id);
  await assertColonyAdmin(actingUserId, donor.colony_id);
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
