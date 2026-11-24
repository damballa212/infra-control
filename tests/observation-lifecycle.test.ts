import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../server/store.js';
import { CatalogRepository } from '../server/catalog.js';
import { MacReports } from '../server/mac-reports.js';
import { DesktopReports } from '../server/desktop-reports.js';
import { desktopResource } from '../server/desktop.js';
import { HermesReports } from '../server/hermes-reports.js';
import { InfrastructureMonitor } from '../server/monitor.js';
import { AwsCloudEventIngest } from '../server/cloud-events.js';
import { InfrastructureAdapter, type Transport } from '../server/infrastructure.js';
import { RouterReports } from '../server/router-reports.js';
import type { Config, Resource } from '../server/types.js';
import type { CostReport } from '../server/costs.js';

const base = Date.parse('2026-11-12T12:00:00Z');
const stores: Store[] = [], close: Array<() => void> = [];
const iso = (offset = 0) => new Date(base + offset).toISOString();
const host = (state = 'running', observedAt = new Date().toISOString()): Resource => ({ id: 'aws:one:i-host', name: 'Host', kind: 'ec2', state, observedAt, actions: ['start', 'stop', 'refresh'], account: 'one', location: 'us-east-1', detail: 'fixture' });
const costs: CostReport = { accounts: [], fetchedAt: iso(), nextRefreshAt: iso(86400000), periodStart: '2026-11-01', periodEnd: '2026-11-12', policy: 'test' };
function store() { const value = new Store(':memory:'); stores.push(value); return value; }
function catalogFixture() {
  const db = store(), catalog = new CatalogRepository(db);
  const connection = catalog.registerConnection({ provider: 'aws', providerAccountId: '123456789012', name: 'one', credentialRef: 'fixture' });
  const snapshot = { providerId: 'i-host', resourceType: 'ec2-instance', region: 'us-east-1', name: 'Host', state: 'running', detail: 'fixture', observedAt: iso(), aliases: ['aws:one:i-host'] };
  catalog.reconcileScope(connection.id, 'aws:ec2:us-east-1', [snapshot], { complete: true, observedAt: iso() });
  return { db, catalog, connection, snapshot };
}
const hermesSample = (sequence: number, serviceState: 'active' | 'inactive' | 'failed' | 'unknown') => ({ version: 1 as const, bootId: 'hermes-boot-one', streamId: 'hermes-stream-one', sequence, serviceState, restartCount: 0 });
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(base); });
afterEach(() => { close.splice(0).reverse().forEach(fn => fn()); stores.splice(0).forEach(db => db.close()); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('observación y expectativa operacional', () => {
  it('conserva el último reposo Mac con evidencia vencida, incluso tras recrear el reporter', async () => {
    const db = store(), reports = new MacReports(db); close.push(() => reports.close());
    reports.accept({ bootId: 'mac-boot-one', sequence: 1, event: 'online' });
    reports.accept({ bootId: 'mac-boot-one', sequence: 2, event: 'sleep' });
    const observedAt = reports.status()!.observedAt;
    await vi.advanceTimersByTimeAsync(86400000);
    expect(reports.resource()).toMatchObject({ state: 'asleep', observedAt, monitoring: { availability: 'on-demand', expectedState: 'asleep' }, health: { presence: { state: 'stale' } } });
    expect(db.eventsAfter(0).some(event => event.payload.transitionReason === 'telemetry_timeout')).toBe(false);
    reports.close();
    const restarted = new MacReports(db); close.push(() => restarted.close());
    expect(restarted.resource()).toMatchObject({ state: 'asleep', observedAt, health: { presence: { state: 'stale' } } });
    restarted.accept({ bootId: 'mac-boot-one', sequence: 3, event: 'wake' });
    expect(restarted.resource()).toMatchObject({ state: 'running', health: { presence: { state: 'fresh' } } });
  });

  it('publica muestras nuevas sin eventos durables por heartbeat y mantiene el rechazo de boots no establecidos', async () => {
    const db = store(), reports = new MacReports(db); close.push(() => reports.close());
    const listener = vi.fn(); reports.subscribeSamples(listener);
    expect(reports.accept({ bootId: 'mac-boot-new', sequence: 1, event: 'heartbeat' })).toBe(false);
    reports.accept({ bootId: 'mac-boot-one', sequence: 1, event: 'online' });
    await vi.advanceTimersByTimeAsync(15000);
    reports.accept({ bootId: 'mac-boot-one', sequence: 2, event: 'heartbeat' });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(db.eventsAfter(0)).toHaveLength(1);
    expect(reports.status()!.observedAt).toBe(iso(15000));
    reports.accept({ bootId: 'mac-boot-two', sequence: 1, event: 'online' });
    expect(reports.accept({ bootId: 'mac-boot-one', sequence: 999, event: 'online' })).toBe(false);
  });

  it('declara la parada personal esperada sin rejuvenecer su evidencia', async () => {
    const db = store(), reports = new DesktopReports(db); close.push(() => reports.close());
    reports.accept('windows', { bootId: 'windows-boot-one', sequence: 1, event: 'online' });
    reports.accept('windows', { bootId: 'windows-boot-one', sequence: 2, event: 'poweroff' });
    await vi.advanceTimersByTimeAsync(60000);
    expect(desktopResource(reports.status())).toMatchObject({ state: 'stopped', observedAt: iso(), monitoring: { availability: 'on-demand', expectedState: 'stopped' }, health: { presence: { state: 'stale' } } });
  });

  it('rechaza un snapshot anterior y no declara ausente un recurso observado después de empezar el scan', () => {
    const { catalog, connection, snapshot } = catalogFixture();
    catalog.applyAwsStateEvent({ accountId: '123456789012', region: 'us-east-1', instanceId: 'i-host', state: 'stopped', eventTime: iso(2000), eventId: 'new-event' });
    catalog.reconcileScope(connection.id, 'aws:ec2:us-east-1', [{ ...snapshot, observedAt: iso(1000) }], { complete: true, observedAt: iso(1000) });
    catalog.reconcileScope(connection.id, 'aws:ec2:us-east-1', [], { complete: true, observedAt: iso(1500) });
    expect(catalog.listResources()[0]).toMatchObject({ state: 'stopped', observedAt: iso(2000), lifecycle: 'active', missingScans: 0 });
    expect(catalog.listScopes()[0]!.generation).toBe(3);
  });

  it('declara veinte minutos de vigencia AWS sin renovar observedAt', () => {
    const { catalog } = catalogFixture();
    vi.setSystemTime(base + 15 * 60000);
    const resource = catalog.asResource(catalog.listResources()[0]!);
    expect(resource).toMatchObject({ observedAt: iso(), health: { presence: { state: 'fresh', freshUntil: iso(20 * 60000) } } });
    vi.setSystemTime(base + 20 * 60000 + 1);
    expect(catalog.asResource(catalog.listResources()[0]!).health?.presence?.state).toBe('stale');
  });

  it('consume el efecto exacto confirmado y no suprime una parada externa posterior', () => {
    const db = store();
    const monitor = new InfrastructureMonitor(db, { inventory: async () => [], perform: async () => ({ message: 'unused' }) }, { get: async () => costs }); close.push(() => monitor.close());
    monitor.observeAwsEvent(host(), null, 'baseline');
    const operation = db.create('Admin', 'stop-one', 'fp', host(), 'stop');
    db.update(operation.id, 'succeeded', 'Estado detenido verificado.');
    expect(db.db.prepare('SELECT consumed_at AS consumedAt FROM expected_transitions WHERE operation_id=?').get(operation.id)).toMatchObject({ consumedAt: iso() });
    vi.setSystemTime(base + 1000); monitor.observeAwsEvent(host('running'), 'stopped', 'external-start');
    vi.setSystemTime(base + 2000); monitor.observeAwsEvent(host('stopped'), 'running', 'external-stop');
    expect(db.eventsAfter(0).filter(event => event.type === 'incident').map(event => event.payload.to)).toEqual(['running', 'stopped']);
  });

  it('invalida una expectativa incierta con evidencia incompatible posterior sin cambiar el resultado', () => {
    const db = store();
    const monitor = new InfrastructureMonitor(db, { inventory: async () => [], perform: async () => ({ message: 'unused' }) }, { get: async () => costs }); close.push(() => monitor.close());
    monitor.observeAwsEvent(host(), null, 'baseline');
    const operation = db.create('Admin', 'uncertain-stop', 'fp', host(), 'stop'); db.update(operation.id, 'uncertain', 'No confirmado.');
    vi.setSystemTime(base + 1000); monitor.observeAwsEvent(host(), 'running', 'still-running');
    vi.setSystemTime(base + 2000); monitor.observeAwsEvent(host('stopped'), 'running', 'unrelated-stop');
    expect(db.get(operation.id)?.state).toBe('uncertain');
    expect(db.eventsAfter(0).filter(event => event.type === 'incident')).toHaveLength(1);
  });

  it('no confirma transiciones con dos observaciones regresivas o vencidas y degrada cobertura', async () => {
    const db = store(); let resource = host(); let coverage = true;
    const monitor = new InfrastructureMonitor(db, { inventory: async () => [resource], perform: async () => ({ message: 'unused' }) }, { get: async () => costs }, Date.now, async () => [resource], () => coverage); close.push(() => monitor.close());
    await monitor.tick();
    resource = host('stopped', iso(-2000)); await monitor.tick();
    resource = host('stopped', iso(-1000)); await monitor.tick();
    expect(db.eventsAfter(0).filter(event => event.type === 'incident')).toHaveLength(0);
    vi.setSystemTime(base + 30 * 60000);
    resource = host('stopped', iso(1000)); await monitor.tick();
    resource = host('stopped', iso(2000)); await monitor.tick();
    expect(monitor.status().state).toBe('degraded');
    expect(db.eventsAfter(0).filter(event => event.type === 'incident')).toHaveLength(0);
    resource = host(); coverage = false; await monitor.tick(); expect(monitor.status().state).toBe('degraded');
  });

  it('reevalúa Hermes al vencer la supresión sin heartbeat y conserva recuperación atravesando unknown y reinicio', async () => {
    const db = store(); let reports = new HermesReports(db, [host().id]); close.push(() => reports.close());
    reports.accept(hermesSample(1, 'active'));
    db.create('Admin', 'start-hermes', 'fp', host('stopped'), 'start');
    await vi.advanceTimersByTimeAsync(1000); reports.accept(hermesSample(2, 'inactive'));
    await vi.advanceTimersByTimeAsync(10 * 60000);
    expect(db.eventsAfter(0).filter(event => event.type === 'incident').map(event => event.payload.to)).toEqual(['stale']);
    reports.accept(hermesSample(3, 'unknown'));
    reports.close(); reports = new HermesReports(db, [host().id]);
    await vi.advanceTimersByTimeAsync(1000); reports.accept(hermesSample(4, 'active'));
    expect(db.eventsAfter(0).filter(event => event.type === 'incident').map(event => event.payload.to)).toEqual(['stale', 'healthy']);
  });

  it('mantiene normal una parada confirmada más allá de diez minutos y consume la tolerancia al volver sano', async () => {
    const db = store(), reports = new HermesReports(db, [host().id]); close.push(() => reports.close());
    reports.accept(hermesSample(1, 'active'));
    const operation = db.create('Admin', 'intended-stop', 'fp', host(), 'stop'); db.update(operation.id, 'succeeded', 'Parada verificada.');
    await vi.advanceTimersByTimeAsync(3600000);
    expect(reports.status()).toMatchObject({ state: 'stale', expectedTransition: true, reasonCode: 'intended_host_stop' });
    expect(db.eventsAfter(0).filter(event => event.type === 'incident')).toHaveLength(0);
    reports.accept(hermesSample(2, 'active'));
    await vi.advanceTimersByTimeAsync(1000); reports.accept(hermesSample(3, 'failed'));
    expect(db.eventsAfter(0).filter(event => event.type === 'incident').map(event => event.payload.to)).toEqual(['unhealthy']);
  });

  it('drena más de un lote del inbox cediendo entre lotes', async () => {
    const { db, catalog } = catalogFixture();
    for (let index = 0; index < 230; index++) db.enqueueCloudEvent({ eventKey: `event-${index}`, accountId: '123456789012', region: 'us-east-1', instanceId: `i-backlog-${index}`, state: 'running', eventTime: iso(index + 1), receivedAt: iso(index + 1) });
    const ingest = new AwsCloudEventIngest(db, catalog, [{ name: 'one', accountId: '123456789012', accessKeyId: 'fixture', secretAccessKey: 'fixture' }], undefined); close.push(() => ingest.close());
    await ingest.drain(); expect(db.cloudEventHealth().pending).toBe(130);
    await vi.advanceTimersByTimeAsync(25); expect(db.cloudEventHealth().pending).toBe(30);
    await vi.advanceTimersByTimeAsync(25); expect(db.cloudEventHealth()).toMatchObject({ pending: 0, processed: 230 });
  });

  it('recompone CWMP y túnel desde adquisición compartida sin otra petición de proveedor', async () => {
    const db = store(), reports = new RouterReports(db); close.push(() => reports.close());
    const fetcher = vi.fn(async () => Response.json([{ _lastInform: iso(), InternetGatewayDevice: { DeviceInfo: { ModelName: { _value: 'SR1021D' }, SoftwareVersion: { _value: 'fixture' } }, ManagementServer: { PeriodicInformInterval: { _value: 60 } } } }]));
    const config: Config = { origin: 'https://control.example.test', passwordHash: 'unused', agentTokens: [], aws: [], coolify: { url: '', token: '', resources: [] }, acs: { url: 'https://acs.example.test', deviceId: 'fixture' } };
    const io: Transport = { fetch: fetcher as typeof fetch, ec2: () => { throw new Error('No AWS'); }, wait: async () => undefined, now: Date.now };
    const adapter = new InfrastructureAdapter(config, io, undefined, () => reports.status(), undefined, undefined, () => reports.tunnelProbe());
    reports.accept({ version: 1, bootId: 'router-boot-one', streamId: 'router-stream-one', sequence: 1, uptimeSeconds: 100, cpuPercent: 1, memTotalBytes: 1000, memAvailableBytes: 500 });
    await adapter.localInventory();
    await vi.advanceTimersByTimeAsync(45000);
    reports.recordTunnelProbe(false);
    const resource = adapter.localSnapshot().find(item => item.id === 'router:fiberhome')!;
    expect(resource.health).toMatchObject({ presence: { state: 'fresh', source: 'cwmp-inform' }, cwmp: { state: 'available' }, tunnel: { state: 'unavailable' }, telemetry: { state: 'stale' } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
