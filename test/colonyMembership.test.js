import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { app } from '../app.js';
import { pool } from '../db/pool.js';

const created = { userIds: [], colonyIds: [], festivalIds: [] };

function uniquePhone() {
  return `9${Date.now().toString().slice(-9)}${Math.floor(Math.random() * 10)}`;
}

// Most tests still provision their users via a direct insert rather than
// POST /auth/register (unrelated to registration — this just needs a user
// that's already a member of nothing, ready to create/join colonies).
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
  if (res.status === 201) {
    created.festivalIds.push(res.body.festival_id);
  }
  return res;
}

after(async () => {
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

test('creating a colony auto-admins the creator', async () => {
  const admin = await createLoginUser('admin');
  const colony = await createColony(admin.token);

  const mine = await request(app)
    .get('/colonies/mine')
    .set('Authorization', `Bearer ${admin.token}`);
  assert.equal(mine.status, 200);
  const membership = mine.body.find((c) => c.colony_id === colony.colony_id);
  assert.ok(membership, 'creator should see the colony in "mine"');
  assert.equal(membership.role, 'admin');
});

test('a non-member is blocked from writing under someone else\'s colony', async () => {
  const admin = await createLoginUser('admin');
  const outsider = await createLoginUser('outsider');
  const colony = await createColony(admin.token);

  const res = await createFestival(outsider.token, colony.colony_id);
  assert.equal(res.status, 403);
});

test('admin can add a plain member by linking their existing account, but a plain member still cannot write scoped data', async () => {
  const admin = await createLoginUser('admin');
  const member = await createLoginUser('member');
  const colony = await createColony(admin.token);

  const addRes = await request(app)
    .post(`/colonies/${colony.colony_id}/members`)
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ phone: member.phone, role: 'member' });
  assert.equal(addRes.status, 201);
  assert.equal(addRes.body.role, 'member');
  assert.equal(addRes.body.account, 'linked');
  assert.equal(addRes.body.user_id, member.userId);

  const festivalRes = await createFestival(member.token, colony.colony_id);
  assert.equal(festivalRes.status, 403, 'colony-admin is now the only write role; a plain member cannot');
});

test('a non-admin member cannot add or remove members', async () => {
  const admin = await createLoginUser('admin');
  const member = await createLoginUser('member');
  const outsider = await createLoginUser('outsider');
  const colony = await createColony(admin.token);

  const addMember = await request(app)
    .post(`/colonies/${colony.colony_id}/members`)
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ phone: member.phone, role: 'member' });
  assert.equal(addMember.status, 201);

  const blockedAdd = await request(app)
    .post(`/colonies/${colony.colony_id}/members`)
    .set('Authorization', `Bearer ${member.token}`)
    .send({ phone: outsider.phone, role: 'member' });
  assert.equal(blockedAdd.status, 403);

  const blockedRemove = await request(app)
    .delete(`/colonies/${colony.colony_id}/members/${admin.userId}`)
    .set('Authorization', `Bearer ${member.token}`);
  assert.equal(blockedRemove.status, 403);
});

test('the last admin of a colony cannot be removed or demoted', async () => {
  const admin = await createLoginUser('admin');
  const colony = await createColony(admin.token);

  const removeRes = await request(app)
    .delete(`/colonies/${colony.colony_id}/members/${admin.userId}`)
    .set('Authorization', `Bearer ${admin.token}`);
  assert.equal(removeRes.status, 400);

  const demoteRes = await request(app)
    .patch(`/colonies/${colony.colony_id}/members/${admin.userId}`)
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ role: 'member' });
  assert.equal(demoteRes.status, 400);
});

test('unauthenticated writes are still rejected (auth regression check)', async () => {
  const res = await request(app).post('/colonies').send({ name: 'No Auth Colony' });
  assert.equal(res.status, 401);
});

