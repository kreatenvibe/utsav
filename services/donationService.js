import { pool } from '../db/pool.js';
import { colonyIdForExpectedDonation, assertColonyAdmin, assertAdminOfAnyColony } from './colonyMembershipService.js';

const FK_VIOLATION = '23503';

const BASE_SELECT = `
  SELECT d.*, u.user_id AS collector_user_id, u.name AS collector_name,
    u.phone AS collector_phone
  FROM donations d
  LEFT JOIN users u ON u.user_id = d.collected_by
`;

function shape(row) {
  if (!row) return row;
  const { collector_user_id, collector_name, collector_phone, ...rest } = row;
  return {
    ...rest,
    collector: collector_user_id
      ? { user_id: collector_user_id, name: collector_name, phone: collector_phone }
      : null,
  };
}

export async function createDonation({ donor_id, expected_id, amount, date, collected_by }, actingUserId) {
  if (!donor_id || !amount || !date) {
    const err = new Error('donor_id, amount, and date are required');
    err.status = 400;
    throw err;
  }
  if (expected_id) {
    const colonyId = await colonyIdForExpectedDonation(expected_id);
    if (colonyId !== null) {
      await assertColonyAdmin(actingUserId, colonyId);
    }
  } else {
    await assertAdminOfAnyColony(actingUserId);
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO donations (donor_id, expected_id, amount, date, collected_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING donation_id`,
      [donor_id, expected_id ?? null, amount, date, collected_by ?? null]
    );
    return getDonation(rows[0].donation_id);
  } catch (err) {
    if (err.code === FK_VIOLATION) {
      const e = new Error('donor_id, expected_id, or collected_by does not reference an existing row');
      e.status = 400;
      throw e;
    }
    throw err;
  }
}

export async function listDonations({ donor_id, expected_id } = {}) {
  const conditions = ['d.deleted_at IS NULL'];
  const params = [];
  if (donor_id) {
    params.push(donor_id);
    conditions.push(`d.donor_id = $${params.length}`);
  }
  if (expected_id) {
    params.push(expected_id);
    conditions.push(`d.expected_id = $${params.length}`);
  }
  const { rows } = await pool.query(
    `${BASE_SELECT} WHERE ${conditions.join(' AND ')} ORDER BY d.donation_id`,
    params
  );
  return rows.map(shape);
}

export async function getDonation(id) {
  const { rows } = await pool.query(
    `${BASE_SELECT} WHERE d.donation_id = $1 AND d.deleted_at IS NULL`,
    [id]
  );
  if (!rows[0]) {
    const err = new Error('donation not found');
    err.status = 404;
    throw err;
  }
  return shape(rows[0]);
}

export async function deleteDonation(id, actingUserId) {
  const { rows } = await pool.query(
    'SELECT * FROM donations WHERE donation_id = $1 AND deleted_at IS NULL',
    [id]
  );
  if (!rows[0]) {
    const err = new Error('donation not found');
    err.status = 404;
    throw err;
  }
  const existing = rows[0];
  if (existing.expected_id) {
    const colonyId = await colonyIdForExpectedDonation(existing.expected_id);
    if (colonyId !== null) {
      await assertColonyAdmin(actingUserId, colonyId);
    }
  } else {
    await assertAdminOfAnyColony(actingUserId);
  }
  await pool.query('UPDATE donations SET deleted_at = now() WHERE donation_id = $1', [id]);
}
