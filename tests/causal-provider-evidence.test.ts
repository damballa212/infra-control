import { createECDH } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../server/store.js';
import { CatalogRepository } from '../server/catalog.js';
import { AwsCloudEventIngest } from '../server/cloud-events.js';
import { InfrastructureMonitor } from '../server/monitor.js';
import { PushService, type PushTransport } from '../server/push.js';
import { tokenHash } from '../server/auth.js';
import type { CostReport } from '../server/costs.js';
import type { AwsAccount } from '../server/types.js';

const base = Date.parse('2026-11-13T12:00:00.000Z');
const iso = (offset = 0) => new Date(base + offset).toISOString();
const account: AwsAccount = { name: 'one', accountId: '123456789012', accessKeyId: 'fixture', secretAccessKey: 'fixture' };
const instanceId = 'i-0123456789abcdef0', alias = `aws:one:${instanceId}`;
const credential = 'event-fixture-0123456789abcdef0123456789';
const costs: CostReport = { accounts: [], fetchedAt: iso(), nextRefreshAt: iso(86400000), periodStart: '2026-11-01', periodEnd: '2026-11-13', policy: 'fixture' };
const closers: Array<() => void> = [];
const curve = createECDH('prime256v1'); curve.setPrivateKey(Buffer.alloc(32, 7));
const pushConfig = { vapidPublicKey: curve.getPublicKey('base64url'), vapidPrivateKey: curve.getPrivateKey('base64url'), vapidSubject: 'mailto:fixture@example.test', encryptionKeyHex: '4'.repeat(64) };

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(base); });
afterEach(() => { closers.splice(0).reverse().forEach(close => close()); vi.useRealTimers(); });
function fixture() {
  const store = new Store(':memory:'); closers.push(() => store.close());
  const catalog = new CatalogRepository(store);
  const connection = catalog.registerConnection({ provider: 'aws', providerAccountId: account.accountId, name: account.name, credentialRef: 'fixture' });
  const snapshot = { providerId: instanceId, resourceType: 'ec2-instance', region: 'us-east-1', name: 'Host', state: 'running', detail: 'fixture', observedAt: iso(), aliases: [alias] };
  catalog.reconcileScope(connection.id, 'aws:ec2:us-east-1', [snapshot], { complete: true, observedAt: iso() });
  const send = vi.fn<PushTransport['send']>(async () => ({ statusCode: 201 }));
  const push = new PushService(store, pushConfig, { send }); closers.push(() => push.close());
  push.register({ endpoint: 'https://fcm.googleapis.com/fcm/send/causal-fixture', keys: { p256dh: curve.getPublicKey('base64url'), auth: Buffer.alloc(16, 1).toString('base64url') } }, { operations: false, devices: false, infrastructure: true, router: false, budgets: false, secrets: false, secretDeliveries: false });
  const inventory = () => catalog.listResources().map(record => catalog.asResource(record));
  const monitor = new InfrastructureMonitor(store, { inventory: async () => [], perform: async () => ({ message: 'unused' }) }, { get: async () => costs }, Date.now, async () => inventory());
  closers.push(() => monitor.close());
  return { store, catalog, connection, snapshot, monitor, push, send, inventory };
}

