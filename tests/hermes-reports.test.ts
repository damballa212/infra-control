import { describe, expect, it } from 'vitest';
import { HermesReports } from '../server/hermes-reports.js';
import { InfrastructureAdapter, type Transport } from '../server/infrastructure.js';
import { Store } from '../server/store.js';
import type { Config } from '../server/types.js';

const sample = (sequence: number, serviceState: 'active'|'inactive'|'failed'|'unknown', streamId='hermes-stream-1') => ({version:1 as const,bootId:'hermes-boot-123',streamId,sequence,serviceState,restartCount:0});

describe('telemetría del proceso Hermes', () => {
  it('separa presencia del agente de estado de la unidad y registra fallas y recuperación', () => {
    const store=new Store(':memory:');let now=Date.parse('2026-10-21T00:00:00Z');
    const reports=new HermesReports(store,[],()=>now);
    expect(reports.accept(sample(1,'active'))).toBe(true);
    expect(reports.status()).toMatchObject({state:'healthy',serviceState:'active'});
    now+=15000;reports.accept(sample(2,'failed'));
    expect(reports.status()).toMatchObject({state:'unhealthy',serviceState:'failed'});
    expect(store.eventsAfter(0).filter(event=>event.type==='incident')).toHaveLength(1);
    now+=15000;reports.accept(sample(3,'active'));
    expect(reports.status()).toMatchObject({state:'healthy',serviceState:'active'});
    expect(store.eventsAfter(0).filter(event=>event.type==='incident')).toHaveLength(2);
    reports.close();store.close();
  });

  it('rechaza secuencias viejas, no rejuvenece duplicados y considera vencido un heartbeat de más de 45 s', () => {
    const store=new Store(':memory:');let now=Date.parse('2026-10-21T00:00:00Z');
    const reports=new HermesReports(store,[],()=>now);
    expect(reports.accept(sample(1,'active'))).toBe(true);
    expect(reports.accept(sample(1,'active'))).toBe(true);
    expect(reports.accept(sample(0,'failed'))).toBe(false);
    now+=45001;
    expect(reports.status()).toMatchObject({state:'stale',lastServiceState:'active'});
    reports.close();store.close();
  });

  it('no genera una alerta de servicio caído al detener intencionalmente la EC2 desde Infra Control', () => {
    const store=new Store(':memory:');let now=Date.parse('2026-10-21T00:00:00Z');
    const resource={id:'aws:agents:i-hermes',name:'orchestrator',kind:'ec2' as const,state:'running',location:'us-east-1',detail:'t4g.large',account:'agents',actions:['stop' as const],observedAt:new Date(now).toISOString()};
    const operation=store.create('Admin','expected-stop','fingerprint',resource,'stop');
    store.update(operation.id,'running','Orden enviada.');
    const reports=new HermesReports(store,[resource.id],()=>now);
    reports.accept(sample(1,'active'));
    now+=10000;reports.accept(sample(2,'inactive'));
    expect(store.eventsAfter(0).filter(event=>event.type==='incident')).toHaveLength(0);
    reports.close();store.close();
  });

  it('vuelve a evaluar una caída de Hermes cuando vence la ventana de una operación esperada', () => {
    const store = new Store(':memory:');
    let now = Date.now();
    const resource = { id: 'aws:agents:i-hermes', name: 'orchestrator', kind: 'ec2' as const, state: 'running', location: 'us-east-1', detail: 't4g.large', account: 'agents', actions: ['stop' as const], observedAt: new Date(now).toISOString() };
    const operation = store.create('Admin', 'expected-start', 'fingerprint', resource, 'start');
    store.update(operation.id, 'running', 'Orden enviada.');
    const reports = new HermesReports(store, [resource.id], () => now);
    reports.accept(sample(1, 'active'));
    now += 10000;
    reports.accept(sample(2, 'inactive'));
    expect(store.eventsAfter(0).filter(event => event.type === 'incident')).toHaveLength(0);

    now += 10 * 60_000;
    reports.accept(sample(3, 'inactive'));
    expect(store.eventsAfter(0).filter(event => event.type === 'incident')).toMatchObject([
      { payload: { to: 'unhealthy', serviceState: 'inactive', reasonCode: 'systemd_unit_inactive' } }
    ]);
    reports.close(); store.close();
  });

  it('revierte estado Hermes si falla el append durable del evento', () => {
    const store = new Store(':memory:');
    let now = Date.now();
    const reports = new HermesReports(store, [], () => now);
    reports.accept(sample(1, 'active'));
    store.db.exec("CREATE TRIGGER fail_event BEFORE INSERT ON event_log BEGIN SELECT RAISE(ABORT, 'fixture'); END");
    now += 15000;
    expect(() => reports.accept(sample(2, 'failed'))).toThrow();
    expect(reports.status()).toMatchObject({ state: 'healthy', serviceState: 'active', sequence: 1 });
    expect(store.eventsAfter(0).filter(event => event.type === 'incident')).toHaveLength(0);
    store.db.exec('DROP TRIGGER fail_event');
    expect(reports.accept(sample(2, 'failed'))).toBe(true);
    expect(store.eventsAfter(0).filter(event => event.type === 'incident')).toHaveLength(1);
    reports.close(); store.close();
  });

  it('adjunta salud systemd al recurso EC2 configurado sin alterar la observación EC2', async () => {
    const config: Config = {
      origin: 'https://test.example', passwordHash: 'unused', agentTokens: [], coolify: { url: '', token: '', resources: [] }, acs: { url: '', deviceId: '' },
      aws: [{ name: 'agents', accountId: '123456789012', accessKeyId: 'fixture', secretAccessKey: 'fixture', instances: [{ id: 'i-hermes', region: 'us-east-1', name: 'orchestrator', type: 't4g.large' }] }],
      hermes: { resourceId: 'aws:agents:i-hermes', reportTokenHash: 'a'.repeat(64) }
    };
    const transport = {
      ec2: () => ({ send: async () => ({ Reservations: [{ Instances: [{ InstanceId: 'i-hermes', State: { Name: 'running' } }] }] }) }),
      fetch, wait: async () => undefined, now: Date.now
    } as unknown as Transport;
    const adapter = new InfrastructureAdapter(config, transport, undefined, undefined, undefined, () => ({
      state: 'healthy', serviceState: 'active', lastServiceState: 'active', resourceId: 'aws:agents:i-hermes',
      bootId: 'boot-1', streamId: 'stream-1', sequence: 1, restartCount: 0, observedAt: new Date().toISOString(),
      freshUntil: new Date(Date.now() + 45000).toISOString(), ageSeconds: 0, expectedTransition: false, reasonCode: 'systemd_unit_active'
    }));
    const rows = await adapter.cloudInventory();
    expect(rows[0]).toMatchObject({ state: 'running', health: { service: { state: 'healthy', source: 'hermes-systemd-reporter', reasonCode: 'systemd_unit_active' } } });
  });
});