test('colony reads stay public with no token (regression check)', async () => {
  const admin = await createLoginUser('admin');
  const colony = await createColony(admin.token);

  const res = await request(app).get(`/colonies/${colony.colony_id}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.colony_id, colony.colony_id);
});

test('admin-only gate reaches expenses/expense_payments and tasks/task_assignments via the festival->colony chain; a plain member is blocked too', async () => {
  const admin = await createLoginUser('admin');
  const member = await createLoginUser('member');
  const outsider = await createLoginUser('outsider');
  const colony = await createColony(admin.token);
  const addMemberRes = await request(app)
    .post(`/colonies/${colony.colony_id}/members`)
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ phone: member.phone, role: 'member' });
  assert.equal(addMemberRes.status, 201);

  const festivalRes = await createFestival(admin.token, colony.colony_id);
  assert.equal(festivalRes.status, 201);
  const festivalId = festivalRes.body.festival_id;

  const blockedExpense = await request(app)
    .post('/expenses')
    .set('Authorization', `Bearer ${outsider.token}`)
    .send({ festival_id: festivalId, amount_planned: 100 });
  assert.equal(blockedExpense.status, 403);

  const memberBlockedExpense = await request(app)
    .post('/expenses')
    .set('Authorization', `Bearer ${member.token}`)
    .send({ festival_id: festivalId, amount_planned: 100 });
  assert.equal(memberBlockedExpense.status, 403, 'a plain colony member is no longer enough to write; must be admin');

  const expense = await request(app)
    .post('/expenses')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ festival_id: festivalId, amount_planned: 100 });
  assert.equal(expense.status, 201);

  const blockedExpensePayment = await request(app)
    .post('/expense-payments')
    .set('Authorization', `Bearer ${outsider.token}`)
    .send({ expense_id: expense.body.expense_id, amount: 50, date: '2026-01-01', note: 'Chairs rental' });
  assert.equal(blockedExpensePayment.status, 403);

  const okExpensePayment = await request(app)
    .post('/expense-payments')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ expense_id: expense.body.expense_id, amount: 50, date: '2026-01-01', note: 'Chairs rental' });
  assert.equal(okExpensePayment.status, 201);
  assert.equal(okExpensePayment.body.paid_by, null);
  assert.equal(okExpensePayment.body.payer, null);

  const blockedTask = await request(app)
    .post('/tasks')
    .set('Authorization', `Bearer ${outsider.token}`)
    .send({ festival_id: festivalId, title: 'Set up chairs' });
  assert.equal(blockedTask.status, 403);

  const task = await request(app)
    .post('/tasks')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ festival_id: festivalId, title: 'Set up chairs' });
  assert.equal(task.status, 201);

  const blockedTaskAssignment = await request(app)
    .post('/task-assignments')
    .set('Authorization', `Bearer ${member.token}`)
    .send({ task_id: task.body.task_id, user_id: member.userId });
  assert.equal(blockedTaskAssignment.status, 403, 'signing up is now colony-admin only, not self-service');

  const okTaskAssignment = await request(app)
    .post('/task-assignments')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ task_id: task.body.task_id, user_id: member.userId });
  assert.equal(okTaskAssignment.status, 201);
  assert.equal(okTaskAssignment.body.user_id, member.userId);
  assert.equal(okTaskAssignment.body.user.phone, member.phone);

  await pool.query('DELETE FROM task_assignments WHERE assignment_id = $1', [okTaskAssignment.body.assignment_id]);
  await pool.query('DELETE FROM tasks WHERE task_id = $1', [task.body.task_id]);
  await pool.query('DELETE FROM expense_payments WHERE payment_id = $1', [okExpensePayment.body.payment_id]);
  await pool.query('DELETE FROM expenses WHERE expense_id = $1', [expense.body.expense_id]);
});

test('donations tied to a pledge require colony-admin via expected_donation->festival->colony; walk-in donations now require admin-of-any-colony instead of being unscoped', async () => {
  const admin = await createLoginUser('admin');
  const outsider = await createLoginUser('outsider');
  const colony = await createColony(admin.token);
  const festivalRes = await createFestival(admin.token, colony.colony_id);
  const festivalId = festivalRes.body.festival_id;

  const donorRes = await request(app)
    .post('/donors')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ colony_id: colony.colony_id, name: 'Test Donor' });
  assert.equal(donorRes.status, 201);

  const expectedRes = await request(app)
    .post('/expected-donations')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ donor_id: donorRes.body.donor_id, festival_id: festivalId, expected_amount: 500, year: 2026 });
  assert.equal(expectedRes.status, 201);

  const blockedDonation = await request(app)
    .post('/donations')
    .set('Authorization', `Bearer ${outsider.token}`)
    .send({ donor_id: donorRes.body.donor_id, expected_id: expectedRes.body.expected_id, amount: 200, date: '2026-01-01' });
  assert.equal(blockedDonation.status, 403);

  const okDonation = await request(app)
    .post('/donations')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ donor_id: donorRes.body.donor_id, expected_id: expectedRes.body.expected_id, amount: 200, date: '2026-01-01' });
  assert.equal(okDonation.status, 201);
  assert.equal(okDonation.body.collector, null);

  const blockedWalkIn = await request(app)
    .post('/donations')
    .set('Authorization', `Bearer ${outsider.token}`)
    .send({ donor_id: donorRes.body.donor_id, amount: 50, date: '2026-01-01' });
  assert.equal(blockedWalkIn.status, 403, 'walk-in donations now require the caller to be an admin of at least one colony');

  const okWalkIn = await request(app)
    .post('/donations')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ donor_id: donorRes.body.donor_id, amount: 50, date: '2026-01-01' });
  assert.equal(okWalkIn.status, 201, 'a colony admin (of any colony) can still log a walk-in donation');

  await pool.query('DELETE FROM donations WHERE donation_id = ANY($1)', [[okDonation.body.donation_id, okWalkIn.body.donation_id]]);
  await pool.query('DELETE FROM expected_donations WHERE expected_id = $1', [expectedRes.body.expected_id]);
  await pool.query('DELETE FROM donors WHERE donor_id = $1', [donorRes.body.donor_id]);
});

test('POST /auth/login: missing phone or password is 400', async () => {
  const missingPassword = await request(app).post('/auth/login').send({ phone: '9990000000' });
  assert.equal(missingPassword.status, 400);

  const missingPhone = await request(app).post('/auth/login').send({ password: 'x' });
  assert.equal(missingPhone.status, 400);
});

test('POST /auth/login: unknown phone or wrong password is 401 with the same message', async () => {
  const admin = await createLoginUser('admin');

  const unknownPhone = await request(app).post('/auth/login').send({ phone: '9990000000', password: 'x' });
  assert.equal(unknownPhone.status, 401);
  assert.equal(unknownPhone.body.error, 'invalid credentials');

  const wrongPassword = await request(app).post('/auth/login').send({ phone: admin.phone, password: 'wrong' });
  assert.equal(wrongPassword.status, 401);
  assert.equal(wrongPassword.body.error, 'invalid credentials');
});

test('POST /auth/register: 400 on missing fields', async () => {
  const res = await request(app).post('/auth/register').send({ phone: '9990000002' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'name, phone, and password are required');
});

test('POST /auth/register: 201 with a working token, and repeat calls keep working', async () => {
  const phone = uniquePhone();
  const res = await request(app)
    .post('/auth/register')
    .send({ name: 'Self Registered', phone, password: 'password123' });
  assert.equal(res.status, 201);
  assert.ok(res.body.token, 'response is { token }, same shape as /auth/login');

  const loginRes = await request(app).post('/auth/login').send({ phone, password: 'password123' });
  assert.equal(loginRes.status, 200, 'the registered account can log in normally on a later session');

  const { rows } = await pool.query('SELECT user_id FROM users WHERE phone = $1', [phone]);
  created.userIds.push(rows[0].user_id);

  // No one-time restriction — unlike bootstrap, a second registration call
  // (with a different phone) still succeeds.
  const secondPhone = uniquePhone();
  const secondRes = await request(app)
    .post('/auth/register')
    .send({ name: 'Second Self Registered', phone: secondPhone, password: 'password123' });
  assert.equal(secondRes.status, 201);
  const { rows: secondRows } = await pool.query('SELECT user_id FROM users WHERE phone = $1', [secondPhone]);
  created.userIds.push(secondRows[0].user_id);
});

test('POST /auth/register: 409 on duplicate phone', async () => {
  const admin = await createLoginUser('duplicate-phone-check');
  const res = await request(app)
    .post('/auth/register')
    .send({ name: 'Someone Else', phone: admin.phone, password: 'password123' });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'phone already registered');
});

test('GET /users?search= matches partial name/phone and never returns email', async () => {
  const admin = await createLoginUser('Searchable Volunteer');

  const searchRes = await request(app)
    .get(`/users?search=${admin.phone.slice(-6)}`)
    .set('Authorization', `Bearer ${admin.token}`);
  assert.equal(searchRes.status, 200);
  const match = searchRes.body.find((u) => u.phone === admin.phone);
  assert.ok(match, 'search by partial phone should find the user');
  assert.equal(match.name, 'Searchable Volunteer');
  assert.equal('email' in match, false);
});
