import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { CatalogRepository } from '../server/catalog.js';
import { migrateHostProvider } from '../server/host-schema.js';

// Exact persistence declarations from SecretsService. Values below are synthetic fixtures.
const secretsDDL = `CREATE TABLE IF NOT EXISTS secret_requests (
 id TEXT PRIMARY KEY, agent TEXT NOT NULL, machine TEXT NOT NULL, name TEXT NOT NULL, project TEXT NOT NULL,
 environment TEXT, destination TEXT NOT NULL, reason TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','approved','denied','expired','delivered','failed')),
 scope TEXT, item_ref TEXT, idem_key TEXT NOT NULL, payload_hash TEXT NOT NULL,
 created_at TEXT NOT NULL, expires_at TEXT NOT NULL, decided_at TEXT, delivered_at TEXT, auto INTEGER NOT NULL DEFAULT 0,
 UNIQUE(agent, idem_key));
 CREATE TABLE IF NOT EXISTS secret_grants (
 id TEXT PRIMARY KEY, agent TEXT NOT NULL, machine TEXT NOT NULL, project TEXT NOT NULL, environment TEXT,
 name TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope IN ('machine_project','always')), item_ref TEXT NOT NULL,
 created_at TEXT NOT NULL, revoked_at TEXT);
 CREATE TABLE IF NOT EXISTS secret_audit (
 id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, request_id TEXT, event TEXT NOT NULL, actor TEXT NOT NULL);`;
const oldDDL = `CREATE TABLE provider_connections_fixture_old (
 id TEXT PRIMARY KEY, provider TEXT NOT NULL CHECK(provider IN ('aws','coolify')),
 provider_account_id TEXT NOT NULL, name TEXT NOT NULL, credential_ref TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(provider,provider_account_id))`;
const preserved = ['provider_connections', 'provider_connection_aliases', 'catalog_resources', 'catalog_scopes', 'catalog_projects', 'catalog_project_environments', 'catalog_resource_aliases', 'catalog_resource_projects', 'catalog_services', 'catalog_service_resources', 'operations', 'event_log', 'secret_requests', 'secret_grants', 'secret_audit', 'push_subscriptions', 'push_outbox', 'settings'];
const dump = (db: DatabaseSync) => Object.fromEntries(preserved.map(table => [table, db.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all()]));
function oldDatabase(path: string) {
  const store = new Store(path), catalog = new CatalogRepository(store);
  const at = '2026-11-14T10:00:00.000Z';
  const connection = catalog.registerConnection({ provider: 'aws', providerAccountId: '123456789012', name: 'fixture', credentialRef: 'server-config:fixture' });
  catalog.reconcileScope(connection.id, 'aws:ec2:us-east-1', [{ providerId: 'i-fixture', resourceType: 'ec2-instance', region: 'us-east-1', name: 'fixture', state: 'running', detail: 'fixture', observedAt: at, tags: { Project: 'fixture-project', Environment: 'test' }, aliases: ['aws:fixture:i-fixture'] }], { complete: true, observedAt: at });
  catalog.configureServices([{ key: 'fixture-service', name: 'Fixture service', criticality: 'normal', relations: [{ resourceId: 'aws:fixture:i-fixture', relationType: 'hosted_on', evidence: 'operator_confirmed' }] }]);
  store.db.exec(secretsDDL);
  store.db.prepare(`INSERT INTO secret_requests(id,agent,machine,name,project,destination,reason,state,scope,item_ref,idem_key,payload_hash,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('request-fixture', 'fixture-agent', 'fixture-machine', 'FIXTURE_KEY', 'fixture-project', '{"kind":"process"}', 'fixture reason', 'approved', 'always', 'vault-fixture-reference', 'fixture-idem', 'fixture-hash', at, '2099-01-01T00:00:00.000Z');
  store.db.prepare('INSERT INTO secret_grants(id,agent,machine,project,name,scope,item_ref,created_at) VALUES (?,?,?,?,?,?,?,?)').run('grant-fixture', 'fixture-agent', 'fixture-machine', 'fixture-project', 'FIXTURE_KEY', 'always', 'vault-fixture-reference', at);
  store.db.prepare('INSERT INTO secret_audit(at,request_id,event,actor) VALUES (?,?,?,?)').run(at, 'request-fixture', 'approved', 'fixture-human');
  store.db.prepare('INSERT INTO operations VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('operation-fixture', 'fixture-human', 'idem', 'fingerprint', 'aws:fixture:i-fixture', 'fixture', 'refresh', 'succeeded', 'fixture result', at, at);
  store.db.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('fixture-private-binding', 'synthetic-private-value');
  store.db.prepare('INSERT INTO push_subscriptions(id,endpoint_hash,ciphertext,preferences,created_at) VALUES (?,?,?,?,?)').run('subscription-fixture', 'fixture-hash', 'fixture-encrypted-payload', '{}', at);
  store.db.prepare('INSERT INTO push_outbox(id,event_key,subscription_id,payload,state,next_attempt_at,created_at) VALUES (?,?,?,?,?,?,?)').run('outbox-fixture', 'fixture-event', 'subscription-fixture', '{}', 'pending', 0, at);
  store.close();
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON;
    DROP TABLE host_observation_state; DROP TABLE host_observation_boots; DROP TABLE host_enrollments;
    DROP TABLE host_schema_migrations;
    ${oldDDL};
    INSERT INTO provider_connections_fixture_old SELECT * FROM provider_connections;
    DROP TABLE provider_connections;
    ALTER TABLE provider_connections_fixture_old RENAME TO provider_connections;
    PRAGMA legacy_alter_table=OFF; PRAGMA foreign_keys=ON;
    CREATE INDEX fixture_provider_credential ON provider_connections(credential_ref);
    CREATE UNIQUE INDEX fixture_provider_active_name ON provider_connections(name) WHERE state='active';
    CREATE TABLE fixture_provider_audit(value TEXT NOT NULL);
    CREATE TRIGGER fixture_provider_update AFTER UPDATE OF name ON provider_connections BEGIN INSERT INTO fixture_provider_audit(value) VALUES (NEW.name); END;`);
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  return db;
}
function temporary() {
  const directory = mkdtempSync(join(tmpdir(), 'infra-host-migration-'));
  return { path: join(directory, 'infra.sqlite'), remove: () => rmSync(directory, { recursive: true, force: true }) };
}

