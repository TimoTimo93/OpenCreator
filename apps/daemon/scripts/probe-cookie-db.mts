import Database from 'better-sqlite3';

const dbPath = process.argv[2];
const db = new Database(dbPath, { readonly: true });
const rows = db.prepare(`SELECT name, host_key, length(encrypted_value) AS enc, length(value) AS val, is_persistent, expires_utc, samesite FROM cookies WHERE host_key LIKE '%tiktok%' ORDER BY name`).all();
console.log(JSON.stringify(rows, null, 1));
db.close();
