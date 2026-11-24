import { describe, expect, it, vi } from 'vitest';
import { CatalogRepository } from '../server/catalog.js';
import { tokenHash } from '../server/auth.js';
import { AwsCloudEventIngest } from '../server/cloud-events.js';
import { Store } from '../server/store.js';

const accountId = '123456789012';
const account = { name: 'one', accountId, accessKeyId: 'fixture', secretAccessKey: 'fixture' };
const start = Date.parse('2026-10-23T00:00:00Z');
const event = (id: string, state: string, time: string, account = accountId) => ({
  version: '0', id, source: 'aws.ec2', 'detail-type': 'EC2 Instance State-change Notification', account,
  region: 'us-east-1', time, resources: ['arn:aws:ec2:us-east-1:123456789012:instance/i-example1'], detail: { 'instance-id': 'i-example1', state }
});
const eventToken='event-token-0123456789abcdef0123456789';
function fixture() {
  const store = new Store(':memory:'), catalog = new CatalogRepository(store);
  const connection = catalog.registerConnection({ provider: 'aws', providerAccountId: accountId, name: account.name, credentialRef: 'fixture' });
  catalog.reconcileScope(connection.id, 'aws:ec2:us-east-1', [], { complete: true, observedAt: new Date(start - 1000).toISOString() });
  const onApplied = vi.fn();
  const ingest = new AwsCloudEventIngest(store, catalog, [account], { [accountId]: tokenHash(eventToken) }, onApplied, () => start + 60_000);
  return { store, catalog, ingest, onApplied };
}

describe('ingesta durable de estados AWS', () => {
  it('autentica por cuenta, persiste antes de ACK y procesa sin conceder acciones', async () => {
    const f = fixture();
    const received = f.ingest.accept(eventToken, event('event-running', 'running', new Date(start).toISOString()));
    expect(received).toEqual({ status: 'accepted', eventKey: `${accountId}:event-running` });
    expect(f.catalog.listResources()).toHaveLength(0);
    expect(f.store.pendingCloudEvents()).toHaveLength(1);
    await f.ingest.drain();
    expect(f.catalog.listResources()[0]).toMatchObject({ state: 'running', observedAt: new Date(start).toISOString(), aliases: expect.arrayContaining(['aws:123456789012:us-east-1:i-example1']) });
    expect(f.catalog.asResource(f.catalog.listResources()[0]!).actions).toEqual([]);
    expect(f.onApplied).toHaveBeenCalledTimes(1);
    expect(f.store.pendingCloudEvents()).toHaveLength(0);
    f.store.close();
  });

  it('deduplica reintentos y no permite regresar estado con eventos reordenados', async () => {
    const f = fixture();
    f.ingest.accept(eventToken, event('event-new', 'running', new Date(start + 20_000).toISOString()));
    await f.ingest.drain();
    expect(f.ingest.accept(eventToken, event('event-new', 'running', new Date(start + 20_000).toISOString()))).toMatchObject({ status: 'duplicate' });
    f.ingest.accept(eventToken, event('event-old', 'stopped', new Date(start + 10_000).toISOString()));
    await f.ingest.drain();
    expect(f.catalog.listResources()[0]?.state).toBe('running');
    expect(f.store.cloudEventHealth()).toMatchObject({ pending: 0, processed: 1, ignored: 1 });
    f.store.close();
  });

  it('rechaza token cruzado, cuenta o región sin scope y eventos inválidos', () => {
    const f = fixture();
    expect(() => f.ingest.accept('wrong', event('x', 'running', new Date(start).toISOString()))).toThrow(/autorizado/i);
    expect(() => f.ingest.accept(eventToken, event('x', 'running', new Date(start).toISOString(), '999999999999'))).toThrow(/autorizado/i);
    expect(() => f.ingest.accept(eventToken, { ...event('x', 'running', new Date(start).toISOString()), region: 'eu-west-1' })).toThrow(/región/i);
    expect(() => f.ingest.accept(eventToken, event('x', 'shell', new Date(start).toISOString()))).toThrow(/no válido/i);
    f.store.close();
  });

  it('no confirma si falla la escritura del inbox', () => {
    const f = fixture();
    f.store.db.exec("CREATE TRIGGER fail_cloud_inbox BEFORE INSERT ON cloud_event_inbox BEGIN SELECT RAISE(ABORT, 'fixture'); END");
    expect(() => f.ingest.accept(eventToken, event('event-fail', 'running', new Date(start).toISOString()))).toThrow();
    f.store.close();
  });
});