describe('versioned host provider migration', () => {
  it('preserves populated production tables, secret references, FKs, indices and triggers', () => {
    const temp = temporary(); let db: DatabaseSync | undefined;
    try {
      db = oldDatabase(temp.path); const before = dump(db);
      const objects = db.prepare("SELECT type,name,sql FROM sqlite_master WHERE tbl_name='provider_connections' AND sql IS NOT NULL AND type IN ('trigger','index') ORDER BY name").all();
      migrateHostProvider(db);
      expect(dump(db)).toEqual(before);
      expect(db.prepare("SELECT type,name,sql FROM sqlite_master WHERE tbl_name='provider_connections' AND sql IS NOT NULL AND type IN ('trigger','index') ORDER BY name").all()).toEqual(objects);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(db.prepare('PRAGMA foreign_key_list(catalog_resources)').all().some(row => row.table === 'provider_connections')).toBe(true);
      db.prepare("UPDATE provider_connections SET name='trigger-proved'").run();
      expect(db.prepare('SELECT value FROM fixture_provider_audit').all()).toEqual([{ value: 'trigger-proved' }]);
      expect(() => db!.prepare("INSERT INTO provider_connection_aliases VALUES ('orphan','missing')").run()).toThrow();
    } finally { db?.close(); temp.remove(); }
  });
  it('preserves uniqueness, permits host, is idempotent and reopens through Store', () => {
    const temp = temporary(); let db: DatabaseSync | undefined, store: Store | undefined;
    try {
      db = oldDatabase(temp.path); migrateHostProvider(db); migrateHostProvider(db);
      expect(db.prepare('SELECT COUNT(*) AS count FROM host_schema_migrations').get()?.count).toBe(1);
      db.prepare("INSERT INTO provider_connections VALUES ('host-fixture','host','opaque-fixture','host','native','active','at','at')").run();
      expect(() => db!.prepare("INSERT INTO provider_connections VALUES ('duplicate','host','opaque-fixture','other','native','active','at','at')").run()).toThrow();
      db.close(); db = undefined;
      store = new Store(temp.path);
      expect(store.db.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
      expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(store.db.prepare('SELECT item_ref FROM secret_grants').get()?.item_ref).toBe('vault-fixture-reference');
      const first = store.hostObservations.bind('fixture-host', 'a'.repeat(64));
      store.close(); store = new Store(temp.path);
      expect(store.hostObservations.bind('fixture-host', 'a'.repeat(64))).toEqual(first);
      expect(() => store!.hostObservations.bind('fixture-host', 'b'.repeat(64))).toThrow('enrollment_conflict');
    } finally { db?.close(); store?.close(); temp.remove(); }
  });
  it('rolls back when a dependent index cannot be restored and reenables FK enforcement', () => {
    const temp = temporary(); let db: DatabaseSync | undefined;
    try {
      db = oldDatabase(temp.path);
      db.exec("CREATE INDEX fixture_expression_index ON provider_connections(lower(name))");
      const before = dump(db);
      // A view named like the reserved replacement makes CREATE TABLE fail before any destructive step.
      db.exec('CREATE VIEW provider_connections_host_v1 AS SELECT id FROM provider_connections');
      expect(() => migrateHostProvider(db!)).toThrow();
      expect(dump(db)).toEqual(before);
      expect(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
      expect(db.prepare("SELECT sql FROM sqlite_master WHERE name='provider_connections'").get()?.sql).not.toContain("'host'");
      db.exec('DROP VIEW provider_connections_host_v1'); migrateHostProvider(db);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='fixture_expression_index'").get()).toBeDefined();
    } finally { db?.close(); temp.remove(); }
  });
  it('checks all foreign keys and preserves the old database on violation', () => {
    const temp = temporary(); let db: DatabaseSync | undefined;
    try {
      db = oldDatabase(temp.path);
      db.exec("PRAGMA foreign_keys=OFF; INSERT INTO provider_connection_aliases VALUES ('bad-fixture','missing-fixture'); PRAGMA foreign_keys=ON");
      const before = dump(db);
      expect(() => migrateHostProvider(db!)).toThrow('foreign key violation');
      expect(dump(db)).toEqual(before);
      expect(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
    } finally { db?.close(); temp.remove(); }
  });
});
