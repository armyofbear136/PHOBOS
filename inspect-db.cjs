/**
 * inspect-db.cjs — Quick report of every table in a DuckDB file.
 * Usage: node inspect-db.cjs "C:\path\to\phobos.duckdb.pre-e1.backup"
 * Read-only — will not modify the file.
 */

async function main() {
  const dbPath = process.argv[2];
  if (!dbPath) {
    console.error('Usage: node inspect-db.cjs <path-to.duckdb>');
    process.exit(1);
  }

  let db;
  try {
    const mod = require('duckdb-async');
    const DbClass =
      (mod.Database && typeof mod.Database.create === 'function') ? mod.Database :
      (mod.default && mod.default.Database && typeof mod.default.Database.create === 'function') ? mod.default.Database :
      (typeof mod.create === 'function') ? mod :
      (mod.default && typeof mod.default.create === 'function') ? mod.default :
      null;
    if (!DbClass) throw new Error('Unknown export shape: ' + JSON.stringify(Object.keys(mod)));
    db = await DbClass.create(dbPath, { access_mode: 'READ_ONLY' });
  } catch (e) {
    console.log('duckdb-async failed (' + e.message + '), trying raw duckdb...');
    const duckdb = require('duckdb');
    const DbClass = duckdb.Database ?? duckdb.default?.Database ?? duckdb;
    const rawDb = await new Promise((res, rej) => {
      const inst = new DbClass(dbPath, { access_mode: 'READ_ONLY' }, (err) => err ? rej(err) : res(inst));
    });
    db = {
      connect: () => Promise.resolve({
        all: (sql, ...args) => new Promise((rs, rj) => rawDb.all(sql, ...args, (e, r) => e ? rj(e) : rs(r))),
        close: () => Promise.resolve(),
      }),
      close: () => new Promise((rs, rj) => rawDb.close((e) => e ? rj(e) : rs())),
    };
  }

  const conn = await db.connect();
  console.log('\nInspecting: ' + dbPath);
  console.log('='.repeat(70));

  let tables = [];
  try {
    tables = await conn.all(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'main' AND table_type = 'BASE TABLE'
       ORDER BY table_name`
    );
  } catch (e) {
    console.error('Failed to list tables:', e.message);
    await conn.close(); await db.close(); process.exit(1);
  }

  if (tables.length === 0) console.log('(no tables found)');

  for (const { table_name } of tables) {
    let rowCount = '?';
    try {
      const r = await conn.all(`SELECT COUNT(*) AS n FROM "${table_name}"`);
      rowCount = String(r[0]?.n ?? 0);
    } catch (e) { rowCount = 'ERR:' + e.message.split('\n')[0]; }

    let cols = [];
    try {
      cols = await conn.all(
        `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_schema = 'main' AND table_name = ?
         ORDER BY ordinal_position`,
        table_name
      );
    } catch (e) { cols = [{ column_name: 'ERR', data_type: e.message.split('\n')[0] }]; }

    const colStr = cols.map(c => c.column_name + ':' + c.data_type).join('  ');
    console.log('\n  TABLE: ' + table_name + '  (' + rowCount + ' rows)');
    console.log('  COLS:  ' + colStr);
  }

  console.log('\n' + '='.repeat(70));
  console.log('Total tables: ' + tables.length);

  await conn.close();
  await db.close();
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
