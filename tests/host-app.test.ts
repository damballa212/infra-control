import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, get, request, type Server } from 'node:http';
import { createApp } from '../server/app.js';
import { tokenHash } from '../server/auth.js';
import { Costs } from '../server/costs.js';
import type { Store } from '../server/store.js';
import type { CatalogRepository } from '../server/catalog.js';
import type { HostObservationCoordinator } from '../server/host-observation.js';
import type { NativeHostMonitor } from '../server/host-monitor.js';
import type { Adapter, Config, Resource } from '../server/types.js';
import { CHILD_ID, HOST_PIN, ROOT_DIRECTORY, nativeSample, trustedFixture } from './fixtures/native-host.js';

const fixtures: Array<{ app: ReturnType<typeof createApp>; server: Server }> = [];
async function fixture(enabled = true) {
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const source = trustedFixture(nativeSample(now));
  const config: Config = { origin: 'https://control.example.test', passwordHash: 'fixture', aws: [], coolify: { url: '', token: '', resources: [] }, acs: { url: '', deviceId: '' },
    hosts: [{ key: 'fixture-host', displayName: 'VPS', enabled, snapshotDirectory: ROOT_DIRECTORY, expectedFingerprint: HOST_PIN, monitoring: { enabled: true } }],
    agentTokens: [
      { name: 'host-reader', hash: tokenHash('host-token'), scopes: ['read','operate'], mcpTools: ['list_resources','get_resource','list_projects','get_incidents','get_pending_incidents','acknowledge_incident'], readPolicy: { resourceIds: [], costs: false } },
      { name: 'broad-reader', hash: tokenHash('broad-token'), scopes: ['read'] }
    ]
  };
  const inventory = vi.fn(async (): Promise<Resource[]> => []), perform = vi.fn(async () => ({ message: 'unexpected operation' }));
  const adapter: Adapter = { inventory, localInventory: inventory, localSnapshot: () => [], perform };
  const costs = vi.spyOn(Costs.prototype, 'get');
  const app = createApp(config, ':memory:', adapter, undefined, undefined, undefined, { files: source.io, now: () => now });
  const server = createServer(app); fixtures.push({ app, server });
  const observation = app.locals.hostObservation as HostObservationCoordinator, monitor = app.locals.nativeHostMonitor as NativeHostMonitor;
  await observation.poll();
  const store = app.locals.store as Store, catalog = app.locals.catalog as CatalogRepository;
  const binding = store.hostObservations.binding('fixture-host')!;
  const hostId = `host:${binding.accountId}:machine`, childId = `host:${binding.accountId}:docker:${CHILD_ID}`;
  config.agentTokens[0]!.readPolicy!.resourceIds = [hostId];
  store.addSession(tokenHash('owner-fixture'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test address');
  const headers = (token = 'host-token') => ({ Host: 'control.example.test', 'X-Forwarded-Proto': 'https', ...(token === 'owner' ? { Cookie: '__Host-infra=owner-fixture' } : { Authorization: `Bearer ${token}` }) });
  const json = (path: string, token = 'host-token', method = 'GET', value?: unknown) => new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const payload = value === undefined ? undefined : JSON.stringify(value);
    const req = request({ hostname: '127.0.0.1', port: address.port, path, method, headers: { ...headers(token), ...(payload ? { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Content-Length': Buffer.byteLength(payload), Origin: config.origin } : {}) } }, response => {
      let wire = ''; response.setEncoding('utf8'); response.on('data', chunk => { wire += chunk; }); response.on('error', reject);
      response.on('end', () => {
        try {
          const body = String(response.headers['content-type']).includes('text/event-stream') ? JSON.parse(wire.split('\n').filter(line => line.startsWith('data: ')).at(-1)!.slice(6)) : JSON.parse(wire);
          resolve({ status: response.statusCode ?? 0, body });
        } catch (error) { reject(error); }
      });
    });
    req.on('error', reject); req.setTimeout(3000, () => req.destroy(new Error('HTTP timeout'))); req.end(payload);
  });
  const events = (cursor?: number | string, token = 'host-token', live?: { run: () => Promise<void>; until: string }) => new Promise<string>((resolve, reject) => {
    let done = false, started = false, wire = '';
    const req = get({ hostname: '127.0.0.1', port: address.port, path: '/api/events' + (cursor === undefined ? '' : `?cursor=${cursor}`), headers: headers(token) }, response => {
      response.setEncoding('utf8'); response.on('data', chunk => {
        wire += chunk; const start = wire.indexOf('event: attention\n');
        if (done || start < 0 || !wire.slice(start).includes('\n\n')) return;
        if (live && !started) {
          started = true;
          void live.run().catch(error => { done = true; req.destroy(); reject(error); });
        }
        if (!live || wire.split('\n\n').slice(0, -1).some(frame => frame.includes(live.until))) {
          done = true; resolve(wire); response.destroy(); req.destroy();
        }
      }); response.on('error', error => { if (!done) reject(error); });
    }); req.on('error', error => { if (!done) reject(error); }); req.setTimeout(3000, () => req.destroy(new Error('SSE timeout')));
  });
  const mcp = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await json('/api/mcp', 'host-token', 'POST', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    expect(response.status).toBe(200);
    const result = response.body.result as { structuredContent?: Record<string, unknown>; content: Array<{ text: string }>; isError?: boolean };
    return { ...result, value: result.structuredContent ?? JSON.parse(result.content[0]!.text) as Record<string, unknown> };
  };
  return { app, store, catalog, observation, monitor, config, source, hostId, childId, binding, costs, inventory, perform, json, events, mcp, time: () => now, advance: (milliseconds: number) => { now += milliseconds; }, next: async (sequence: number, cpu = 20) => { now += 60000; source.set(nativeSample(now, sequence, cpu)); await observation.poll(); } };
}
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) { fixture.app.locals.close(); fixture.server.closeAllConnections(); await new Promise<void>((resolve, reject) => fixture.server.close(error => error ? reject(error) : resolve())); }
  vi.restoreAllMocks();
});

