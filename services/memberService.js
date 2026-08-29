import bcrypt from 'bcryptjs';
import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { pool } from '../db/pool.js';
import {
  colonyExists,
  assertColonyAdmin,
  isColonyMember,
  addMember as addColonyMember,
  updateMemberRole,
} from './colonyMembershipService.js';

const FK_VIOLATION = '23503';
const UNIQUE_VIOLATION = '23505';
const MEMBERS_PHONE_CONSTRAINT = 'members_colony_id_phone_unique';
const USERS_EMAIL_CONSTRAINT = 'users_email_key';
const SALT_ROUNDS = 10;

export async function createMember({ name, phone, colony_id }, actingUserId) {
  if (!name) {
    const err = new Error('name is required');
    err.status = 400;
    throw err;
  }
  if (colony_id && (await colonyExists(colony_id))) {
    await assertColonyAdmin(actingUserId, colony_id);
  }
  try {
    const { rows } = await pool.query(
      'INSERT INTO members (name, phone, colony_id) VALUES ($1, $2, $3) RETURNING *',
      [name, phone ?? null, colony_id ?? null]
    );
    return rows[0];
  } catch (err) {
    if (err.code === FK_VIOLATION) {
      const e = new Error('colony_id does not reference an existing colony');
      e.status = 400;
      throw e;
    }
    if (err.code === UNIQUE_VIOLATION) {
      const e = new Error('a member with that phone already exists in this colony');
      e.status = 409;
      throw e;
    }
    throw err;
  }
}

