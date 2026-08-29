import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { app } from '../app.js';
import { pool } from '../db/pool.js';

const created = { userIds: [], colonyIds: [] };

function uniqueEmail(label) {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;
}

function uniquePhone() {
  return `9${Date.now().toString().slice(-9)}${Math.floor(Math.random() * 10)}`;
}

async function registerAndLogin(label) {
  const email = uniqueEmail(label);
  const password = 'password123';
  const registerRes = await request(app).post('/auth/register').send({ name: label, email, password });
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
  const admin = await registerAndLogin('phone-login-admin');
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

test('POST /auth/login: both email and phone is 400, neither is 400', async () => {
  const bothRes = await request(app)
    .post('/auth/login')
    .send({ email: 'a@test.local', phone: '9990000000', password: 'x' });
  assert.equal(bothRes.status, 400);

  const neitherRes = await request(app).post('/auth/login').send({ password: 'x' });
  assert.equal(neitherRes.status, 400);
});

test('POST /colonies/:id/members/bulk: email-column row creates an account and links it to the colony', async () => {
  const admin = await registerAndLogin('bulk-email-admin');
  const colony = await createColony(admin.token);
  const email = uniqueEmail('bulk-email-row');

  const csv = ['name,email,password', `Email Volunteer,${email},secret123`].join('\n');
  const res = await request(app)
    .post(`/colonies/${colony.colony_id}/members/bulk`)
    .set('Authorization', `Bearer ${admin.token}`)
    .attach('file', Buffer.from(csv), 'roster.csv');

  assert.equal(res.status, 201);
  assert.equal(res.body.created.length, 1);
  assert.equal(res.body.created[0].account, 'created');
  assert.equal(res.body.created[0].email, email);
  created.userIds.push(res.body.created[0].user_id);

  const { rows: membershipRows } = await pool.query(
    'SELECT role FROM colony_memberships WHERE colony_id = $1 AND user_id = $2',
    [colony.colony_id, res.body.created[0].user_id]
  );
  assert.equal(membershipRows.length, 1);
  assert.equal(membershipRows[0].role, 'member');
});

test('POST /colonies/:id/members/bulk: same phone in a second colony links the existing account instead of erroring', async () => {
  // users.phone is globally unique, so a second bulk-add row with the same phone can no
  // longer create a second account (migration 012 behavior) — the new create-or-link
  // upsert instead recognizes the existing account and just adds a membership row for
  // the new colony, which is the more useful behavior for someone who belongs to two
  // colonies.
  const admin = await registerAndLogin('bulk-samephone-admin');
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

test('GET /users?search= matches partial phone', async () => {
  const admin = await registerAndLogin('users-search-admin');
  const colony = await createColony(admin.token);
  const phone = uniquePhone();

  const csv = ['name,phone,password', `Searchable Volunteer,${phone},secret123`].join('\n');
  const bulkRes = await request(app)
    .post(`/colonies/${colony.colony_id}/members/bulk`)
    .set('Authorization', `Bearer ${admin.token}`)
    .attach('file', Buffer.from(csv), 'roster.csv');
  assert.equal(bulkRes.status, 201);
  created.userIds.push(bulkRes.body.created[0].user_id);

  const searchRes = await request(app)
    .get(`/users?search=${phone.slice(-6)}`)
    .set('Authorization', `Bearer ${admin.token}`);
  assert.equal(searchRes.status, 200);
  const match = searchRes.body.find((u) => u.phone === phone);
  assert.ok(match, 'search by partial phone should find the phone-only user');
  assert.equal(match.email, null);
  assert.equal(match.name, 'Searchable Volunteer');
});
