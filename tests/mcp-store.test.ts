import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { Store } from '../server/store.js';
import type { Resource } from '../server/types.js';

const resource: Resource = { id: 'aws:test:i-example123', name: 'Example', kind: 'ec2', state: 'running', location: 'us-east-1', account: 'test', detail: 't3.small', actions: ['stop'], observedAt: '2026-10-23T01:00:00.000Z' };

it('guarda planes MCP durables, idempotentes y ligados al actor y a la evidencia', () => {
  const store = new Store(':memory:');
  const plan = store.createOperationPlan('infra', 'plan-key', resource, 'stop', '2026-10-23T01:00:00.000Z', 1000);
  expect(plan.status).toBe('created');
  expect(store.createOperationPlan('infra', 'plan-key', resource, 'stop', '2026-10-23T01:00:00.000Z', 2000)).toMatchObject({ status: 'existing', plan: { id: plan.plan.id } });
  expect(store.createOperationPlan('infra', 'plan-key', resource, 'start', '2026-10-23T01:00:00.000Z', 2000).status).toBe('conflict');
  expect(store.operationPlan(plan.plan.id)).toMatchObject({ actor: 'infra', resourceId: resource.id, action: 'stop', state: 'planned', expiresAt: '1970-01-01T00:05:01.000Z' });
  store.close();
});

it('entrega incidentes por consumidor con lease estable y ACK idempotente ligado a versión', () => {
  const store = new Store(':memory:');
  const initial = store.latestEventId();
  expect(store.leaseIncidentDeliveries('infra', 10, 500).deliveries).toEqual([]);
  store.appendEvent('incident', 'resource:one', { category: 'infrastructure', resourceId: 'resource:one', from: 'running', to: 'stopped' });

  const delivery = store.leaseIncidentDeliveries('infra', 10, 1000, 60_000).deliveries[0];
  expect(delivery).toMatchObject({ consumer: 'infra', version: String(initial + 1), attempts: 1 });
  expect(store.leaseIncidentDeliveries('infra', 10, 2000, 60_000).deliveries[0].id).toBe(delivery.id);
  expect(store.acknowledgeIncidentDelivery('infra', delivery.id, delivery.version, 2000)).toBe('acknowledged');
  expect(store.acknowledgeIncidentDelivery('infra', delivery.id, delivery.version, 3000)).toBe('duplicate');
  expect(store.acknowledgeIncidentDelivery('other', delivery.id, delivery.version, 3000)).toBe('not_found');

  store.appendEvent('incident', 'resource:two', { category: 'infrastructure', resourceId: 'resource:two' });
  const expired = store.leaseIncidentDeliveries('infra', 10, 1000, 1).deliveries[0];
  expect(store.acknowledgeIncidentDelivery('infra', expired.id, 'wrong', 1000)).toBe('stale_version');
  expect(store.acknowledgeIncidentDelivery('infra', expired.id, expired.version, 2000)).toBe('lease_expired');
  expect(store.leaseIncidentDeliveries('infra', 10, 2000, 60_000).deliveries[0].id).toBe(expired.id);
  store.close();
});

it('solo crea leases para la página devuelta y no agota entregas todavía no ofrecidas', () => {
  const store = new Store(':memory:');
  const initialCursor = store.leaseIncidentDeliveries('paged-consumer', 2, 500).cursor;
  for (let index = 1; index <= 5; index++) store.appendEvent('incident', `resource:${index}`, { category: 'infrastructure', resourceId: `resource:${index}` });

  const first = store.leaseIncidentDeliveries('paged-consumer', 2, 1000, 60_000);
  expect(first.deliveries.map(row => row.eventId)).toEqual([initialCursor + 1, initialCursor + 2]);
  expect(first.deliveries.every(row => row.attempts === 1)).toBe(true);
  expect(store.incidentDeliveryHealth('paged-consumer')).toMatchObject({ leased: 2, dead: 0 });
  for (const row of first.deliveries) expect(store.acknowledgeIncidentDelivery('paged-consumer', row.id, row.version, 1001)).toBe('acknowledged');

  const second = store.leaseIncidentDeliveries('paged-consumer', 2, 1002, 60_000);
  expect(second.deliveries.map(row => row.eventId)).toEqual([initialCursor + 3, initialCursor + 4]);
  expect(store.incidentDeliveryHealth('paged-consumer')).toMatchObject({ leased: 2, acked: 2, dead: 0 });
  for (const row of second.deliveries) expect(store.acknowledgeIncidentDelivery('paged-consumer', row.id, row.version, 1003)).toBe('acknowledged');

  const last = store.leaseIncidentDeliveries('paged-consumer', 2, 1004, 60_000);
  expect(last.deliveries.map(row => row.eventId)).toEqual([initialCursor + 5]);
  expect(store.incidentDeliveryHealth('paged-consumer')).toMatchObject({ leased: 1, acked: 4, dead: 0 });
  store.close();
});

