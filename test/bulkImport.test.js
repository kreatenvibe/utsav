import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { app } from '../app.js';
import { pool } from '../db/pool.js';

const created = { userIds: [], colonyIds: [], donorIds: [] };

function uniquePhone() {
  return `9${Date.now().toString().slice(-9)}${Math.floor(Math.random() * 10)}`;
}

// No self-registration endpoint anymore — bootstrap test users with a
// direct insert, same as a real deployment's first admin would need.
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

test('POST /colonies/:id/members/bulk: phone-only row creates a login, and it works at /auth/login', async () => {
  const admin = await createLoginUser('phone-login-admin');
  const colony = await createColony(admin.token);
  const phone = uniquePhone();

  const csv = ['name,phone,password', `Volunteer One,${phone},secret123`].join('\n');
  const bulkRes = await request(app)
    .post(`/colonies/${colony.colony_id}/members/bulk`)
    .set('Authorization', `Bearer ${admin.token}`)
    .attach('file', Buffer.from(csv), 'roster.csv');
  assert.equal(bulkRes.status, 201);
  assert.equal(bulkRes.body.created.length, 1);
  assert.equal(bulkRes.body.created[0].account, 'created');
  created.userIds.push(bulkRes.body.created[0].user_id);

  const { rows: membershipRows } = await pool.query(
    'SELECT role FROM colony_memberships WHERE colony_id = $1 AND user_id = $2',
    [colony.colony_id, bulkRes.body.created[0].user_id]
  );
  assert.equal(membershipRows.length, 1, 'a bulk-added member is always given a colony membership (login is mandatory now)');

  const loginRes = await request(app).post('/auth/login').send({ phone, password: 'secret123' });
  assert.equal(loginRes.status, 200);
  assert.ok(loginRes.body.token);

  const wrongPassword = await request(app).post('/auth/login').send({ phone, password: 'wrong' });
  assert.equal(wrongPassword.status, 401);
  assert.equal(wrongPassword.body.error, 'invalid credentials');
});

test('POST /colonies/:id/members/bulk: same phone in a second colony links the existing account instead of erroring', async () => {
  const admin = await createLoginUser('bulk-samephone-admin');
  const colonyA = await createColony(admin.token);
  const colonyB = await createColony(admin.token);
  const phone = uniquePhone();

  const firstCsv = ['name,phone,password', `Shared Volunteer,${phone},secret123`].join('\n');
  const firstRes = await request(app)
    .post(`/colonies/${colonyA.colony_id}/members/bulk`)
    .set('Authorization', `Bearer ${admin.token}`)
    .attach('file', Buffer.from(firstCsv), 'roster.csv');
  assert.equal(firstRes.status, 201);
  assert.equal(firstRes.body.created[0].account, 'created');
  const userId = firstRes.body.created[0].user_id;
  created.userIds.push(userId);

  const secondCsv = ['name,phone', `Shared Volunteer,${phone}`].join('\n');
  const secondRes = await request(app)
    .post(`/colonies/${colonyB.colony_id}/members/bulk`)
    .set('Authorization', `Bearer ${admin.token}`)
    .attach('file', Buffer.from(secondCsv), 'roster.csv');

  assert.equal(secondRes.status, 201);
  assert.equal(secondRes.body.created.length, 1);
  assert.equal(secondRes.body.created[0].account, 'linked');
  assert.equal(secondRes.body.created[0].user_id, userId);

  const { rows: membershipRows } = await pool.query(
    'SELECT colony_id FROM colony_memberships WHERE user_id = $1 ORDER BY colony_id',
    [userId]
  );
  assert.deepEqual(
    membershipRows.map((r) => r.colony_id).sort((a, b) => a - b),
    [colonyA.colony_id, colonyB.colony_id].sort((a, b) => a - b)
  );
});

test('POST /colonies/:id/members/bulk: mixed created/skipped/error rows, admin-only', async () => {
  const admin = await createLoginUser('admin');
  const outsider = await createLoginUser('outsider');
  const alreadyMember = await createLoginUser('already-member');
  const newMember = await createLoginUser('new-member');
  const colony = await createColony(admin.token);
  const unregisteredPhone = uniquePhone();

  const addRes = await request(app)
    .post(`/colonies/${colony.colony_id}/members`)
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ phone: alreadyMember.phone, role: 'member' });
  assert.equal(addRes.status, 201);

  const nonAdminAttempt = await request(app)
    .post(`/colonies/${colony.colony_id}/members/bulk`)
    .set('Authorization', `Bearer ${outsider.token}`)
    .attach('file', Buffer.from('name,phone,role\n'), 'roster.csv');
  assert.equal(nonAdminAttempt.status, 403);

  const csv = [
    'name,phone,role,password',
    `New Member Csv,${newMember.phone},member,`,
    `Already Member Csv,${alreadyMember.phone},member,`,
    `Nobody Registered,${unregisteredPhone},member,`,
    `Outsider Csv,${outsider.phone},not-a-role,`,
  ].join('\n');

  const res = await request(app)
    .post(`/colonies/${colony.colony_id}/members/bulk`)
    .set('Authorization', `Bearer ${admin.token}`)
    .attach('file', Buffer.from(csv), 'roster.csv');

  assert.equal(res.status, 201);
  assert.equal(res.body.created.length, 1);
  assert.equal(res.body.created[0].row, 1);
  assert.equal(res.body.created[0].account, 'linked');
  assert.equal(res.body.created[0].phone, newMember.phone);
  assert.equal(res.body.created[0].role, 'member');
  assert.ok(res.body.created[0].colony_membership_id);

  assert.equal(res.body.skipped.length, 1);
  assert.equal(res.body.skipped[0].row, 2);
  assert.equal(res.body.skipped[0].phone, alreadyMember.phone);

  assert.equal(res.body.errors.length, 2);
  assert.equal(res.body.errors[0].row, 3);
  assert.match(res.body.errors[0].reason, /password is required/);
  assert.equal(res.body.errors[1].row, 4);
  assert.match(res.body.errors[1].reason, /role must be/);

  const missingFile = await request(app)
    .post(`/colonies/${colony.colony_id}/members/bulk`)
    .set('Authorization', `Bearer ${admin.token}`);
  assert.equal(missingFile.status, 400);
});

test('POST /donors/bulk: creates rows with a name, errors on missing name, no dedup', async () => {
  const admin = await createLoginUser('donor-bulk-admin');
  await createColony(admin.token); // donor writes now require admin-of-any-colony

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
