import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { app } from '../app.js';
import { pool } from '../db/pool.js';

const created = { userIds: [], colonyIds: [], donorIds: [] };

function uniqueEmail(label) {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;
}

async function registerAndLogin(label) {
  const email = uniqueEmail(label);
  const password = 'password123';
  const registerRes = await request(app).post('/auth/register').send({ email, password });
  assert.equal(registerRes.status, 201);
  created.userIds.push(registerRes.body.user_id);

  const loginRes = await request(app).post('/auth/login').send({ email, password });
  assert.equal(loginRes.status, 200);
  return { userId: registerRes.body.user_id, email, token: loginRes.body.token };
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

after(async () => {
  if (created.donorIds.length) {
    await pool.query('DELETE FROM donors WHERE donor_id = ANY($1)', [created.donorIds]);
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

test('POST /colonies/:id/members/bulk: mixed created/skipped/error rows, admin-only', async () => {
  const admin = await registerAndLogin('admin');
  const outsider = await registerAndLogin('outsider');
  const alreadyMember = await registerAndLogin('already-member');
  const newMember = await registerAndLogin('new-member');
  const colony = await createColony(admin.token);

  const addRes = await request(app)
    .post(`/colonies/${colony.colony_id}/members`)
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ email: alreadyMember.email, role: 'member' });
  assert.equal(addRes.status, 201);

  const nonAdminAttempt = await request(app)
    .post(`/colonies/${colony.colony_id}/members/bulk`)
    .set('Authorization', `Bearer ${outsider.token}`)
    .attach('file', Buffer.from('email,role\n'), 'roster.csv');
  assert.equal(nonAdminAttempt.status, 403);

  const csv = [
    'email,role',
    `${newMember.email},member`,
    `${alreadyMember.email},member`,
    'nobody-registered@test.local,member',
    `${outsider.email},not-a-role`,
  ].join('\n');

  const res = await request(app)
    .post(`/colonies/${colony.colony_id}/members/bulk`)
    .set('Authorization', `Bearer ${admin.token}`)
    .attach('file', Buffer.from(csv), 'roster.csv');

  assert.equal(res.status, 201);
  assert.equal(res.body.created.length, 1);
  assert.equal(res.body.created[0].row, 1);
  assert.equal(res.body.created[0].email, undefined);
  assert.equal(res.body.created[0].role, 'member');
  assert.ok(res.body.created[0].colony_membership_id);

  assert.equal(res.body.skipped.length, 1);
  assert.equal(res.body.skipped[0].row, 2);
  assert.equal(res.body.skipped[0].email, alreadyMember.email);

  assert.equal(res.body.errors.length, 2);
  assert.equal(res.body.errors[0].row, 3);
  assert.equal(res.body.errors[1].row, 4);
  assert.match(res.body.errors[1].reason, /role must be/);

  const missingFile = await request(app)
    .post(`/colonies/${colony.colony_id}/members/bulk`)
    .set('Authorization', `Bearer ${admin.token}`);
  assert.equal(missingFile.status, 400);
});

test('POST /donors/bulk: creates rows with a name, errors on missing name, no dedup', async () => {
  const admin = await registerAndLogin('donor-bulk-admin');

  const csv = ['name,phone', 'Anita Sharma,9990001111', ',9990002222', 'Anita Sharma,9990001111'].join('\n');

  const res = await request(app)
    .post('/donors/bulk')
    .set('Authorization', `Bearer ${admin.token}`)
    .attach('file', Buffer.from(csv), 'donors.csv');

  assert.equal(res.status, 201);
  assert.equal(res.body.created.length, 2);
  assert.deepEqual(res.body.created[0], {
    row: 1,
    donor_id: res.body.created[0].donor_id,
    name: 'Anita Sharma',
    phone: '9990001111',
  });
  assert.equal(res.body.created[1].row, 3, 'duplicate name+phone is not deduped, still created');

  assert.equal(res.body.errors.length, 1);
  assert.equal(res.body.errors[0].row, 2);
  assert.match(res.body.errors[0].reason, /name is required/);

  assert.deepEqual(res.body.skipped, []);

  created.donorIds.push(...res.body.created.map((c) => c.donor_id));
});
