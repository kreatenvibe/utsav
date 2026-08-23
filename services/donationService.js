import { pool } from '../db/pool.js';
import { colonyIdForExpectedDonation, assertColonyMember } from './colonyMembershipService.js';

const FK_VIOLATION = '23503';

export async function createDonation({ donor_id, expected_id, amount, date, collected_by }, actingUserId) {
  if (!donor_id || !amount || !date) {
    const err = new Error('donor_id, amount, and date are required');
    err.status = 400;
    throw err;
  }
  if (expected_id) {
    const colonyId = await colonyIdForExpectedDonation(expected_id);
    if (colonyId !== null) {
      await assertColonyMember(actingUserId, colonyId);
    }
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO donations (donor_id, expected_id, amount, date, collected_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [donor_id, expected_id ?? null, amount, date, collected_by ?? null]
    );
    return rows[0];
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
  const conditions = ['deleted_at IS NULL'];
  const params = [];
  if (donor_id) {
    params.push(donor_id);
    conditions.push(`donor_id = $${params.length}`);
  }
  if (expected_id) {
    params.push(expected_id);
    conditions.push(`expected_id = $${params.length}`);
  }
  const { rows } = await pool.query(
    `SELECT * FROM donations WHERE ${conditions.join(' AND ')} ORDER BY donation_id`,
    params
  );
  return rows;
}

export async function getDonation(id) {
  const { rows } = await pool.query(
    'SELECT * FROM donations WHERE donation_id = $1 AND deleted_at IS NULL',
    [id]
  );
  if (!rows[0]) {
    const err = new Error('donation not found');
    err.status = 404;
    throw err;
  }
  return rows[0];
}

export async function deleteDonation(id, actingUserId) {
  const existing = await getDonation(id);
  if (existing.expected_id) {
    const colonyId = await colonyIdForExpectedDonation(existing.expected_id);
    if (colonyId !== null) {
      await assertColonyMember(actingUserId, colonyId);
    }
  }
  await pool.query('UPDATE donations SET deleted_at = now() WHERE donation_id = $1', [id]);
}
