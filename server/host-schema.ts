import type { DatabaseSync } from 'node:sqlite';

const VERSION = 1;
const check = /CHECK\s*\(\s*provider\s+IN\s*\(\s*'aws'\s*,\s*'coolify'\s*(?:,\s*'host'\s*)?\)\s*\)/i;
const identifier = (value: string) => '"' + value.replaceAll('"', '""') + '"';
const assertForeignKeys = (db: DatabaseSync): void => {
  if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Host migration foreign key violation');
};
export function migrateHostProvider(db: DatabaseSync): void {
  // This function is called outside Store.atomic(). Never rename the old parent.
  db.exec('PRAGMA foreign_keys=ON');
  const legacy = Number(db.prepare('PRAGMA legacy_alter_table').get()?.legacy_alter_table ?? 0);
  let transaction = false;
  try {
    if (Number(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys) !== 1) throw new Error('Host migration requires no active transaction');
    assertForeignKeys(db);
    db.exec('CREATE TABLE IF NOT EXISTS host_schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='provider_connections'").get() as { sql: string } | undefined;
    if (!row || !check.test(row.sql)) throw new Error('Unsupported provider connections schema');
    const done = db.prepare('SELECT version FROM host_schema_migrations WHERE version=?').get(VERSION);
    const supportsHost = /'host'/.test(row.sql.match(check)?.[0] ?? '');
    if (done) {
      if (!supportsHost) throw new Error('Host migration version mismatch');
      return;
    }
    const objects = db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='provider_connections' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name").all() as Array<{ sql: string }>;
    const columns = db.prepare('PRAGMA table_xinfo(provider_connections)').all() as Array<{ name: string; hidden: number }>;
    const names = columns.filter(column => column.hidden === 0).map(column => identifier(column.name));
    if (!names.length) throw new Error('Empty provider connections schema');
    db.exec('PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON');
    if (Number(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys) !== 0) throw new Error('Host migration requires no active transaction');
    db.exec('BEGIN IMMEDIATE'); transaction = true;
    if (!supportsHost) {
      const ddl = row.sql.replace(check, "CHECK(provider IN ('aws','coolify','host'))").replace(/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"provider_connections"|`provider_connections`|\[provider_connections\]|provider_connections)/i, 'CREATE TABLE provider_connections_host_v1');
      if (!ddl.startsWith('CREATE TABLE provider_connections_host_v1')) throw new Error('Unsupported provider table declaration');
      db.exec(ddl);
      const fields = /WITHOUT\s+ROWID/i.test(row.sql) ? names : ['rowid', ...names];
      const list = fields.join(',');
      db.exec(`INSERT INTO provider_connections_host_v1(${list}) SELECT ${list} FROM provider_connections`);
      db.exec('DROP TABLE provider_connections');
      db.exec('ALTER TABLE provider_connections_host_v1 RENAME TO provider_connections');
      for (const object of objects) db.exec(object.sql);
    }
    assertForeignKeys(db);
    db.prepare('INSERT INTO host_schema_migrations(version,applied_at) VALUES (?,?)').run(VERSION, new Date().toISOString());
    db.exec('COMMIT'); transaction = false;
  } catch (error) {
    if (transaction) db.exec('ROLLBACK');
    throw error;
  } finally {
    db.exec(`PRAGMA legacy_alter_table=${legacy === 1 ? 'ON' : 'OFF'}; PRAGMA foreign_keys=ON`);
    if (Number(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys) !== 1) throw new Error('Foreign key enforcement unavailable');
  }
  assertForeignKeys(db);
}