describe('native host through the real createApp entry', () => {
  it('reads through the trusted reader once and shares fresh native DTOs with HTTP and MCP', async () => {
    const f = await fixture(), reads = f.source.reads();
    const http = await f.json('/api/resources');
    expect((http.body.resources as Resource[]).map(resource => resource.id)).toEqual([f.hostId]);
    expect((http.body.resources as Resource[])[0]?.hostMetrics?.cpu?.percent).toBe(20);
    const mcp = await f.mcp('list_resources');
    expect(mcp.value.totalMatched).toBe(1); expect(JSON.stringify(mcp.value)).not.toContain('private-worker');
    expect(f.source.reads()).toBe(reads); expect(f.costs).not.toHaveBeenCalled();
    expect(f.perform).not.toHaveBeenCalled();
  });
  it.each([
    ['list_resources', 'removed'], ['get_resource', 'rotated'], ['list_resources', 'scope'],
    ['get_resource', 'tool'], ['list_resources', 'policy']
  ] as const)('rechecks %s after inventory when its authority is %s', async (tool, change) => {
    const f = await fixture();
    const agent = f.config.agentTokens[0]!;
    let entered!: () => void;
    let release!: (resources: Resource[]) => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<Resource[]>(resolve => { release = resolve; });
    f.inventory.mockImplementationOnce(() => { entered(); return blocked; });
    const response = f.mcp(tool, tool === 'get_resource' ? { resourceId: f.hostId } : {});
    await Promise.race([started, response.then(() => { throw new Error('Inventory did not block'); })]);
    if (change === 'removed') f.config.agentTokens.shift();
    if (change === 'rotated') {
      const { readPolicy: _readPolicy, ...replacement } = agent;
      f.config.agentTokens[0] = { ...replacement, hash: tokenHash('replacement-fixture') };
    }
    if (change === 'scope') agent.scopes.splice(0, agent.scopes.length);
    if (change === 'tool') agent.mcpTools!.splice(agent.mcpTools!.indexOf(tool), 1);
    if (change === 'policy') agent.readPolicy!.resourceIds = [f.childId];
    release([]);
    const result = await response;
    expect(result.isError).toBe(true);
    expect(result.value).toEqual({ ok: false, error: { reason: 'authorization_changed', retryable: false } });
    expect(f.perform).not.toHaveBeenCalled();
  });
  it('keeps native metrics authoritative over cache and legacy adapter values', async () => {
    const f = await fixture();
    f.store.recordHostTelemetry(f.hostId, { cpu: { percent: 99, observedAt: new Date(f.time() + 1000).toISOString() } });
    const host = (await f.json('/api/resources')).body.resources as Resource[];
    expect(host[0]?.hostMetrics?.cpu).toEqual({ percent: 20, observedAt: new Date(f.time()).toISOString() });
    expect(host[0]?.health?.telemetry?.source).toBe('host-native');
    const mcp = await f.mcp('get_resource', { resourceId: f.hostId });
    expect((mcp.value.resource as Resource).hostMetrics?.cpu?.percent).toBe(20);
  });
  it('filters root-only scopes, catalog counts and connections without Docker totals', async () => {
    const f = await fixture();
    const scopes = (await f.json('/api/catalog/scopes')).body.scopes as Array<{ scopeKey: string; resourceCount: number }>;
    expect(scopes.map(scope => scope.scopeKey).sort()).toEqual(['host:metrics','host:presence']);
    expect(scopes.find(scope => scope.scopeKey === 'host:metrics')?.resourceCount).toBe(0);
    const health = await f.json('/api/system/health');
    expect(health.body.catalog).toMatchObject({ resources: 1, observed: 1, scopes: 2 });
    expect(JSON.stringify(health.body)).not.toContain('host:docker');
    const mcp = await f.mcp('list_resources');
    expect(JSON.stringify(mcp.value.coverage)).not.toContain('host:docker');
    const connections = await f.json('/api/catalog/connections');
    expect(JSON.stringify(connections.body)).not.toContain(HOST_PIN);
    expect(JSON.stringify(connections.body)).not.toContain(ROOT_DIRECTORY);
    expect(JSON.stringify(connections.body)).not.toContain('fixture-host');
  });
  it('filters initial SSE and replay resource and coverage payloads', async () => {
    const f = await fixture(), cursor = (await f.json('/api/resources')).body.cursor as string;
    const records = f.catalog.listResources(), child = records.find(row => row.resourceType === 'docker-container')!, root = records.find(row => row.resourceType === 'linux-host')!;
    f.store.appendEvent('resource', `catalog:${root.catalogId}`, { catalogId: root.catalogId, containerCount: 777, privateChildren: 'private-worker' });
    f.store.appendEvent('resource', `catalog:${child.catalogId}`, { catalogId: child.catalogId, privateChildren: 'private-worker' });
    f.store.appendEvent('coverage', 'coverage:fixture:docker', { connectionId: child.connectionId, scopeKey: 'host:docker', resourceCount: 777, privateChildren: 'private-worker' });
    for (const wire of [await f.events(), await f.events(cursor)]) {
      expect(wire).toContain(f.hostId); expect(wire).not.toContain(f.childId);
      expect(wire).not.toContain('private-worker'); expect(wire).not.toContain('containerCount'); expect(wire).not.toContain('777');
    }
  });
  it('projects one container in REST and MCP and withholds Docker scan coverage in live SSE and replay', async () => {
    const f = await fixture();
    const child = f.catalog.listResources().find(record => record.resourceType === 'docker-container')!;
    f.config.agentTokens[0]!.readPolicy!.resourceIds = [f.childId];
    const initial = nativeSample(f.time());
    f.advance(60_000);
    const healthy = nativeSample(f.time(), initial.sequence + 1);
    healthy.docker.containers[0]!.healthStatus = 'healthy';
    f.source.set(healthy); await f.observation.poll();
    const beforeResource = ((await f.json('/api/resources')).body.resources as Resource[])[0]!;
    expect(beforeResource.health?.service?.state).toBe('healthy');
    const cursor = (await f.json('/api/resources')).body.cursor as string;
    const ownerCursor = f.store.latestEventId();
    const before = ((await f.json('/api/catalog/scopes')).body.scopes as unknown[])[0];
    expect(before).toMatchObject({ scopeKey: 'host:docker', resourceCount: 1, generation: 0, errorCode: null, lastSuccessAt: beforeResource.observedAt });
    const live = await f.events(undefined, 'host-token', { until: '"state":"unhealthy"', run: async () => {
      f.advance(60_000);
      const partial = nativeSample(f.time(), 3);
      partial.docker.complete = false; partial.docker.errors = ['docker_limit']; partial.docker.containers = [];
      f.source.set(partial);
      expect((await f.observation.poll())[0]?.status).toBe('accepted');
      expect((await f.json('/api/catalog/scopes')).body.scopes).toEqual([before]);
      const restricted = (await f.mcp('list_resources')).value;
      expect(restricted.coverage).toEqual([before]);
      expect(restricted.resources).toEqual([beforeResource]);
      expect((await f.json('/api/resources')).body.resources).toEqual([beforeResource]);
      const owner = (await f.json('/api/catalog/scopes', 'broad-token')).body.scopes as Array<{ scopeKey: string }>;
      expect(owner.find(scope => scope.scopeKey === 'host:docker')).toMatchObject({ state: 'partial', errorCode: 'docker_limit', generation: 2 });
      f.advance(60_000);
      const complete = nativeSample(f.time(), 4);
      complete.docker.containers[0]!.healthStatus = 'unhealthy';
      complete.docker.containers.push({ ...complete.docker.containers[0]!, id: 'c'.repeat(64), name: 'hidden-sibling' });
      f.source.set(complete);
      expect((await f.observation.poll())[0]?.status).toBe('accepted');
    } });
    const replay = await f.events(cursor);
    for (const wire of [live, replay]) {
      expect(wire).toContain(f.childId);
      expect(wire).toContain('docker_health_status');
      expect(wire).not.toMatch(/event: coverage\n|docker_limit|hidden-sibling/);
    }
    expect(live.match(/"state":"healthy","source":"docker-health"/g)).toHaveLength(1);
    const ownerReplay = await f.events(ownerCursor, 'broad-token');
    expect(ownerReplay).toContain('docker_limit');
    expect(ownerReplay).toContain('"generation":3');
    const scopes = (await f.json('/api/catalog/scopes')).body.scopes;
    expect(scopes).toEqual([expect.objectContaining({ scopeKey: 'host:docker', generation: 0, errorCode: null, resourceCount: 1 })]);
    const mcp = (await f.mcp('list_resources')).value;
    expect(mcp.coverage).toEqual(scopes);
    expect((mcp.resources as Resource[]).map(resource => resource.id)).toEqual([f.childId]);
    expect(((await f.json('/api/resources')).body.resources as Resource[]).map(resource => resource.id)).toEqual([f.childId]);
  });
  it('binds replay to the restricted credential and policy and ignores hidden replay pressure', async () => {
    const f = await fixture();
    const cursor = (await f.json('/api/resources')).body.cursor as string;
    const owner = await f.json('/api/resources', 'owner');
    expect(typeof owner.body.cursor).toBe('number');
    expect(cursor).toMatch(/^[A-Za-z0-9_-]{48}$/);
    f.config.agentTokens.push({ name: 'other-reader', hash: tokenHash('other-token'), scopes: ['read'], readPolicy: { resourceIds: [f.hostId] } });
    expect((await f.json(`/api/events?cursor=${cursor}`, 'other-token')).status).toBe(400);
    expect((await f.json(`/api/events?cursor=${owner.body.cursor}`)).status).toBe(400);
    f.store.atomic(() => {
      for (let index = 0; index < 260; index++) f.store.appendEvent('resource', f.childId, { resourceId: f.childId, hidden: index });
      f.store.appendEvent('incident', f.hostId, { resourceId: f.hostId, resourceName: 'visible-after-hidden', category: 'infrastructure' });
    });
    const wire = await f.events(cursor);
    expect(wire).toContain('visible-after-hidden');
    expect(wire).not.toContain('event-history-unavailable');
    const ids = [...wire.matchAll(/^id: (\S+)$/gm)].map(match => match[1]);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{48}$/);
    const frame = wire.split('\n\n').find(value => /^event: incident-state$/m.test(value));
    expect(frame).toBeDefined();
    const incident = JSON.parse(frame!.split('\n').find(line => line.startsWith('data: '))!.slice(6));
    expect(incident).toMatchObject({ component: `change:${incident.id}`, openingEventId: null, lastEventId: null });
    expect(incident).not.toHaveProperty('recoveryEventId');
    expect(wire).not.toContain(f.childId);
    f.config.agentTokens[0]!.readPolicy!.resourceIds = [];
    expect((await f.json(`/api/events?cursor=${cursor}`)).status).toBe(400);
  });
  it('keeps an open container incident until its own Docker evidence expires', async () => {
    const f = await fixture();
    f.config.agentTokens[0]!.readPolicy!.resourceIds = [f.childId];
    f.advance(60_000);
    const full = nativeSample(f.time(), 2);
    full.docker.containers[0]!.healthStatus = 'unhealthy';
    full.docker.containers.push({ ...full.docker.containers[0]!, id: 'c'.repeat(64), name: 'hidden-sibling' });
    f.source.set(full); await f.observation.poll();
    const before = (await f.json('/api/incidents/current')).body.incidents;
    expect(before).toEqual([expect.objectContaining({ component: 'docker-health', status: 'open', resourceId: f.childId })]);
    const cursor = (await f.json('/api/resources')).body.cursor as string;
    f.advance(60_000);
    const partial = nativeSample(f.time(), 3);
    partial.docker.complete = false; partial.docker.errors = ['docker_timeout']; partial.docker.containers = [];
    f.source.set(partial); await f.observation.poll();
    expect((await f.json('/api/incidents/current')).body.incidents).toEqual(before);
    expect((await f.mcp('get_incidents', { view: 'current' })).value.incidents).toEqual(before);
    const replay = await f.events(cursor);
    expect(replay).not.toMatch(/event: incident-state\n|host_signal_unknown|docker_timeout|hidden-sibling/);
    f.advance(120_000); f.monitor.tick();
    expect((await f.json('/api/incidents/current')).body.incidents).toEqual([expect.objectContaining({ status: 'unknown', resourceId: f.childId })]);
    expect((await f.mcp('get_incidents', { view: 'current' })).value.incidents).toEqual([expect.objectContaining({ status: 'unknown', resourceId: f.childId })]);
    expect(await f.events(cursor)).toContain('host_signal_unknown');
  });
  it('replaces cached Docker health with unknown after reconnect across a reboot', async () => {
    const f = await fixture();
    f.config.agentTokens[0]!.readPolicy!.resourceIds = [f.childId];
    f.advance(60_000);
    const full = nativeSample(f.time(), 2);
    full.docker.containers[0]!.healthStatus = 'healthy';
    f.source.set(full); expect((await f.observation.poll())[0]?.status).toBe('accepted');
    const initial = await f.json('/api/resources');
    expect(initial.body.resources).toEqual([expect.objectContaining({ id: f.childId, health: expect.objectContaining({ service: expect.objectContaining({ state: 'healthy' }) }) })]);
    f.advance(60_000);
    const partial = nativeSample(f.time(), 3);
    partial.bootId = '10000000-0000-4000-8000-000000000002';
    partial.docker.complete = false; partial.docker.errors = ['docker_timeout']; partial.docker.containers = [];
    f.source.set(partial); expect((await f.observation.poll())[0]?.status).toBe('accepted');
    const wire = await f.events(initial.body.cursor as string);
    const resources = wire.split('\n\n').filter(frame => /^event: resource$/m.test(frame)).map(frame => JSON.parse(frame.split('\n').find(line => line.startsWith('data: '))!.slice(6)));
    expect(resources).toEqual([expect.objectContaining({ id: f.childId, observedAt: null, state: 'unknown' })]);
  });
  it('keeps SSE quiet when only hidden Docker evidence expires', async () => {
    const f = await fixture();
    const initial = nativeSample(f.time(), 2);
    f.advance(60_000);
    const sample = nativeSample(f.time(), 2);
    sample.docker.containers.push({ ...initial.docker.containers[0]!, id: 'c'.repeat(64), name: 'hidden-sibling' });
    f.source.set(sample); await f.observation.poll();
    await f.next(3);
    f.config.agentTokens[0]!.readPolicy!.resourceIds = [f.childId];
    const before = (await f.json('/api/resources')).body.resources;
    const wire = await f.events(undefined, 'host-token', { until: 'visibility-fixture-marker', run: async () => {
      f.advance(120_000);
      await f.observation.poll();
      expect((await f.json('/api/resources')).body.resources).toEqual(before);
      f.store.appendEvent('incident', f.childId, { resourceId: f.childId, resourceName: 'visibility-fixture-marker', category: 'infrastructure' });
    } });
    expect(wire.match(/^event: resource$/gm)).toHaveLength(1);
    expect(wire).not.toContain('hidden-sibling');
  });
  it('filters explicit service relations before returning the service', async () => {
    const f = await fixture();
    f.catalog.configureServices([{ key: 'service', name: 'Explicit service', criticality: 'normal', relations: [{ resourceId: f.hostId, relationType: 'hosted_on', evidence: 'operator_confirmed' }, { resourceId: f.childId, relationType: 'depends_on', evidence: 'operator_confirmed' }] }]);
    const services = (await f.json('/api/catalog/services')).body.services as Array<{ relations: Array<{ resourceAlias: string }> }>;
    expect(services[0]?.relations.map(relation => relation.resourceAlias)).toEqual([f.hostId]);
  });
  it('filters operational incidents, SSE and actual MCP delivery leases', async () => {
    const f = await fixture(); await f.mcp('get_pending_incidents'); const cursor = (await f.json('/api/resources')).body.cursor as string;
    for (const [id, name] of [[f.hostId, 'root-visible'], [f.childId, 'child-hidden']] as const) f.store.appendEvent('incident', id, { source: 'host-native-monitor', category: 'infrastructure', resourceId: id, resourceName: name, component: 'host-cpu', kind: 'observability', status: 'open', actionable: true, transitionReason: 'host_threshold_exceeded', observedAt: new Date(f.time()).toISOString() });
    const restricted = (await f.json('/api/incidents/current')).body.incidents as Array<{ id: string }>;
    expect(JSON.stringify(restricted)).not.toContain(f.childId);
    expect(restricted).toEqual([expect.objectContaining({ openingEventId: null, lastEventId: null })]);
    expect((await f.json('/api/incidents/current', 'owner')).body.incidents).toContainEqual(expect.objectContaining({ id: restricted[0]!.id, openingEventId: expect.any(Number) }));
    expect((await f.mcp('get_incidents', { view: 'current' })).value.incidents).toEqual(restricted);
    expect(await f.events(cursor)).not.toContain('child-hidden');
    const incidents = await f.mcp('get_incidents');
    expect(JSON.stringify(incidents.value)).toContain('root-visible');
    expect(JSON.stringify(incidents.value)).not.toMatch(/child-hidden|eventId|openingEventId|lastEventId/);
    const history = await f.json(`/api/incidents/${restricted[0]!.id}/history`);
    expect(history.status).toBe(200);
    expect(JSON.stringify(history.body)).not.toMatch(/"(?:id|eventId|openingEventId|lastEventId|recoveryEventId)":\d/);
    const lease = await f.mcp('get_pending_incidents');
    const deliveries = lease.value.deliveries as Array<{ deliveryId: string; version: string; eventId: number | null; incident: Record<string, unknown> }>;
    expect(lease.value.cursor).toBeNull();
    expect(deliveries).toEqual([expect.objectContaining({ eventId: null, version: expect.stringMatching(/^[A-Za-z0-9_-]{62}$/), incident: expect.objectContaining({ resourceId: f.hostId }) })]);
    const { deliveryId, version } = deliveries[0]!;
    expect((await f.mcp('acknowledge_incident', { deliveryId, version })).value).toMatchObject({ acknowledged: true, duplicate: false });
    expect((await f.mcp('acknowledge_incident', { deliveryId, version })).value).toMatchObject({ acknowledged: true, duplicate: true });
    f.store.appendEvent('incident', f.hostId, { resourceId: f.hostId, resourceName: 'root-later', category: 'infrastructure' });
    const first = (await f.mcp('get_incidents', { limit: 1 })).value;
    expect(first).toMatchObject({ hasMore: true, nextCursor: expect.stringMatching(/^[A-Za-z0-9_-]{62}$/) });
    const second = (await f.mcp('get_incidents', { limit: 1, cursor: first.nextCursor })).value;
    expect(second).toMatchObject({ hasMore: false, nextCursor: expect.stringMatching(/^[A-Za-z0-9_-]{62}$/) });
    expect(JSON.stringify(second.incidents)).toContain('root-later');
    expect(JSON.stringify(second.incidents)).not.toContain('child-hidden');
    const idle = (await f.mcp('get_incidents', { limit: 1, cursor: second.nextCursor })).value;
    expect(idle).toMatchObject({ incidents: [], hasMore: false, nextCursor: second.nextCursor });
    f.store.appendEvent('incident', f.hostId, { resourceId: f.hostId, resourceName: 'root-after-catchup', category: 'infrastructure' });
    const resumed = (await f.mcp('get_incidents', { limit: 1, cursor: second.nextCursor })).value;
    expect(resumed).toMatchObject({ incidents: [expect.objectContaining({ incident: expect.objectContaining({ resourceName: 'root-after-catchup' }) })], hasMore: false });
  });
  it('revalidates replay, active leases and ACK after a container is retired', async () => {
    const f = await fixture();
    f.config.agentTokens[0]!.readPolicy!.resourceIds = [f.childId];
    await f.mcp('get_pending_incidents');
    const initial = (await f.json('/api/resources')).body;
    const cursor = initial.cursor as string;
    let localInventory = new Map((initial.resources as Resource[]).map(resource => [resource.id, resource] as const));
    expect(localInventory.has(f.childId)).toBe(true);
    f.store.appendEvent('incident', f.childId, { resourceId: f.childId, resourceName: 'previously-visible', category: 'infrastructure', component: 'docker-health', status: 'open', actionable: true });
    const lease = (await f.mcp('get_pending_incidents')).value.deliveries as Array<{deliveryId:string;version:string}>;
    expect(lease).toHaveLength(1);
    for (const [sequence, advance] of [[2, 60_000], [3, 900_000]] as const) {
      f.advance(advance);
      const sample = nativeSample(f.time(), sequence); sample.docker.containers = [];
      f.source.set(sample); await f.observation.poll();
    }
    expect(f.catalog.resolveAlias(f.childId)?.lifecycle).toBe('retired');
    const wire = await f.events(cursor);
    expect(wire).not.toContain('previously-visible');
    expect(wire).not.toContain(f.childId);
    const invalidation = wire.split('\n\n').find(value => /^event: resync$/m.test(value));
    expect(invalidation).toMatch(/^id: [A-Za-z0-9_-]{48}$/m);
    const data = JSON.parse(invalidation!.split('\n').find(line => line.startsWith('data: '))!.slice(6));
    expect(data).toEqual({ reason: 'inventory-visibility-changed', snapshotRequired: true });
    if (data.snapshotRequired) {
      const snapshot = (await f.json('/api/resources')).body;
      localInventory = new Map((snapshot.resources as Resource[]).map(resource => [resource.id, resource] as const));
      expect(await f.events(snapshot.cursor as string)).not.toContain('inventory-visibility-changed');
    }
    expect(localInventory.has(f.childId)).toBe(false);
    expect((await f.mcp('get_pending_incidents')).value.deliveries).toEqual([]);
    const { deliveryId, version } = lease[0]!;
    const ack = await f.mcp('acknowledge_incident', { deliveryId, version });
    expect(ack.value.error).toMatchObject({ reason: 'not_found' });
    expect((await f.json('/api/catalog/resources?history=true', 'owner')).body.resources).toEqual(expect.arrayContaining([expect.objectContaining({ lifecycle: 'retired' })]));
  });
  it('hides disabled and removed enrollments even if their catalog connection is manually reactivated', async () => {
    const f = await fixture();
    f.config.hosts![0]!.enabled = false;
    const connection = f.catalog.connections().find(row => row.provider === 'host')!; f.catalog.setConnectionState(connection.id, 'active');
    for (const path of ['/api/resources','/api/catalog/resources','/api/catalog/scopes','/api/catalog/connections']) {
      const result = await f.json(path, 'broad-token'); expect(JSON.stringify(result.body)).not.toContain(f.binding.accountId);
    }
    expect((await f.mcp('get_resource', { resourceId: f.hostId })).isError).toBe(true);
    f.config.hosts = [];
    expect((await f.json('/api/resources', 'broad-token')).body.resources).toEqual([]);
    expect(f.catalog.listResources()).toHaveLength(2);
  });
  it('rechecks configuration after awaited trusted file IO', async () => {
    const f = await fixture(); let release: (() => void) | undefined;
    f.advance(60000); f.source.set(nativeSample(f.time(), 2));
    f.source.pause(() => new Promise<void>(resolve => { release = resolve; }));
    const polling = f.observation.poll();
    for (let count = 0; !release && count < 100; count++) await new Promise<void>(resolve => setImmediate(resolve));
    expect(release).toBeDefined(); f.config.hosts![0]!.enabled = false; release!(); await polling;
    expect(f.store.hostObservations.current('fixture-host')?.sequence).toBe(1);
    expect((await f.json('/api/resources')).body.resources).toEqual([]);
  });
  it('expires by actual time without refreshing the file or claiming host off', async () => {
    const f = await fixture(), reads = f.source.reads(), observedAt = new Date(f.time()).toISOString();
    f.advance(180000);
    const resource = ((await f.json('/api/resources')).body.resources as Resource[])[0]!;
    expect(resource.state).toBe('unknown'); expect(resource.health?.presence?.state).toBe('stale'); expect(resource.observedAt).toBe(observedAt);
    expect(f.source.reads()).toBe(reads);
    expect(((await f.json('/api/system/health')).body.catalog as { stale: number }).stale).toBe(1);
  });
  it('keeps old Docker rows on partial enumeration and never assigns container obligations automatically', async () => {
    const f = await fixture(), old = f.catalog.listResources().find(row => row.resourceType === 'docker-container')!;
    f.advance(60000); const partial = nativeSample(f.time(), 2); partial.docker.complete = false; partial.docker.errors = ['docker_changed']; partial.docker.containers = [];
    f.source.set(partial); await f.observation.poll();
    expect(f.catalog.listResources().find(row => row.catalogId === old.catalogId)).toMatchObject({ observedAt: old.observedAt, lifecycle: 'active' });
    expect(f.store.operational.expectation(f.childId).mode).toBe('observe');
    expect(f.store.db.prepare('SELECT COUNT(*) AS count FROM availability_expectations').get()?.count).toBe(0);
  });
  it('starts and closes its actual source with no IO for a disabled host', async () => {
    const f = await fixture(false); expect(f.source.reads()).toBe(0);
    expect((await f.json('/api/resources', 'broad-token')).body.resources).toEqual([]);
    f.observation.close(); expect(await f.observation.poll()).toEqual([]);
  });
  it('documents host in runtime OpenAPI and exposes no host control actions', async () => {
    const f = await fixture();
    const openapi = await f.json('/api/openapi.json');
    expect(JSON.stringify(openapi.body)).toContain('"aws","coolify","host"');
    const host = ((await f.json('/api/resources')).body.resources as Resource[])[0]!;
    expect(host.actions).toEqual([]); expect(f.perform).not.toHaveBeenCalled();
    for (let sequence = 2; sequence <= 4; sequence++) await f.next(sequence, 95);
    f.monitor.tick(); expect(f.costs).not.toHaveBeenCalled();
  });
});