describe('clasificación causal compartida de evidencia aceptada', () => {
  it('Catalog → inbox EventBridge → monitor no alerta por stopping/stopped solicitados, pero sí por otra caída posterior', async () => {
    const f = fixture(); await f.monitor.tick();
    const operation = f.store.create('Admin', 'active-stop', 'fixture', f.inventory()[0]!, 'stop');
    f.store.update(operation.id, 'running', 'Comprobando parada.');
    const ingest = new AwsCloudEventIngest(f.store, f.catalog, [account], { [account.accountId]: tokenHash(credential) }, event => {
      if (event.resource) f.monitor.observeAwsEvent(f.catalog.asResource(event.resource), event.previousState, event.eventId);
    }); closers.push(() => ingest.close());
    async function event(state: 'stopping' | 'stopped' | 'running', offset: number) {
      vi.setSystemTime(base + offset);
      ingest.accept(credential, { id: `event-${offset}`, source: 'aws.ec2', 'detail-type': 'EC2 Instance State-change Notification', account: account.accountId, region: 'us-east-1', time: iso(offset), detail: { 'instance-id': instanceId, state } });
      await ingest.drain(); await f.push.flush();
    }
    await event('stopping', 1000);
    await event('stopped', 2000);
    expect(f.store.cloudEventHealth()).toMatchObject({ pending: 0, processed: 2 });
    expect(f.store.db.prepare('SELECT consumed_at AS consumedAt FROM expected_transitions WHERE operation_id=?').get(operation.id)).toMatchObject({ consumedAt: iso(2000) });
    expect(f.store.get(operation.id)?.state).toBe('running');
    expect(f.store.incidentEventsAfter(0, 100).filter(row => row.payload.transitionReason === 'provider_state_changed')).toEqual([]);
    expect(f.send).not.toHaveBeenCalled();
    const canonical = `catalog:${f.catalog.resolveAlias(alias)!.catalogId}`;
    const eventAlias = `aws:${account.accountId}:us-east-1:${instanceId}`;
    for (const id of [alias, canonical, eventAlias]) {
      expect(f.store.expectations.wasExpectedEvidence(id, 'stopped', iso(2000))).toBe(true);
      expect(f.store.expectations.wasExpectedEvidence(id, 'stopped', iso(2001))).toBe(false);
      expect(f.store.expectations.wasExpectedEvidence(id, 'running', iso(2000))).toBe(false);
    }
    await event('running', 3000);
    await event('stopped', 4000);
    expect(f.store.incidentEventsAfter(0, 100).filter(row => row.payload.transitionReason === 'provider_state_changed').map(row => row.payload.to)).toEqual(['running', 'stopped']);
    expect(f.send.mock.calls.map(call => (JSON.parse(call[1]) as { title: string }).title)).toEqual(['Host se encendió', 'Host se detuvo']);
    expect(f.store.expectations.wasExpectedEvidence(alias, 'stopped', iso(4000))).toBe(false);
    expect(f.store.get(operation.id)?.state).toBe('running');
  });

  it('el discovery conserva la clasificación de la primera muestra consumida durante la histéresis del monitor', async () => {
    const f = fixture(); await f.monitor.tick();
    const operation = f.store.create('Admin', 'scan-stop', 'fixture', f.inventory()[0]!, 'stop');
    f.store.update(operation.id, 'running', 'Comprobando parada.');
    async function scan(state: string, offset: number) {
      vi.setSystemTime(base + offset);
      f.catalog.reconcileScope(f.connection.id, 'aws:ec2:us-east-1', [{ ...f.snapshot, state, observedAt: iso(offset) }], { complete: true, observedAt: iso(offset) });
      await f.monitor.tick(); await f.push.flush();
    }
    await scan('stopping', 1000);
    await scan('stopped', 2000);
    await scan('stopped', 3000);
    expect(f.store.incidentEventsAfter(0, 100).filter(row => row.payload.transitionReason === 'provider_state_changed')).toEqual([]);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.store.get(operation.id)?.state).toBe('running');
    await scan('running', 4000); await scan('running', 5000);
    await scan('stopped', 6000); await scan('stopped', 7000);
    expect(f.store.incidentEventsAfter(0, 100).filter(row => row.payload.transitionReason === 'provider_state_changed').map(row => row.payload.to)).toEqual(['running', 'stopped']);
    expect(f.send).toHaveBeenCalledTimes(2);
  });

  it('persiste la clasificación exacta al reabrir SQLite sin extenderla a otra observación', () => {
    const directory = mkdtempSync(join(tmpdir(), 'infra-causal-evidence-'));
    const path = join(directory, 'infra.sqlite'); let store: Store | undefined;
    try {
      store = new Store(path); const catalog = new CatalogRepository(store);
      const connection = catalog.registerConnection({ provider: 'aws', providerAccountId: account.accountId, name: 'one', credentialRef: 'fixture' });
      const snapshot = { providerId: instanceId, resourceType: 'ec2-instance', region: 'us-east-1', name: 'Host', state: 'running', detail: 'fixture', observedAt: iso(), aliases: [alias] };
      catalog.reconcileScope(connection.id, 'aws:ec2:us-east-1', [snapshot], { complete: true, observedAt: iso() });
      const operation = store.create('Admin', 'durable-stop', 'fixture', catalog.asResource(catalog.listResources()[0]!), 'stop');
      vi.setSystemTime(base + 1000);
      catalog.applyAwsStateEvent({ accountId: account.accountId, region: 'us-east-1', instanceId, state: 'stopped', eventTime: iso(1000), eventId: 'durable-event' });
      store.close(); store = undefined;
      store = new Store(path);
      expect(store.expectations.wasExpectedEvidence(alias, 'stopped', iso(1000))).toBe(true);
      expect(store.expectations.wasExpectedEvidence(alias, 'stopped', iso(1001))).toBe(false);
      expect(store.get(operation.id)?.state).toBe('uncertain');
    } finally { store?.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});
