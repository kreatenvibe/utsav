import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { app } from '../app.js';
import { pool } from '../db/pool.js';

const created = { userIds: [], colonyIds: [], festivalIds: [], donorIds: [], donationIds: [] };

function uniquePhone() {
  return `9${Date.now().toString().slice(-9)}${Math.floor(Math.random() * 10)}`;
}

async function createLoginUser(label) {
  const phone = uniquePhone();
  const password = 'password123';
  const passwordHash = await bcrypt.hash(password, 10);
  const { rows } = await pool.query(
    'INSERT INTO users (name, phone, password_hash) VALUES ($1, $2, $3) RETURNING user_id',
    [label, phone, passwordHash]
  );
  created.userIds.push(rows[0].user_id);

  const loginRes = await request(app).post('/auth/login').send({ phone, password });
  assert.equal(loginRes.status, 200);
  return { userId: rows[0].user_id, phone, token: loginRes.body.token };
}

async function createColony(token) {
  const res = await request(app)
    .post('/colonies')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: `Test Colony ${Date.now()}-${Math.random().toString(36).slice(2)}` });
  assert.equal(res.status, 201);
  created.colonyIds.push(res.body.colony_id);
  return res.body;
}

async function createFestival(token, colonyId) {
  const res = await request(app)
    .post('/festivals')
    .set('Authorization', `Bearer ${token}`)
    .send({ colony_id: colonyId, name: 'Test Festival', year: 2026 });
  assert.equal(res.status, 201);
  created.festivalIds.push(res.body.festival_id);
  return res.body;
}

async function createDonor(token, colonyId) {
  const res = await request(app)
    .post('/donors')
    .set('Authorization', `Bearer ${token}`)
    .send({ colony_id: colonyId, name: 'Test Donor' });
  assert.equal(res.status, 201);
  created.donorIds.push(res.body.donor_id);
  return res.body;
}

async function setup() {
  const admin = await createLoginUser('admin');
  const colony = await createColony(admin.token);
  const festival = await createFestival(admin.token, colony.colony_id);
  const donor = await createDonor(admin.token, colony.colony_id);
  return { admin, colony, festival, donor };
}

after(async () => {
  if (created.donationIds.length) {
    await pool.query('DELETE FROM donations WHERE donation_id = ANY($1)', [created.donationIds]);
  }
  if (created.donorIds.length) {
    await pool.query('DELETE FROM expected_donations WHERE donor_id = ANY($1)', [created.donorIds]);
    await pool.query('DELETE FROM donors WHERE donor_id = ANY($1)', [created.donorIds]);
  }
  if (created.festivalIds.length) {
    await pool.query('DELETE FROM festival WHERE festival_id = ANY($1)', [created.festivalIds]);
  }
  if (created.colonyIds.length) {
    await pool.query('DELETE FROM colony_memberships WHERE colony_id = ANY($1)', [created.colonyIds]);
    await pool.query('DELETE FROM colony WHERE colony_id = ANY($1)', [created.colonyIds]);
  }
  if (created.userIds.length) {
    await pool.query('DELETE FROM users WHERE user_id = ANY($1)', [created.userIds]);
  }
  await pool.end();
});

test('a walk-in donation with festival_id counts toward that festival\'s current_balance', async () => {
  const { admin, festival, donor } = await setup();

  const res = await request(app)
    .post('/donations')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ donor_id: donor.donor_id, festival_id: festival.festival_id, amount: 500, date: '2026-09-01' });
  assert.equal(res.status, 201);
  created.donationIds.push(res.body.donation_id);
  assert.equal(res.body.festival_id, festival.festival_id);

  const detail = await request(app).get(`/festivals/${festival.festival_id}`);
  assert.equal(detail.status, 200);
  assert.equal(Number(detail.body.current_balance), 500);
});

test('a walk-in donation without festival_id stays excluded from every festival\'s current_balance', async () => {
  const { admin, festival, donor } = await setup();

  const res = await request(app)
    .post('/donations')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ donor_id: donor.donor_id, amount: 300, date: '2026-09-01' });
  assert.equal(res.status, 201);
  created.donationIds.push(res.body.donation_id);
  assert.equal(res.body.festival_id, null);

  const detail = await request(app).get(`/festivals/${festival.festival_id}`);
  assert.equal(detail.status, 200);
  assert.equal(Number(detail.body.current_balance), 0);
});

test('a donation with both expected_id and festival_id is rejected with 400', async () => {
  const { admin, festival, donor } = await setup();

  const pledgeRes = await request(app)
    .post('/expected-donations')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ donor_id: donor.donor_id, festival_id: festival.festival_id, expected_amount: 1000, year: 2026 });
  assert.equal(pledgeRes.status, 201);

  const res = await request(app)
    .post('/donations')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({
      donor_id: donor.donor_id,
      expected_id: pledgeRes.body.expected_id,
      festival_id: festival.festival_id,
      amount: 200,
      date: '2026-09-01',
    });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /cannot both be set/);
});

test('a walk-in donation with a nonexistent festival_id is rejected with 404', async () => {
  const { admin, donor } = await setup();

  const res = await request(app)
    .post('/donations')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ donor_id: donor.donor_id, festival_id: 9999999, amount: 100, date: '2026-09-01' });
  assert.equal(res.status, 404);
  assert.match(res.body.error, /festival not found/);
});
