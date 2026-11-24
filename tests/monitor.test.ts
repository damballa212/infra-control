import { createECDH, randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { InfrastructureMonitor } from '../server/monitor.js';
import { PushService } from '../server/push.js';
import { Store } from '../server/store.js';
import type { CostReport } from '../server/costs.js';
import type { Resource } from '../server/types.js';

const vapid = createECDH('prime256v1');
vapid.generateKeys();
const pushConfig = { vapidPublicKey: vapid.getPublicKey('base64url'), vapidPrivateKey: vapid.getPrivateKey('base64url'), vapidSubject: 'mailto:owner@example.test', encryptionKeyHex: '3'.repeat(64) };
const subscriptionKeys = (() => { const key = createECDH('prime256v1'); key.generateKeys(); return { p256dh: key.getPublicKey('base64url'), auth: randomBytes(16).toString('base64url') }; })();
const providerResource = (state: string, observedAt: string): Resource => ({ id: 'aws:agents:i-hermes', name: 'orchestrator', kind: 'ec2', state, location: 'us-east-1', account: 'agents', detail: 't4g.large', actions: [], observedAt });
const report = (actual: number, forecast: number): CostReport => ({
  fetchedAt: '2026-10-21T00:00:00.000Z', nextRefreshAt: '2026-10-22T00:00:00.000Z', periodStart: '2026-10-01', periodEnd: '2026-10-21', policy: 'test',
  accounts: [{ account: 'agents', accountId: '123456789012', status: 'available', net: 85, usage: 85, adjustments: 0, currency: 'USD', estimated: true, services: [], daily: [], budgetsStatus: 'available', fetchedAt: '2026-10-21T00:00:00.000Z', budgets: [{ name: 'Mensual', limit: 100, actual, forecast, currency: 'USD', updatedAt: '2026-10-21T00:00:00.000Z' }] }]
});

describe('recolección compartida y alertas de nube', () => {
  it('un evento AWS suprime la transición solicitada y alerta una transición posterior ajena', () => {
    const store=new Store(':memory:');let now=Date.now();
    const monitor=new InfrastructureMonitor(store,{inventory:async()=>[],perform:async()=>({message:'ok'})},{get:async()=>report(0,0)},()=>now);
    const running=providerResource('running',new Date(now).toISOString());
    monitor.observeAwsEvent(running,null,'initial');
    const operation=store.create('Admin','event-stop','fp',running,'stop');store.update(operation.id,'succeeded','Stopped.');
    now+=10_000;monitor.observeAwsEvent(providerResource('stopped',new Date(now).toISOString()),'running','expected-stop');
    expect(store.eventsAfter(0).filter(event=>event.type==='incident')).toHaveLength(0);
    now+=60_000;monitor.observeAwsEvent(providerResource('running',new Date(now).toISOString()),'stopped','external-start');
    expect(store.eventsAfter(0).filter(event=>event.type==='incident')).toHaveLength(1);
    monitor.close();store.close();
  });

  it('correlaciona estados EC2 intermedios pending y stopping con su orden pendiente', () => {
    const store = new Store(':memory:');let now=Date.now();
    const monitor=new InfrastructureMonitor(store,{inventory:async()=>[],perform:async()=>({message:'ok'})},{get:async()=>report(0,0)},()=>now);
    monitor.observeAwsEvent(providerResource('running',new Date(now).toISOString()),null,'baseline');

    const stop=store.create('Admin','intermediate-stop','stop-fp',providerResource('running',new Date(now).toISOString()),'stop');
    now+=1000;monitor.observeAwsEvent(providerResource('stopping',new Date(now).toISOString()),'running','stop-started');
    now+=1000;monitor.observeAwsEvent(providerResource('stopped',new Date(now).toISOString()),'stopping','stop-complete');
    expect(store.eventsAfter(0).filter(event=>event.type==='incident')).toHaveLength(0);
    store.update(stop.id,'succeeded','AWS confirmó stopped.');

    const start=store.create('Admin','intermediate-start','start-fp',providerResource('stopped',new Date(now).toISOString()),'start');
    now+=1000;monitor.observeAwsEvent(providerResource('pending',new Date(now).toISOString()),'stopped','start-started');
    now+=1000;monitor.observeAwsEvent(providerResource('running',new Date(now).toISOString()),'pending','start-complete');
    expect(store.eventsAfter(0).filter(event=>event.type==='incident')).toHaveLength(0);
    store.update(start.id,'succeeded','AWS confirmó running.');
    monitor.close();store.close();
  });

  it('sondea proveedores aunque no haya suscripciones Push y detecta un cambio con dos observaciones frescas', async () => {
    const store = new Store(':memory:');
    let now = Date.parse('2026-10-21T00:00:00.000Z'), resource = providerResource('running', new Date(now).toISOString()), calls = 0;
    const adapter = { inventory: async () => [resource], perform: async () => ({message:'ok'}), cloudInventory: async () => { calls++; return [resource]; } };
    const costs = { get: vi.fn(async () => report(0, 0)) };
    const monitor = new InfrastructureMonitor(store, adapter, costs, () => now);
    await monitor.tick();
    expect(calls).toBe(1);
    expect(costs.get).toHaveBeenCalledTimes(1);

    const push = new PushService(store, pushConfig, { send: async () => ({ statusCode: 201 }) });
    push.register({ endpoint: 'https://fcm.googleapis.com/fcm/send/a', keys: subscriptionKeys });
    resource = providerResource('running', new Date(now).toISOString());
    await monitor.tick();
    expect(calls).toBe(2);

    now += 300000; resource = providerResource('stopped', new Date(now).toISOString()); await monitor.tick();
    now += 300000; resource = providerResource('stopped', new Date(now).toISOString()); await monitor.tick();
    const events = store.eventsAfter(0).filter(event => event.type === 'incident');
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ category: 'infrastructure', resourceId: resource.id, from: 'running', to: 'stopped' });
    expect(costs.get).toHaveBeenCalledTimes(4);
    monitor.close(); push.close(); store.close();
  });

  it('avisa una sola vez por umbral mensual y no duplica una parada pedida desde el panel', async () => {
    const store = new Store(':memory:');
    let now = Date.now(), state = providerResource('running', new Date(now).toISOString()), costsReport = report(85, 110);
    const adapter = { inventory: async () => [state], perform: async () => ({message:'ok'}), cloudInventory: async () => [state] };
    const monitor = new InfrastructureMonitor(store, adapter, { get: async () => costsReport }, () => now);
    const push = new PushService(store, pushConfig, { send: async () => ({ statusCode: 201 }) });
    push.register({ endpoint: 'https://fcm.googleapis.com/fcm/send/b', keys: subscriptionKeys });
    await monitor.tick();
    now += 300000; costsReport = report(85, 110); await monitor.tick();
    const alerts = store.eventsAfter(0).filter(event => event.type === 'incident' && event.payload.category === 'budget');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.payload).toMatchObject({ threshold: 100, percent: 110, source: 'forecast', account: 'agents' });

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    try {
      const server = store.create('Admin', 'expected-stop', 'fp', state, 'stop');
      store.update(server.id, 'running', 'Orden enviada.');
    } finally { vi.useRealTimers(); }
    now += 300000; state = providerResource('stopped', new Date(now).toISOString()); await monitor.tick();
    now += 300000; state = providerResource('stopped', new Date(now).toISOString()); await monitor.tick();
    const infrastructureAlerts = store.eventsAfter(0).filter(event => event.type === 'incident' && event.payload.category === 'infrastructure');
    expect(infrastructureAlerts).toHaveLength(0);
    monitor.close(); push.close(); store.close();
  });

  it('correlaciona una orden esperada tras dos reconciliaciones de 15 minutos y consume la expectativa', async () => {
    const store = new Store(':memory:');
    let now = Date.now(), resource = providerResource('running', new Date(now).toISOString());
    const adapter = { inventory: async () => [resource], perform: async () => ({ message: 'ok' }), cloudInventory: async () => [resource] };
    const monitor = new InfrastructureMonitor(store, adapter, { get: async () => report(0, 0) }, () => now);
    await monitor.tick();
    const operation = store.create('Admin', 'expected-stop-15m', 'fp', resource, 'stop');
    store.update(operation.id, 'succeeded', 'AWS confirmó el apagado.');

    now += 15 * 60_000; resource = providerResource('stopped', new Date(now).toISOString()); await monitor.tick();
    now += 15 * 60_000; resource = providerResource('stopped', new Date(now).toISOString()); await monitor.tick();
    expect(store.eventsAfter(0).filter(event => event.type === 'incident')).toHaveLength(0);

    now += 15 * 60_000; resource = providerResource('running', new Date(now).toISOString()); await monitor.tick();
    now += 15 * 60_000; resource = providerResource('running', new Date(now).toISOString()); await monitor.tick();
    expect(store.eventsAfter(0).filter(event => event.type === 'incident' && event.payload.category === 'infrastructure')).toHaveLength(1);
    monitor.close(); store.close();
  });

  it('descarta una lectura que termina después de cerrar el monitor', async () => {
    const store = new Store(':memory:');
    let release!: (rows: Resource[]) => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const inventory = new Promise<Resource[]>(resolve => { release = resolve; });
    const adapter = { inventory: async () => [], perform: async () => ({ message: 'ok' }), cloudInventory: async () => { entered(); return inventory; } };
    const costs = { get: vi.fn(async () => report(0, 0)) };
    const monitor = new InfrastructureMonitor(store, adapter, costs);
    const push = new PushService(store, pushConfig, { send: async () => ({ statusCode: 201 }) });
    push.register({ endpoint: 'https://fcm.googleapis.com/fcm/send/close', keys: subscriptionKeys });
    const tick = monitor.tick();
    await started;
    monitor.close();
    release([providerResource('running', new Date().toISOString())]);
    await tick;
    expect(store.db.prepare("SELECT value FROM settings WHERE key='provider-state-baselines-v1'").get()).toBeUndefined();
    expect(costs.get).not.toHaveBeenCalled();
    push.close(); store.close();
  });

  it('marca el monitor como degradado cuando no hay cobertura o los proveedores son desconocidos', async () => {
    const store = new Store(':memory:');
    const unknown = providerResource('unknown', new Date().toISOString());
    const adapter = { inventory: async () => [unknown], perform: async () => ({ message: 'ok' }), cloudInventory: async () => [unknown] };
    const monitor = new InfrastructureMonitor(store, adapter, { get: async () => report(0, 0) });
    const push = new PushService(store, pushConfig, { send: async () => ({ statusCode: 201 }) });
    push.register({ endpoint: 'https://fcm.googleapis.com/fcm/send/unknown', keys: subscriptionKeys });
    await monitor.tick();
    expect(monitor.status()).toMatchObject({ state: 'degraded', resourcesObserved: 1, unknownResources: 1 });
    monitor.close(); push.close(); store.close();
  });
});
