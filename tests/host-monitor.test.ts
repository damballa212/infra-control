import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { CatalogRepository } from '../server/catalog.js';
import { HostObservationCoordinator } from '../server/host-observation.js';
import { NativeHostMonitor } from '../server/host-monitor.js';
import { InfrastructureMonitor } from '../server/monitor.js';
import type { HostObservationConfig, Adapter } from '../server/types.js';
import { HOST_PIN, ROOT_DIRECTORY, nativeSample } from './fixtures/native-host.js';
import type { HostSnapshot } from '../server/host-observation-schema.js';

const base = Date.parse('2026-11-14T10:00:00.000Z');
function harness(path = ':memory:') {
  const store = new Store(path); let now = base, sequence = 0, value = nativeSample(now);
  const configs: HostObservationConfig[] = [{ key: 'fixture-host', displayName: 'VPS', enabled: true, snapshotDirectory: ROOT_DIRECTORY, expectedFingerprint: HOST_PIN, monitoring: { enabled: true } }];
  const catalog = new CatalogRepository(store, () => now);
  const source = new HostObservationCoordinator(() => configs, store, catalog, { now: () => now, read: async () => Buffer.from(JSON.stringify(value)) });
  const projection = (samples: ReadonlyMap<string, HostSnapshot | undefined>, includeRetiredDocker: (id: string) => boolean, completeDocker: ReadonlyMap<string, HostSnapshot>) => source.snapshot({ samples, includeRetiredDocker, completeDocker });
  let monitor = new NativeHostMonitor(store, () => configs, projection, () => now);
  const send = async (cpu = 20, memory = 20, disk = 20, mutate?: (sample: HostSnapshot) => void) => {
    if (sequence) now += 60000; value = nativeSample(now, ++sequence, cpu, memory, disk); mutate?.(value); await source.poll(); monitor.tick();
  };
  const events = () => store.eventsAfter(0,250).filter(event => event.type === 'incident' && event.payload.source === 'host-native-monitor');
  return { store, catalog, source, configs, send, events, monitor: () => monitor, restart: () => { monitor.close(); monitor = new NativeHostMonitor(store, () => configs, projection, () => now); }, advance: (ms: number) => { now += ms; }, root: () => source.snapshot().find(resource => resource.kind === 'computer')!, close: () => { monitor.close(); source.close(); store.close(); } };
}
describe('durable native monitor', () => {
  it('requires three distinct CPU observations and three clear observations', async () => {
    const h = harness();
    try {
      await h.send(95); h.monitor().tick(); h.monitor().tick(); expect(h.events()).toEqual([]);
      await h.send(95); expect(h.events()).toEqual([]);
      await h.send(95); expect(h.events().map(event => event.payload.status)).toEqual(['open']);
      await h.send(85); await h.send(85); expect(h.events()).toHaveLength(1);
      await h.send(85); expect(h.events().map(event => event.payload.status)).toEqual(['open','resolved']);
      expect(h.store.operational.incidentPage({ view: 'history', limit: 100 }, 'fixture', () => true).incidents.find(incident => incident.component === 'host-cpu')?.status).toBe('resolved');
    } finally { h.close(); }
  });
  it('uses three memory samples and two root filesystem samples', async () => {
    const h = harness();
    try {
      await h.send(20,95,95); expect(h.events()).toEqual([]);
      await h.send(20,95,95); expect(h.events().map(event => event.payload.component)).toEqual(['host-disk']);
      await h.send(20,95,95); expect(h.events().map(event => event.payload.component)).toEqual(['host-disk','host-memory']);
    } finally { h.close(); }
  });
  it('resets candidate counts in the hysteresis band', async () => {
    const h = harness();
    try {
      await h.send(95); await h.send(87); await h.send(95); await h.send(95); expect(h.events()).toEqual([]);
      await h.send(95); expect(h.events()).toHaveLength(1);
    } finally { h.close(); }
  });
  it('keeps a gap unknown and reestablishes a baseline without a recovery event', async () => {
    const h = harness();
    try {
      await h.send(95); await h.send(95); await h.send(95);
      h.advance(180000); h.monitor().tick(); expect(h.events().at(-1)?.payload.status).toBe('unknown');
      await h.send(20); await h.send(20); await h.send(20);
      expect(h.events().map(event => event.payload.status)).toEqual(['open','unknown','information']);
      expect(h.events().some(event => event.payload.transitionReason === 'host_threshold_cleared')).toBe(false);
    } finally { h.close(); }
  });
  it('persists candidate counts and does not recount a sample after monitor recreation', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'host-monitor-'));
    const h = harness(join(directory, 'infra.sqlite'));
    try {
      await h.send(95); await h.send(95); h.restart(); h.monitor().tick(); expect(h.events()).toEqual([]);
      await h.send(95); expect(h.events().map(event => event.payload.status)).toEqual(['open']);
    } finally { h.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it('resets a high candidate across boot IDs', async () => {
    const h = harness();
    try {
      await h.send(95); await h.send(95);
      await h.send(95,20,20, sample => { sample.bootId = '87654321-1234-4234-8234-123456789012'; });
      expect(h.events()).toEqual([]);
    } finally { h.close(); }
  });
  it('alerts on explicit unhealthy Docker health and leaves stopped jobs without obligations alone', async () => {
    const h = harness();
    try {
      await h.send(); expect(h.events()).toEqual([]);
      await h.send(20,20,20, sample => { sample.docker.containers[0]!.status = 'exited'; sample.docker.containers[0]!.healthStatus = 'unhealthy'; });
      expect(h.events()).toEqual([]);
      await h.send(20,20,20, sample => { sample.docker.containers[0]!.healthStatus = 'unhealthy'; });
      expect(h.events().at(-1)?.payload).toMatchObject({ component: 'docker-health', status: 'open' });
      await h.send(20,20,20, sample => { sample.docker.containers[0]!.healthStatus = 'healthy'; });
      expect(h.events().at(-1)?.payload.status).toBe('resolved');
    } finally { h.close(); }
  });
  it('retains complete Docker evidence only within the same boot', async () => {
    const h = harness();
    const newBoot = '87654321-1234-4234-8234-123456789012';
    const partial = (sample: HostSnapshot) => {
      sample.docker.complete = false;
      sample.docker.errors = ['docker_timeout'];
      sample.docker.containers = [];
    };
    const child = () => h.source.snapshot().find(resource => resource.kind === 'service');
    try {
      await h.send(20, 20, 20, sample => { sample.docker.containers[0]!.healthStatus = 'unhealthy'; });
      const previous = child();
      expect(previous?.health?.service?.state).toBe('unhealthy');
      await h.send(20, 20, 20, partial);
      expect(child()?.health?.service).toEqual(previous?.health?.service);
      expect(h.events().map(event => event.payload.status)).toEqual(['open']);
      await h.send(20, 20, 20, sample => { sample.bootId = newBoot; partial(sample); });
      expect(child()).toMatchObject({ id: previous?.id, state: 'unknown', observedAt: null, health: { presence: { state: 'unknown' }, service: { state: 'unknown', observedAt: null } } });
      expect(h.events().at(-1)?.payload).toMatchObject({ component: 'docker-health', status: 'unknown', reasonCode: 'host_boot_changed' });
      await h.send(20, 20, 20, sample => { sample.bootId = newBoot; sample.docker.containers[0]!.healthStatus = 'healthy'; });
      expect(child()?.health?.service?.state).toBe('healthy');
      expect(h.events().map(event => event.payload.status)).toEqual(['open', 'unknown', 'information']);
    } finally { h.close(); }
  });
  it('reads the accepted payload once per host and tick across many containers', async () => {
    const h = harness();
    const current = vi.spyOn(h.store.hostObservations, 'current');
    try {
      await h.send(20, 20, 20, sample => {
        const template = sample.docker.containers[0]!;
        sample.docker.containers = Array.from({ length: 40 }, (_, index) => ({ ...template, id: index.toString(16).padStart(64, '0') }));
      });
      current.mockClear(); h.monitor().tick();
      expect(h.monitor().lastErrorCode).toBeNull();
      expect(current).toHaveBeenCalledTimes(1);
    } finally { current.mockRestore(); h.close(); }
  });
  it('tracks an explicit availability obligation through a complete absence and retirement', async () => {
    const h = harness();
    try {
      await h.send();
      const child = h.source.snapshot().find(resource => resource.kind === 'service')!;
      h.store.operational.setExpectation(child.id, 'always-on', 0);
      const absence = (sample: HostSnapshot) => { sample.docker.containers = []; };
      await h.send(20, 20, 20, sample => { absence(sample); sample.docker.complete = false; sample.docker.errors = ['docker_changed']; });
      expect(h.events()).toEqual([]);
      await h.send(20, 20, 20, absence);
      expect(h.events()[0]?.payload).toMatchObject({ component: 'host-availability', status: 'open', observedAt: new Date(base + 120_000).toISOString() });
      for (let scan = 0; scan < 15; scan++) await h.send(20, 20, 20, absence);
      expect(h.catalog.listResources({ includeRetired: true }).find(row => row.catalogId === child.catalog?.catalogId)?.lifecycle).toBe('retired');
      expect(h.source.snapshot().some(resource => resource.id === child.id)).toBe(false);
      expect(h.events().map(event => event.payload.status)).toEqual(['open']);
      const keys = (h.store.db.prepare('SELECT lane_key AS key FROM host_monitor_lanes').all() as Array<{key:string}>).map(row => JSON.parse(row.key));
      expect(keys).toContainEqual([child.id, 'host-availability']);
      expect(keys).not.toContainEqual([child.id, 'docker-health']);
      await h.send();
      expect(h.events().map(event => event.payload.status)).toEqual(['open', 'resolved']);
      expect(h.events().at(-1)?.payload.resourceId).toBe(child.id);
    } finally { h.close(); }
  });
  it.each([true, false])('reopens on a new obligation using the same observation (tick while disabled=%s)', async tickWhileDisabled => {
    const h = harness();
    const stopped = (sample: HostSnapshot) => { sample.docker.containers[0]!.status = 'exited'; };
    try {
      await h.send(20, 20, 20, stopped);
      const child = h.source.snapshot().find(resource => resource.kind === 'service')!;
      h.store.operational.setExpectation(child.id, 'always-on', 0);
      h.monitor().tick();
      h.store.operational.setExpectation(child.id, 'observe', 1);
      if (tickWhileDisabled) h.monitor().tick();
      h.store.operational.setExpectation(child.id, 'always-on', 2);
      h.restart(); h.monitor().tick(); h.monitor().tick();
      await h.send(20, 20, 20, stopped);
      const transitions = h.events().filter(event => event.payload.component === 'host-availability');
      expect(transitions.map(event => event.payload.status)).toEqual(['open', 'information', 'open']);
      expect(transitions.map(event => event.payload.observedAt)).toEqual(Array(3).fill(new Date(base).toISOString()));
      expect(h.store.operational.incidentPage({ view: 'current', limit: 100 }, 'fixture', () => true).incidents).toEqual([
        expect.objectContaining({ resourceId: child.id, component: 'host-availability', status: 'open' })
      ]);
    } finally { h.close(); }
  });
  it('does not interpret native online as an availability failure or install child policies', async () => {
    const h = harness();
    try {
      await h.send(); const root = h.root(); h.store.operational.setExpectation(root.id, 'always-on', 0);
      h.store.operational.observeResources(h.source.snapshot(), base); h.monitor().tick();
      expect(h.events()).toEqual([]);
      expect(h.store.db.prepare('SELECT COUNT(*) AS count FROM availability_expectations').get()?.count).toBe(1);
    } finally { h.close(); }
  });
  it('requires explicit threshold enablement and records removal without claiming recovery', async () => {
    const h = harness();
    try {
      h.configs[0]!.monitoring = { enabled: false };
      await h.send(95); await h.send(95); await h.send(95); expect(h.events()).toEqual([]);
      const count = () => h.store.db.prepare('SELECT COUNT(*) AS count FROM host_monitor_lanes').get()?.count;
      expect(count()).toBe(1);
      h.configs[0]!.monitoring = { enabled: true };
      await h.send(95); await h.send(95); await h.send(95);
      h.configs[0]!.monitoring = { enabled: false };
      h.store.db.exec("CREATE TRIGGER fail_lane_delete BEFORE DELETE ON host_monitor_lanes BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END");
      h.monitor().tick();
      expect(h.monitor().lastErrorCode).toBe('host_monitor_failed');
      expect(count()).toBe(4);
      expect(h.events().map(event => event.payload.status)).toEqual(['open']);
      h.store.db.exec('DROP TRIGGER fail_lane_delete');
      h.monitor().tick(); h.monitor().tick();
      expect(count()).toBe(1);
      expect(h.events().map(event => event.payload.status)).toEqual(['open','information']);
    } finally { h.close(); }
  });
  it('excludes native containers from the cloud monitor provider baseline', async () => {
    const h = harness(); let costCalls = 0;
    try {
      await h.send();
      const adapter: Adapter = { inventory: async () => h.source.snapshot(), perform: async () => ({ message: 'unused' }) };
      const cloud = new InfrastructureMonitor(h.store, adapter, { get: async () => { costCalls++; return { accounts: [], fetchedAt: '', nextRefreshAt: '', periodStart: '2026-11-01', periodEnd: '2026-12-01', policy: 'fixture' }; } }, () => base);
      await cloud.tick(); expect(cloud.status().resourcesObserved).toBe(0); expect(costCalls).toBe(1); cloud.close();
      h.monitor().tick(); h.monitor().tick(); expect(costCalls).toBe(1);
    } finally { h.close(); }
  });
});
