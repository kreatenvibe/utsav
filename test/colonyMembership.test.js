import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { app } from '../app.js';
import { pool } from '../db/pool.js';

const created = { userIds: [], colonyIds: [], festivalIds: [] };

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
  return { userId: registerRes.body.user_id, token: loginRes.body.token };
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
  const admin = await registerAndLogin('admin');
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
  const admin = await registerAndLogin('admin');
  const outsider = await registerAndLogin('outsider');
  const colony = await createColony(admin.token);

  const res = await createFestival(outsider.token, colony.colony_id);
  assert.equal(res.status, 403);
});

test('admin can add a plain member, who can then write scoped data', async () => {
  const admin = await registerAndLogin('admin');
  const member = await registerAndLogin('member');
  const colony = await createColony(admin.token);

  const addRes = await request(app)
    .post(`/colonies/${colony.colony_id}/members`)
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ email: (await pool.query('SELECT email FROM users WHERE user_id = $1', [member.userId])).rows[0].email, role: 'member' });
  assert.equal(addRes.status, 201);
  assert.equal(addRes.body.role, 'member');

  const festivalRes = await createFestival(member.token, colony.colony_id);
  assert.equal(festivalRes.status, 201);
});

test('a non-admin member cannot add or remove members', async () => {
  const admin = await registerAndLogin('admin');
  const member = await registerAndLogin('member');
  const outsider = await registerAndLogin('outsider');
  const colony = await createColony(admin.token);

  const memberEmail = (await pool.query('SELECT email FROM users WHERE user_id = $1', [member.userId])).rows[0].email;
  const addMember = await request(app)
    .post(`/colonies/${colony.colony_id}/members`)
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ email: memberEmail, role: 'member' });
  assert.equal(addMember.status, 201);

  const outsiderEmail = (await pool.query('SELECT email FROM users WHERE user_id = $1', [outsider.userId])).rows[0].email;
  const blockedAdd = await request(app)
    .post(`/colonies/${colony.colony_id}/members`)
    .set('Authorization', `Bearer ${member.token}`)
    .send({ email: outsiderEmail, role: 'member' });
  assert.equal(blockedAdd.status, 403);

  const blockedRemove = await request(app)
    .delete(`/colonies/${colony.colony_id}/members/${admin.userId}`)
    .set('Authorization', `Bearer ${member.token}`);
  assert.equal(blockedRemove.status, 403);
});

test('the last admin of a colony cannot be removed or demoted', async () => {
  const admin = await registerAndLogin('admin');
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
  const admin = await registerAndLogin('admin');
  const colony = await createColony(admin.token);

  const res = await request(app).get(`/colonies/${colony.colony_id}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.colony_id, colony.colony_id);
});

test('membership gate reaches expenses/expense_payments and tasks/task_assignments via the festival->colony chain', async () => {
  const admin = await registerAndLogin('admin');
  const outsider = await registerAndLogin('outsider');
  const colony = await createColony(admin.token);
  const festivalRes = await createFestival(admin.token, colony.colony_id);
  assert.equal(festivalRes.status, 201);
  const festivalId = festivalRes.body.festival_id;

  const blockedExpense = await request(app)
    .post('/expenses')
    .set('Authorization', `Bearer ${outsider.token}`)
    .send({ festival_id: festivalId, amount_planned: 100 });
  assert.equal(blockedExpense.status, 403);

  const expense = await request(app)
    .post('/expenses')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ festival_id: festivalId, amount_planned: 100 });
  assert.equal(expense.status, 201);

  const blockedExpensePayment = await request(app)
    .post('/expense-payments')
    .set('Authorization', `Bearer ${outsider.token}`)
    .send({ expense_id: expense.body.expense_id, amount: 50, date: '2026-01-01' });
  assert.equal(blockedExpensePayment.status, 403);

  const okExpensePayment = await request(app)
    .post('/expense-payments')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ expense_id: expense.body.expense_id, amount: 50, date: '2026-01-01' });
  assert.equal(okExpensePayment.status, 201);

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

  const memberRes = await request(app)
    .post('/members')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ name: 'Volunteer One' });
  assert.equal(memberRes.status, 201);

  const blockedTaskAssignment = await request(app)
    .post('/task-assignments')
    .set('Authorization', `Bearer ${outsider.token}`)
    .send({ task_id: task.body.task_id, member_id: memberRes.body.member_id });
  assert.equal(blockedTaskAssignment.status, 403);

  const okTaskAssignment = await request(app)
    .post('/task-assignments')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ task_id: task.body.task_id, member_id: memberRes.body.member_id });
  assert.equal(okTaskAssignment.status, 201);

  await pool.query('DELETE FROM task_assignments WHERE assignment_id = $1', [okTaskAssignment.body.assignment_id]);
  await pool.query('DELETE FROM members WHERE member_id = $1', [memberRes.body.member_id]);
  await pool.query('DELETE FROM tasks WHERE task_id = $1', [task.body.task_id]);
  await pool.query('DELETE FROM expense_payments WHERE payment_id = $1', [okExpensePayment.body.payment_id]);
  await pool.query('DELETE FROM expenses WHERE expense_id = $1', [expense.body.expense_id]);
});

test('membership gate reaches donations via the expected_donation->festival->colony chain, but leaves walk-in donations (no expected_id) unscoped', async () => {
  const admin = await registerAndLogin('admin');
  const outsider = await registerAndLogin('outsider');
  const colony = await createColony(admin.token);
  const festivalRes = await createFestival(admin.token, colony.colony_id);
  const festivalId = festivalRes.body.festival_id;

  const donorRes = await request(app)
    .post('/donors')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ name: 'Test Donor' });
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

  const walkInDonation = await request(app)
    .post('/donations')
    .set('Authorization', `Bearer ${outsider.token}`)
    .send({ donor_id: donorRes.body.donor_id, amount: 50, date: '2026-01-01' });
  assert.equal(walkInDonation.status, 201, 'walk-in donations with no expected_id are not colony-scoped, by design');

  await pool.query('DELETE FROM donations WHERE donation_id = ANY($1)', [[okDonation.body.donation_id, walkInDonation.body.donation_id]]);
  await pool.query('DELETE FROM expected_donations WHERE expected_id = $1', [expectedRes.body.expected_id]);
  await pool.query('DELETE FROM donors WHERE donor_id = $1', [donorRes.body.donor_id]);
});
