import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { tokenHash } from '../server/auth.js';
import { AwsCatalogDiscovery } from '../server/aws-discovery.js';
import { Costs } from '../server/costs.js';
import { ServiceProbeMonitor } from '../server/service-probes.js';
import type { Config } from '../server/types.js';
import { Store } from '../server/store.js';
import { CatalogRepository } from '../server/catalog.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const apps: ReturnType<typeof createApp>[] = [];
const reader = 'projection-reader', hermesToken = 'projection-hermes-token', macToken = 'projection-mac-token', otelToken = 'projection-otel-token';
const config: Config = {
  origin: 'https://control.example.test', passwordHash: 'unused', agentTokens: [{ name: 'reader', hash: tokenHash(reader), scopes: ['read'] }],
  aws: [{ name: 'one', accountId: '123456789012', accessKeyId: 'fixture', secretAccessKey: 'fixture', instances: [{ id: 'i-host', region: 'us-east-1', name: 'Host', type: 'fixture' }] }],
  coolify: { url: '', token: '', resources: [] }, acs: { url: '', deviceId: '' },
  hermes: { resourceId: 'aws:one:i-host', reportTokenHash: tokenHash(hermesToken) }, macTelemetryTokenHash: tokenHash(macToken),
  otelCollectors: [{ hostId: 'projection-host-one', resourceId: 'aws:one:i-host', tokenHash: tokenHash(otelToken) }],
  serviceProbes: [{ resourceId: 'aws:one:i-host', url: 'https://health.example.com/ready', expectedStatusCodes: [200], intervalSeconds: 60, timeoutMs: 1000 }]
};
beforeEach(() => {
  vi.spyOn(AwsCatalogDiscovery.prototype, 'scan').mockResolvedValue({ resources: [], failures: 0 });
  vi.spyOn(Costs.prototype, 'get').mockResolvedValue({ accounts: [], fetchedAt: new Date().toISOString(), nextRefreshAt: new Date(Date.now() + 86400000).toISOString(), periodStart: '2026-11-01', periodEnd: '2026-11-12', policy: 'test' });
  vi.spyOn(ServiceProbeMonitor.prototype, 'start').mockImplementation(() => {});
});
afterEach(() => { apps.splice(0).forEach(app => app.locals.close()); vi.restoreAllMocks(); });
function setup(input: Config = config) {
  // Sin suppliedAdapter: recorre la composición productiva basada en catálogo.
  const app = createApp(input, ':memory:'); apps.push(app);
  const connection = app.locals.catalog.connections()[0], observedAt = new Date().toISOString();
  app.locals.catalog.reconcileScope(connection.id, 'aws:ec2:us-east-1', [{ providerId: 'i-host', resourceType: 'ec2-instance', region: 'us-east-1', name: 'Host', state: 'running', detail: 'fixture', observedAt, aliases: ['aws:one:i-host'] }], { complete: true, observedAt });
  return app;
}
async function openStream(app: ReturnType<typeof createApp>) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test address');
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/events?cursor=${app.locals.store.latestEventId()}`, { headers: { Authorization: `Bearer ${reader}` }, signal: controller.signal });
  const stream = response.body!.getReader(), decoder = new TextDecoder(); let buffer = '';
  async function resourceFrame(predicate: (value: any) => boolean): Promise<{ frame: string; value: any }> {
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      for (;;) {
        const split = buffer.indexOf('\n\n');
        if (split >= 0) {
          const frame = buffer.slice(0, split); buffer = buffer.slice(split + 2);
          if (!frame.split('\n').includes('event: resource')) continue;
          const data = frame.split('\n').find(line => line.startsWith('data: ')); if (!data) continue;
          const value = JSON.parse(data.slice(6)); if (predicate(value)) return { frame, value };
        } else {
          const next = await stream.read(); if (next.done) throw new Error('SSE ended'); buffer += decoder.decode(next.value, { stream: true });
        }
      }
    } finally { clearTimeout(timeout); }
  }
  return { resourceFrame, close: async () => { controller.abort(); app.locals.closeStreams(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

describe('proyección real de recursos compartida', () => {
  it('get_resource conserva la composición REST para aliases históricos y excluye aliases privados', async () => {
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now);
    const oldAlias = 'aws:previous-profile:i-host', hiddenAlias = 'aws:previous-profile:i-private';
    const scoped: Config = { ...config, agentTokens: [{ name: 'reader', hash: tokenHash(reader), scopes: ['read'], readPolicy: { resourceIds: [oldAlias] } }] };
    const app = setup(scoped), catalog = app.locals.catalog, store = app.locals.store;
    const connection = catalog.connections()[0];
    catalog.seedLegacyResource(connection.id, { providerId: 'i-host', resourceType: 'ec2-instance', region: 'us-east-1', name: 'Host', state: 'unknown', detail: 'fixture', aliases: [oldAlias] });
    catalog.seedLegacyResource(connection.id, { providerId: 'i-private', resourceType: 'ec2-instance', region: 'us-east-1', name: 'private-host-never-return', state: 'unknown', detail: 'fixture', aliases: [hiddenAlias] });
    await request(app).post('/api/hermes/events').set('Authorization', `Bearer ${hermesToken}`).send({ version: 1, bootId: 'hermes-alias-boot', streamId: 'hermes-alias-stream', sequence: 1, serviceState: 'failed', restartCount: 2 }).expect(204);
    const record = catalog.resolveAlias(oldAlias), observedAt = new Date(now).toISOString();
    store.recordHostTelemetry('aws:one:i-host', { cpu: { percent: 25, observedAt }, memory: { usedBytes: 512, totalBytes: 1024, utilizationPercent: 50, observedAt } }, observedAt, now);
    store.recordServiceProbe(`catalog:${record.catalogId}`, { state: 'healthy', source: 'https-probe', observedAt, freshUntil: new Date(now + 120000).toISOString(), reasonCode: 'probe_http_ok' });
    const rest = await request(app).get('/api/resources').set('Authorization', `Bearer ${reader}`).expect(200);
    const resource = rest.body.resources.find((item: any) => item.catalog?.catalogId === record.catalogId);
    expect(resource.serviceSignals).toMatchObject({ hermes: { state: 'unhealthy' }, https: { state: 'healthy' } });
    expect(resource.hostMetrics).toMatchObject({ cpu: { percent: 25 }, memory: { utilizationPercent: 50 } });
    expect(JSON.stringify(rest.body)).not.toContain('private-host-never-return');
    async function getResource(resourceId: string) {
      const response = await request(app).post('/api/mcp').set('Host', new URL(config.origin).host).set('Authorization', `Bearer ${reader}`).set('Accept', 'application/json, text/event-stream').send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_resource', arguments: { resourceId } } }).expect(200);
      const frame = response.text.split(/\r?\n/).find(line => line.startsWith('data: '));
      return (response.body.result ?? (frame ? JSON.parse(frame.slice(6)).result : undefined)) as { structuredContent: { resource?: unknown; error?: { reason: string } }; isError?: boolean };
    }
    const scans = vi.mocked(AwsCatalogDiscovery.prototype.scan).mock.calls.length;
    for (const id of [resource.id, oldAlias, `catalog:${record.catalogId}`, record.catalogId]) {
      const result = await getResource(id);
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent.resource).toEqual(resource);
    }
    const denied = await getResource(hiddenAlias);
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent.error?.reason).toBe('resource_not_found');
    expect(JSON.stringify(denied)).not.toContain('private-host-never-return');
    expect(vi.mocked(AwsCatalogDiscovery.prototype.scan).mock.calls.length).toBe(scans);
    store.db.prepare("UPDATE catalog_resources SET lifecycle='retired' WHERE id=?").run(record.catalogId);
    const historical = await getResource(oldAlias);
    expect(historical.structuredContent.resource).toMatchObject({ catalog: { catalogId: record.catalogId, lifecycle: 'retired' } });
    expect(historical.structuredContent.resource).not.toHaveProperty('hostMetrics');
  });

  it('el monitor exige solo conexiones configuradas y conserva el inventario histórico de las retiradas del config', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'infra-monitor-config-')), path = join(directory, 'infra.sqlite');
    let app: ReturnType<typeof createApp> | undefined;
    const seed = new Store(path);
    try {
      const catalog = new CatalogRepository(seed), oldAt = new Date(Date.now() - 3 * 86400000).toISOString();
      const old = catalog.registerConnection({ provider: 'aws', providerAccountId: '999999999999', name: 'removed', credentialRef: 'fixture' });
      catalog.reconcileScope(old.id, 'aws:ec2:us-west-2', [{ providerId: 'i-removed', resourceType: 'ec2-instance', region: 'us-west-2', name: 'Removed but preserved', state: 'running', detail: 'fixture', observedAt: oldAt, aliases: ['aws:removed:i-removed'] }], { complete: true, observedAt: oldAt });
    } finally { seed.close(); }
    try {
      app = createApp(config, path); apps.push(app);
      const catalog = app.locals.catalog, current = catalog.connections().find((item: any) => item.providerAccountId === '123456789012');
      const observedAt = new Date().toISOString();
      catalog.reconcileScope(current.id, 'aws:ec2:us-east-1', [{ providerId: 'i-host', resourceType: 'ec2-instance', region: 'us-east-1', name: 'Current host', state: 'running', detail: 'fixture', observedAt, aliases: ['aws:one:i-host'] }], { complete: true, observedAt });
      await vi.waitFor(async () => {
        const response = await request(app!).get('/api/system/health').set('Authorization', `Bearer ${reader}`).expect(200);
        expect(response.body.cloud).toMatchObject({ state: 'healthy', resourcesObserved: 1, unknownResources: 0 });
      });
      const inventory = await request(app).get('/api/resources').set('Authorization', `Bearer ${reader}`).expect(200);
      expect(inventory.body.resources.some((item: any) => item.id === 'aws:removed:i-removed')).toBe(false);
      expect(catalog.listResources({includeRetired:true}).some((item:any)=>item.providerId==='i-removed')).toBe(true);
      const removed = catalog.connections().find((item: any) => item.providerAccountId === '999999999999');
      catalog.reconcileScope(removed.id, 'aws:ec2:us-west-2', [], { complete: false, state: 'failed', errorCode: 'provider_error', observedAt: new Date(Date.now() + 1).toISOString() });
      expect((await request(app).get('/api/system/health').set('Authorization', `Bearer ${reader}`)).body.cloud.state).toBe('healthy');
      catalog.reconcileScope(current.id, 'aws:ec2:us-east-1', [], { complete: false, state: 'failed', errorCode: 'provider_error', observedAt: new Date(Date.now() + 2).toISOString() });
      expect((await request(app).get('/api/system/health').set('Authorization', `Bearer ${reader}`)).body.cloud.state).toBe('degraded');
      const history = await request(app).get('/api/catalog/resources?history=true').set('Authorization', `Bearer ${reader}`).expect(200);
      expect(history.body.resources.some((item: any) => item.providerId === 'i-removed')).toBe(false);
    } finally {
      if (app) { app.locals.close(); apps.splice(apps.indexOf(app), 1); }
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('incluye Hermes en el inventario normal y conserva su evidencia junto con HTTPS y OTel en SSE', async () => {
    const app = setup();
    await request(app).post('/api/hermes/events').set('Authorization', `Bearer ${hermesToken}`).send({ version: 1, bootId: 'hermes-boot-one', streamId: 'hermes-stream-one', sequence: 1, serviceState: 'failed', restartCount: 1 }).expect(204);
    const before = await request(app).get('/api/resources').set('Authorization', `Bearer ${reader}`);
    const host = before.body.resources.find((item: any) => item.id === 'aws:one:i-host');
    expect(host.serviceSignals.hermes).toMatchObject({ state: 'unhealthy', source: 'hermes-systemd-reporter' });
    expect(host.health.presence.freshUntil).toBeDefined();
    const observedAt = Date.now() - 1000, timeUnixNano = String(BigInt(observedAt) * 1000000n);
    await request(app).post('/api/telemetry/otlp/v1/metrics').set('Authorization', `Bearer ${otelToken}`).send({ resourceMetrics: [{ resource: { attributes: [{ key: 'host.id', value: { stringValue: 'projection-host-one' } }] }, scopeMetrics: [{ metrics: [{ name: 'system.cpu.utilization', gauge: { dataPoints: [{ timeUnixNano, attributes: [], asDouble: 0.25 }] } }] }] }] }).expect(200);
    const sse = await openStream(app);
    try {
      const record = app.locals.catalog.resolveAlias('aws:one:i-host');
      const at = new Date().toISOString();
      app.locals.store.recordServiceProbe(`catalog:${record.catalogId}`, { state: 'healthy', source: 'https-probe', observedAt: at, freshUntil: new Date(Date.now() + 120000).toISOString(), reasonCode: 'probe_http_ok' });
      const { value } = await sse.resourceFrame(value => value.id === 'aws:one:i-host' && value.serviceSignals?.https?.state === 'healthy');
      expect(value.hostMetrics.cpu.percent).toBe(25);
      expect(value.health.telemetry.state).toBe('fresh');
      expect(value.serviceSignals.hermes.state).toBe('unhealthy');
      expect(value.health.service.source).toBe('https-probe');
      const current = (await request(app).get('/api/resources').set('Authorization', `Bearer ${reader}`)).body.resources.find((item: any) => item.id === 'aws:one:i-host');
      expect(current.serviceSignals).toEqual(value.serviceSignals);
    } finally { await sse.close(); }
  });

  it('distribuye la frescura real de heartbeats Mac sin escribir un evento durable por muestra', async () => {
    const app = setup();
    await request(app).post('/api/mac/events').set('Authorization', `Bearer ${macToken}`).send({ bootId: 'mac-projection-one', sequence: 1, event: 'online' }).expect(204);
    await request(app).get('/api/resources').set('Authorization', `Bearer ${reader}`).expect(200);
    const sse = await openStream(app);
    try {
      const first = (await request(app).get('/api/mac/health').set('Authorization', `Bearer ${reader}`)).body.resource.observedAt;
      const cursor = app.locals.store.latestEventId();
      await new Promise(resolve => setTimeout(resolve, 15));
      await request(app).post('/api/mac/events').set('Authorization', `Bearer ${macToken}`).send({ bootId: 'mac-projection-one', sequence: 2, event: 'heartbeat' }).expect(204);
      const { frame, value } = await sse.resourceFrame(value => value.id === 'computer:mac' && Date.parse(value.observedAt) > Date.parse(first));
      expect(frame).not.toMatch(/(^|\n)id:/);
      expect(value.health.presence.state).toBe('fresh');
      expect(app.locals.store.latestEventId()).toBe(cursor);
    } finally { await sse.close(); }
  });
});
