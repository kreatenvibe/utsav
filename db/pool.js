import pg from 'pg';
import 'dotenv/config';

const { Pool, types } = pg;

// DATE (oid 1082): keep as the raw 'YYYY-MM-DD' string instead of pg's
// default Date-object parsing, which shifts the day when serialized to JSON
// in any timezone ahead of UTC.
types.setTypeParser(1082, (val) => val);

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});
