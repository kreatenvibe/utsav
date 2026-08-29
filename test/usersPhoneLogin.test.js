import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { app } from '../app.js';
import { pool } from '../db/pool.js';

const created = { userIds: [], colonyIds: [], memberIds: [] };

function uniqueEmail(label) {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;
}

function uniquePhone() {
  return `9${Date.now().toString().slice(-9)}${Math.floor(Math.random() * 10)}`;
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
  if (created.memberIds.length) {
    await pool.query('DELETE FROM members WHERE member_id = ANY($1)', [created.memberIds]);
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

test('POST /auth/login: phone-only login succeeds, wrong password fails', async () => {
  const admin = await registerAndLogin('phone-login-admin');
  const colony = await createColony(admin.token);
  const phone = uniquePhone();

  const csv = ['name,phone,grant_login,password', `Volunteer One,${phone},yes,secret123`].join('\n');
  const bulkRes = await request(app)
    .post('/members/bulk')
    .set('Authorization', `Bearer ${admin.token}`)
    .field('colony_id', colony.colony_id)
    .field('initial_password', 'shared123')
    .attach('file', Buffer.from(csv), 'roster.csv');
  assert.equal(bulkRes.status, 201);
  assert.equal(bulkRes.body.created.length, 1);
  assert.equal(bulkRes.body.created[0].login_granted, true);
  created.memberIds.push(bulkRes.body.created[0].member_id);

  const { rows } = await pool.query('SELECT user_id FROM members WHERE member_id = $1', [
    bulkRes.body.created[0].member_id,
  ]);
  created.userIds.push(rows[0].user_id);

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

test('POST /members/bulk: email path unchanged and now auto-links colony membership', async () => {
  const admin = await registerAndLogin('bulk-email-admin');
  const colony = await createColony(admin.token);
  const email = uniqueEmail('bulk-email-row');
  const phone = uniquePhone();

  const csv = ['name,phone,email', `Email Volunteer,${phone},${email}`].join('\n');
  const res = await request(app)
    .post('/members/bulk')
    .set('Authorization', `Bearer ${admin.token}`)
    .field('colony_id', colony.colony_id)
    .field('initial_password', 'shared123')
    .attach('file', Buffer.from(csv), 'roster.csv');

  assert.equal(res.status, 201);
  assert.equal(res.body.created.length, 1);
  assert.equal(res.body.created[0].login_granted, true);
  assert.equal(res.body.created[0].email, email);
  created.memberIds.push(res.body.created[0].member_id);

  const { rows: memberRows } = await pool.query('SELECT user_id FROM members WHERE member_id = $1', [
    res.body.created[0].member_id,
  ]);
  const userId = memberRows[0].user_id;
  created.userIds.push(userId);

  const { rows: membershipRows } = await pool.query(
    'SELECT role FROM colony_memberships WHERE colony_id = $1 AND user_id = $2',
    [colony.colony_id, userId]
  );
  assert.equal(membershipRows.length, 1, 'email-granted login should be auto-added to the colony');
  assert.equal(membershipRows[0].role, 'member');
});

test('POST /members/bulk: grant_login=false with no email grants no login (unchanged volunteer case)', async () => {
  const admin = await registerAndLogin('bulk-novolunteer-admin');
  const colony = await createColony(admin.token);
  const phone = uniquePhone();

  const csv = ['name,phone,grant_login', `No Login Volunteer,${phone},no`].join('\n');
  const res = await request(app)
    .post('/members/bulk')
    .set('Authorization', `Bearer ${admin.token}`)
    .field('colony_id', colony.colony_id)
    .field('initial_password', 'shared123')
    .attach('file', Buffer.from(csv), 'roster.csv');

  assert.equal(res.status, 201);
  assert.equal(res.body.created.length, 1);
  assert.equal(res.body.created[0].login_granted, false);
  created.memberIds.push(res.body.created[0].member_id);
});

test('POST /members/bulk: phone already registered for login surfaces as a row-level error (cross-colony)', async () => {
  // members.phone uniqueness is scoped per-colony (migration 010), but users.phone
  // is globally unique — so this case only shows up across two different colonies'
  // rosters, not a same-colony duplicate (that hits the members-level check first
  // and lands in `skipped`, covered by the mixed-outcome bulk-import behavior already).
  const admin = await registerAndLogin('bulk-dupphone-admin');
  const colonyA = await createColony(admin.token);
  const colonyB = await createColony(admin.token);
  const phone = uniquePhone();

  const firstCsv = ['name,phone,grant_login', `First Volunteer,${phone},yes`].join('\n');
  const firstRes = await request(app)
    .post('/members/bulk')
    .set('Authorization', `Bearer ${admin.token}`)
    .field('colony_id', colonyA.colony_id)
    .field('initial_password', 'shared123')
    .attach('file', Buffer.from(firstCsv), 'roster.csv');
  assert.equal(firstRes.status, 201);
  assert.equal(firstRes.body.created[0].login_granted, true);
  created.memberIds.push(firstRes.body.created[0].member_id);
  const { rows } = await pool.query('SELECT user_id FROM members WHERE member_id = $1', [
    firstRes.body.created[0].member_id,
  ]);
  created.userIds.push(rows[0].user_id);

  const secondCsv = ['name,phone,grant_login', `Second Volunteer,${phone},yes`].join('\n');
  const secondRes = await request(app)
    .post('/members/bulk')
    .set('Authorization', `Bearer ${admin.token}`)
    .field('colony_id', colonyB.colony_id)
    .field('initial_password', 'shared123')
    .attach('file', Buffer.from(secondCsv), 'roster.csv');

  assert.equal(secondRes.status, 201);
  assert.equal(secondRes.body.created.length, 0);
  assert.equal(secondRes.body.skipped.length, 0);
  assert.equal(secondRes.body.errors.length, 1);
  assert.match(secondRes.body.errors[0].reason, /phone already registered for login/);

  // member-insert + login-grant are atomic together (same convention as the
  // email-duplicate case), so the failed login grant rolls back the member row too.
  const { rows: memberRows } = await pool.query(
    'SELECT member_id FROM members WHERE colony_id = $1 AND phone = $2',
    [colonyB.colony_id, phone]
  );
  assert.equal(memberRows.length, 0, 'member insert is rolled back together with the failed login grant');
});

test('GET /users?search= matches partial phone', async () => {
  const admin = await registerAndLogin('users-search-admin');
  const colony = await createColony(admin.token);
  const phone = uniquePhone();

  const csv = ['name,phone,grant_login,password', `Searchable Volunteer,${phone},yes,secret123`].join('\n');
  const bulkRes = await request(app)
    .post('/members/bulk')
    .set('Authorization', `Bearer ${admin.token}`)
    .field('colony_id', colony.colony_id)
    .field('initial_password', 'shared123')
    .attach('file', Buffer.from(csv), 'roster.csv');
  assert.equal(bulkRes.status, 201);
  created.memberIds.push(bulkRes.body.created[0].member_id);
  const { rows } = await pool.query('SELECT user_id FROM members WHERE member_id = $1', [
    bulkRes.body.created[0].member_id,
  ]);
  created.userIds.push(rows[0].user_id);

  const searchRes = await request(app)
    .get(`/users?search=${phone.slice(-6)}`)
    .set('Authorization', `Bearer ${admin.token}`);
  assert.equal(searchRes.status, 200);
  const match = searchRes.body.find((u) => u.phone === phone);
  assert.ok(match, 'search by partial phone should find the phone-only user');
  assert.equal(match.email, null);
});