it('reintenta un incidente con lease vencido aunque el log haya retirado su evento', () => {
  const store=new Store(':memory:');
  const cursor=store.leaseIncidentDeliveries('retained-consumer',5,1000).cursor;
  store.appendEvent('incident','aws:test:i-lost',{category:'infrastructure',resourceId:'aws:test:i-lost',to:'stopped'});
  const first=store.leaseIncidentDeliveries('retained-consumer',5,2000,10_000).deliveries[0]!;
  expect(first.eventId).toBe(cursor+1);
  store.db.prepare('DELETE FROM event_log WHERE id=?').run(first.eventId);
  const retry=store.leaseIncidentDeliveries('retained-consumer',5,12_001,10_000).deliveries;
  expect(retry).toMatchObject([{id:first.id,eventId:first.eventId,attempts:2,payload:{resourceId:'aws:test:i-lost'}}]);
  store.close();
});

it('migra leases antiguos a una identidad propia antes de que venza el evento retenido',()=>{
  const dir=mkdtempSync(join(tmpdir(),'infra-lease-aggregate-migration-')),path=join(dir,'test.sqlite'),db=new DatabaseSync(path);
  db.exec(`CREATE TABLE event_log(id INTEGER PRIMARY KEY AUTOINCREMENT,type TEXT NOT NULL,aggregate_id TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE mcp_consumers(consumer TEXT PRIMARY KEY,cursor INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE mcp_incident_deliveries(id TEXT PRIMARY KEY,consumer TEXT NOT NULL,event_id INTEGER NOT NULL,version TEXT NOT NULL,payload TEXT NOT NULL,
      status TEXT NOT NULL,attempts INTEGER NOT NULL,lease_until TEXT NOT NULL,acked_at TEXT,UNIQUE(consumer,event_id));`);
  const now=Date.now(),payload={resourceId:'aws:test:i-legacy',category:'infrastructure'};
  db.prepare('INSERT INTO event_log(id,type,aggregate_id,payload,created_at) VALUES (42,?,?,?,?)').run('incident','aws:test:i-legacy',JSON.stringify(payload),new Date(now-60_000).toISOString());
  db.prepare('INSERT INTO mcp_consumers(consumer,cursor,created_at,updated_at) VALUES (?,?,?,?)').run('legacy',42,new Date(now-60_000).toISOString(),new Date(now-60_000).toISOString());
  db.prepare("INSERT INTO mcp_incident_deliveries(id,consumer,event_id,version,payload,status,attempts,lease_until) VALUES (?,?,?,?,?,'leased',1,?)")
    .run('old-lease','legacy',42,'42',JSON.stringify(payload),new Date(now-1).toISOString());
  db.close();
  const store=new Store(path);store.db.prepare('DELETE FROM event_log WHERE id=42').run();
  const retry=store.leaseIncidentDeliveries('legacy',5,now,60_000,(_payload,aggregateId)=>aggregateId==='aws:test:i-legacy').deliveries;
  expect(retry).toMatchObject([{id:'old-lease',attempts:2}]);
  store.close();rmSync(dir,{recursive:true});
});
