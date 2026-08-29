import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';

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

export async function parseRoster(file) {
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