export async function listMembers({ colony_id, search } = {}) {
  const conditions = [];
  const params = [];
  if (colony_id) {
    params.push(colony_id);
    conditions.push(`colony_id = $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(name ILIKE $${params.length} OR phone ILIKE $${params.length})`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT * FROM members ${where} ORDER BY member_id`,
    params
  );
  return rows;
}

export async function getMember(id) {
  const { rows } = await pool.query('SELECT * FROM members WHERE member_id = $1', [id]);
  if (!rows[0]) {
    const err = new Error('member not found');
    err.status = 404;
    throw err;
  }
  return rows[0];
}

export async function updateMember(id, { name, phone }) {
  await getMember(id);
  const { rows } = await pool.query(
    `UPDATE members SET
       name = COALESCE($2, name),
       phone = COALESCE($3, phone)
     WHERE member_id = $1
     RETURNING *`,
    [id, name ?? null, phone ?? null]
  );
  return rows[0];
}

// Applies the same scoping rule `createMember` already uses: a colony-scoped
// member requires that colony's admin; a legacy unscoped member (colony_id
// IS NULL) allows any authenticated user, matching every other unscoped
// operation on this resource.
async function assertCanActOnMember(member, actingUserId) {
  if (member.colony_id) {
    await assertColonyAdmin(actingUserId, member.colony_id);
  }
}

function normalizeHeader(header) {
  return header.trim().toLowerCase();
}

async function parseCsv(buffer) {
  return parse(buffer, {
    columns: (header) => header.map(normalizeHeader),
    skip_empty_lines: true,
    trim: true,
  });
}

async function parseXlsx(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return [];

  const headers = [];
  sheet.getRow(1).eachCell({ includeEmpty: true }, (cell, colNumber) => {
    headers[colNumber] = normalizeHeader(String(cell.value ?? ''));
  });

  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const record = {};
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const header = headers[colNumber];
      if (!header) return;
      record[header] = cell.value === null || cell.value === undefined ? '' : String(cell.value).trim();
    });
    rows.push(record);
  });
  return rows;
}

async function parseRoster(file) {
  const filename = (file.originalname || '').toLowerCase();
  if (filename.endsWith('.csv')) {
    return parseCsv(file.buffer);
  }
  if (filename.endsWith('.xlsx') || filename.endsWith('.xls')) {
    return parseXlsx(file.buffer);
  }
  const err = new Error('file must be a .csv or .xlsx file');
  err.status = 400;
  throw err;
}

export async function bulkImportMembers({ colony_id, initial_password, file }, actingUserId) {
  if (!colony_id) {
    const err = new Error('colony_id is required');
    err.status = 400;
    throw err;
  }
  if (!initial_password) {
    const err = new Error('initial_password is required');
    err.status = 400;
    throw err;
  }
  if (!file) {
    const err = new Error('file is required');
    err.status = 400;
    throw err;
  }
  if (!(await colonyExists(colony_id))) {
    const err = new Error('colony_id does not reference an existing colony');
    err.status = 400;
    throw err;
  }
  await assertColonyAdmin(actingUserId, colony_id);

  const rows = await parseRoster(file);

  const created = [];
  const skipped = [];
  const errors = [];

  for (let i = 0; i < rows.length; i++) {
    const rowNumber = i + 1;
    const row = rows[i];
    const name = row.name?.trim();
    const phone = row.phone?.trim();
    const email = row.email?.trim() || null;
    const password = row.password?.trim() || initial_password;

    if (!name || !phone) {
      errors.push({ row: rowNumber, phone: phone || null, reason: 'name and phone are required' });
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: memberRows } = await client.query(
        'INSERT INTO members (name, phone, colony_id) VALUES ($1, $2, $3) RETURNING *',
        [name, phone, colony_id]
      );
      const member = memberRows[0];

      if (email) {
        const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
        const { rows: userRows } = await client.query(
          'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING user_id',
          [email, passwordHash]
        );
        await client.query('UPDATE members SET user_id = $2 WHERE member_id = $1', [
          member.member_id,
          userRows[0].user_id,
        ]);
      }

      await client.query('COMMIT');
      created.push({
        row: rowNumber,
        member_id: member.member_id,
        name,
        phone,
        login_granted: Boolean(email),
        ...(email ? { email } : {}),
      });
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === UNIQUE_VIOLATION && err.constraint === MEMBERS_PHONE_CONSTRAINT) {
        skipped.push({ row: rowNumber, phone, reason: 'duplicate phone in this colony' });
      } else if (err.code === UNIQUE_VIOLATION && err.constraint === USERS_EMAIL_CONSTRAINT) {
        errors.push({ row: rowNumber, phone, reason: 'email already registered' });
      } else if (err.code === FK_VIOLATION) {
        errors.push({ row: rowNumber, phone, reason: 'colony_id does not reference an existing colony' });
      } else {
        errors.push({ row: rowNumber, phone, reason: err.message });
      }
    } finally {
      client.release();
    }
  }

  return { created, skipped, errors };
}

export async function grantLogin(memberId, { email, password }, actingUserId) {
  const member = await getMember(memberId);
  await assertCanActOnMember(member, actingUserId);

  if (!email || !password) {
    const err = new Error('email and password are required');
    err.status = 400;
    throw err;
  }
  if (member.user_id) {
    const err = new Error('this member already has a linked login');
    err.status = 409;
    throw err;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    let userRow;
    try {
      const { rows } = await client.query(
        'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING user_id, email',
        [email, passwordHash]
      );
      userRow = rows[0];
    } catch (err) {
      if (err.code === UNIQUE_VIOLATION) {
        const e = new Error('email already registered');
        e.status = 409;
        throw e;
      }
      throw err;
    }
    const { rows: memberRows } = await client.query(
      'UPDATE members SET user_id = $2 WHERE member_id = $1 RETURNING *',
      [memberId, userRow.user_id]
    );
    await client.query('COMMIT');
    return memberRows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function resetPassword(memberId, { password }, actingUserId) {
  const member = await getMember(memberId);
  await assertCanActOnMember(member, actingUserId);

  if (!password) {
    const err = new Error('password is required');
    err.status = 400;
    throw err;
  }
  if (!member.user_id) {
    const err = new Error('this member has no linked login');
    err.status = 400;
    throw err;
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  await pool.query('UPDATE users SET password_hash = $2 WHERE user_id = $1', [member.user_id, passwordHash]);
  return { member_id: Number(memberId), user_id: member.user_id };
}

export async function setColonyRole(memberId, { colony_id, role }, actingUserId) {
  const member = await getMember(memberId);
  if (!member.user_id) {
    const err = new Error('this member has no linked login');
    err.status = 400;
    throw err;
  }
  if (!colony_id) {
    const err = new Error('colony_id is required');
    err.status = 400;
    throw err;
  }

  const alreadyMember = await isColonyMember(member.user_id, colony_id);
  if (alreadyMember) {
    return updateMemberRole(colony_id, actingUserId, member.user_id, role);
  }

  const { rows } = await pool.query('SELECT email FROM users WHERE user_id = $1', [member.user_id]);
  return addColonyMember(colony_id, actingUserId, { email: rows[0]?.email, role });
}
