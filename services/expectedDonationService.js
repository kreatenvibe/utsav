import { pool } from '../db/pool.js';
import { colonyIdForFestival, assertColonyMember } from './colonyMembershipService.js';

const FK_VIOLATION = '23503';

const BASE_SELECT = `
  SELECT ed.*, COALESCE(SUM(d.amount), 0) AS total_donated
  FROM expected_donations ed
  LEFT JOIN donations d ON d.expected_id = ed.expected_id AND d.deleted_at IS NULL
`;
const GROUP_BY = ' GROUP BY ed.expected_id ORDER BY ed.expected_id';

export async function createExpectedDonation({ donor_id, festival_id, expected_amount, year, purpose }, actingUserId) {
  if (!donor_id || !festival_id || !expected_amount || !year) {
    const err = new Error('donor_id, festival_id, expected_amount, and year are required');
    err.status = 400;
    throw err;
  }
  const colonyId = await colonyIdForFestival(festival_id);
  if (colonyId !== null) {
    await assertColonyMember(actingUserId, colonyId);
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO expected_donations (donor_id, festival_id, expected_amount, year, purpose)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [donor_id, festival_id, expected_amount, year, purpose ?? null]
    );
    return rows[0];
  } catch (err) {
    if (err.code === FK_VIOLATION) {
      const e = new Error('donor_id or festival_id does not reference an existing row');
      e.status = 400;
      throw e;
    }
    throw err;
  }
}

export async function listExpectedDonations({ festival_id, donor_id, status } = {}) {
  const conditions = [];
  const params = [];
  if (festival_id) {
    params.push(festival_id);
    conditions.push(`ed.festival_id = $${params.length}`);
  }
  if (donor_id) {
    params.push(donor_id);
    conditions.push(`ed.donor_id = $${params.length}`);
  }
  if (status) {
    params.push(status);
    conditions.push(`ed.status = $${params.length}`);
  }
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await pool.query(BASE_SELECT + where + GROUP_BY, params);
  return rows;
}

export async function getExpectedDonation(id) {
  const { rows } = await pool.query(
    BASE_SELECT + ' WHERE ed.expected_id = $1' + GROUP_BY,
    [id]
  );
  if (!rows[0]) {
    const err = new Error('expected donation not found');
    err.status = 404;
    throw err;
  }
  return rows[0];
}

export async function updateExpectedDonation(id, { expected_amount, year, purpose, status }, actingUserId) {
  const existing = await getExpectedDonation(id);
  const colonyId = await colonyIdForFestival(existing.festival_id);
  await assertColonyMember(actingUserId, colonyId);
  if (status && !['open', 'closed'].includes(status)) {
    const err = new Error("status must be 'open' or 'closed'");
    err.status = 400;
    throw err;
  }
  await pool.query(
    `UPDATE expected_donations SET
       expected_amount = COALESCE($2, expected_amount),
       year = COALESCE($3, year),
       purpose = COALESCE($4, purpose),
       status = COALESCE($5, status)
     WHERE expected_id = $1`,
    [id, expected_amount ?? null, year ?? null, purpose ?? null, status ?? null]
  );
  return getExpectedDonation(id);
}
