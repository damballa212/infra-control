import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpProvider } from '../integration/httpProvider.ts';
import { createFixtureProvider } from '../integration/fixtureProvider.ts';
import type { Operation, OperationalIncident, PageQuery, SecretRequest } from '../ui/src/contract.ts';

afterEach(() => vi.unstubAllGlobals());
const timestamp = '2026-11-12T12:00:00.000Z';
const operation = (id: string, patch: Partial<Operation> = {}): Operation => ({ id, resourceId: 'computer:desktop', resourceName: 'PC', action: 'stop', actor: 'Admin', state: 'uncertain', message: 'Sin confirmar', createdAt: timestamp, updatedAt: timestamp, ...patch });
const pending = (id: string): SecretRequest => ({ id, agent: 'worker', machine: 'declarada', name: 'TEST_KEY', project: 'test', environment: null, destination: { kind: 'process' }, reason: 'fixture', state: 'pending', scope: null, createdAt: timestamp, expiresAt: '2099-01-01T00:00:00.000Z', decidedAt: null, deliveredAt: null, auto: false });
function mockFetch(handler: (path: string, init?: RequestInit) => Response | Promise<Response> = () => Response.json({})) {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => { const path = String(input); calls.push({ path, init }); return handler(path, init); });
  return { calls, provider: createHttpProvider(fetcher as typeof fetch) };
}
describe('adaptador HTTP operacional', () => {
  it('conserva llamadas sin argumentos y codifica filtros y cursores sin construir otra URL', async () => {
    const { provider, calls } = mockFetch();
    await provider.getOperations(); await provider.getSecretRequests(); await provider.getSecretGrants(); await provider.getSecretAudit();
    expect(calls.map(call => call.path)).toEqual(['/api/operations', '/api/secrets/requests', '/api/secrets/grants', '/api/secrets/audit']);
    const query: PageQuery = { limit: 20, cursor: 'opaque_-', q: 'EC2 & café', actor: 'Admin/agent', state: 'uncertain', type: 'power', resourceId: 'catalog:x/y', view: 'history' };
    const reads = [provider.getOperations, provider.getActiveOperations, provider.getReviewOperations, provider.getCurrentIncidents, provider.getIncidentHistory, provider.getSecretRequests, provider.getPendingSecretRequests, provider.getSecretGrants, provider.getSecretAudit];
    for (const read of reads) await read(query);
    expect(calls.slice(4).map(call => new URL(call.path, 'https://fixture.test').pathname)).toEqual(['/api/operations', '/api/operations/active', '/api/operations/review', '/api/incidents/current', '/api/incidents/history', '/api/secrets/requests', '/api/secrets/requests/pending', '/api/secrets/grants', '/api/secrets/audit']);
    for (const call of calls.slice(4)) {
      const url = new URL(call.path, 'https://fixture.test');
      expect(Object.fromEntries(url.searchParams)).toEqual(Object.fromEntries(Object.entries(query).map(([key, value]) => [key, String(value)])));
      expect(call.init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    }
  });
  it('usa los verbos y cuerpos reales; no envía una operación de energía al revisar', async () => {
    const { provider, calls } = mockFetch();
    await provider.getIncidentVersions('episode/a', { limit: 20, cursor: 'next' });
    await provider.getAttentionSummary(); await provider.getSecretRequestCounts();
    await provider.reviewOperation('operation/a', 7, 'checked_state');
    await provider.acknowledgeIncident('episode/a', 8);
    await provider.getResourceExpectation('computer:desktop/a');
    await provider.putResourceExpectation('computer:desktop/a', 0, 'on-demand');
    expect(calls.map(call => call.path)).toEqual(['/api/incidents/episode%2Fa/history?limit=20&cursor=next', '/api/attention/summary', '/api/secrets/requests/counts', '/api/operations/operation%2Fa/review', '/api/incidents/episode%2Fa/acknowledgment', '/api/resources/computer%3Adesktop%2Fa/expectation', '/api/resources/computer%3Adesktop%2Fa/expectation']);
    expect(calls[3]!.init?.method).toBe('POST'); expect(JSON.parse(calls[3]!.init!.body as string)).toEqual({ expectedVersion: 7, reason: 'checked_state' });
    expect(calls[4]!.init?.method).toBe('POST'); expect(JSON.parse(calls[4]!.init!.body as string)).toEqual({ expectedVersion: 8 });
    expect(calls[6]!.init?.method).toBe('PUT'); expect(JSON.parse(calls[6]!.init!.body as string)).toEqual({ expectedVersion: 0, mode: 'on-demand' });
    expect(calls.some(call => call.path === '/api/operations')).toBe(false);
  });
  it('conserva Retry-After, 401 y ambigüedad de mutación sin reintentos', async () => {
    const limited = mockFetch(() => Response.json({ error: 'Espera' }, { status: 429, headers: { 'Retry-After': '31' } }));
    await expect(limited.provider.reviewOperation('x', 1, 'checked_state')).rejects.toMatchObject({ status: 429, retryAfterSeconds: 31, ambiguous: false });
    expect(limited.calls).toHaveLength(1);
    const unavailable = mockFetch(() => Response.json({}, { status: 503 }));
    await expect(unavailable.provider.putResourceExpectation('x', 0, 'observe')).rejects.toMatchObject({ status: 503, ambiguous: true });
    const unauthorized = mockFetch(() => Response.json({}, { status: 401 }));
    await expect(unauthorized.provider.getAttentionSummary()).rejects.toMatchObject({ status: 401, ambiguous: false });
    const disconnected = mockFetch(() => { throw new TypeError('offline'); });
    await expect(disconnected.provider.acknowledgeIncident('x', 1)).rejects.toMatchObject({ kind: 'network', ambiguous: true });
    expect(disconnected.calls).toHaveLength(1);
  });
});
describe('colecciones de prototipo', () => {
  it('pagina auditoría desde la más nueva, filtra en toda la colección y rechaza cursores ajenos', async () => {
    const requests = [pending('request')];
    const audit = Array.from({ length: 231 }, (_, index) => ({ id: index + 1, at: timestamp, requestId: 'request', event: index % 2 ? 'approved' : 'created', actor: index % 2 ? 'owner' : 'worker' }));
    const provider = createFixtureProvider({ latencyMs: 0, data: { requests, audit } }); await provider.login('admin', 'fixture');
    const first = await provider.getSecretAudit({ limit: 20 }); expect(first.events[0]!.id).toBe(231); expect(first.hasMore).toBe(true);
    const ids = first.events.map(row => row.id); let cursor = first.nextCursor;
    while (cursor) { const next = await provider.getSecretAudit({ limit: 20, cursor }); ids.push(...next.events.map(row => row.id)); cursor = next.nextCursor; }
    expect(ids).toHaveLength(231); expect(new Set(ids).size).toBe(231); expect(ids.at(-1)).toBe(1);
    const filtered = await provider.getSecretAudit({ limit: 20, q: 'TEST_KEY', actor: 'owner', type: 'approved', state: 'pending' });
    expect(filtered.events).toHaveLength(20); expect(filtered.events.every(row => row.actor === 'owner' && row.event === 'approved')).toBe(true);
    await expect(provider.getSecretAudit({ limit: 20, cursor: first.nextCursor!, actor: 'owner' })).rejects.toMatchObject({ status: 400 });
    await expect(provider.getOperations({ cursor: first.nextCursor! })).rejects.toMatchObject({ status: 400 });
    await expect(provider.getSecretAudit({ cursor: 'foreign' })).rejects.toMatchObject({ status: 400 });
    await expect(provider.getSecretAudit({ limit: 101 })).rejects.toMatchObject({ status: 400 });
  });
  it('no pierde revisiones/activas/peticiones antiguas detrás del historial reciente', async () => {
    const old = operation('old');
    const operations = [old, operation('active', { state: 'running', action: 'start' }), ...Array.from({ length: 130 }, (_, index) => operation(`other-${index}`, { actor: 'other', resourceId: `other:${index}`, action: 'refresh', state: 'succeeded', createdAt: '2026-11-13T12:00:00.000Z' }))];
    const requests = [pending('old-pending'), ...Array.from({ length: 130 }, (_, index) => ({ ...pending(`delivered-${index}`), state: 'delivered' as const, createdAt: '2026-11-13T12:00:00.000Z' }))];
    const provider = createFixtureProvider({ latencyMs: 0, data: { operations, requests } }); await provider.login('admin', 'fixture');
    expect((await provider.getOperations()).operations.some(row => row.id === 'old')).toBe(false);
    expect((await provider.getReviewOperations()).operations.map(row => row.id)).toEqual(['old']);
    expect((await provider.getActiveOperations()).operations.map(row => row.id)).toEqual(['active']);
    expect((await provider.getPendingSecretRequests({ limit: 20 })).requests.map(row => row.id)).toEqual(['old-pending']);
    expect((await provider.getSecretRequests({ limit: 20 })).pendingCount).toBe(1);
    expect((await provider.getAttentionSummary()).counts).toMatchObject({ active: 1, pendingReviews: 1, attentionGroups: 1 });
  });
  it('revisión y decisión posterior son sidecars; nunca reescriben uncertain', async () => {
    const old = operation('old', { action: 'boot-cachyos', resourceId: 'old-alias' });
    const confirmed = operation('confirmed', { action: 'boot-windows', state: 'succeeded', resourceId: 'new-alias', createdAt: '2026-11-13T12:00:00.000Z' });
    const provider = createFixtureProvider({ latencyMs: 0, data: { operations: [old, confirmed], aliases: { 'old-alias': 'catalog:physical', 'new-alias': 'catalog:physical' } } }); await provider.login('admin', 'fixture');
    expect(await provider.getOperation('old')).toMatchObject({ state: 'uncertain', review: { disposition: 'superseded', supersededByOperationId: 'confirmed', canonicalResourceId: 'catalog:physical' } });
    expect((await provider.getReviewOperations()).operations).toEqual([]);
    const pendingProvider = createFixtureProvider({ latencyMs: 0, data: { operations: [old] } }); await pendingProvider.login('admin', 'fixture');
    const before = await pendingProvider.getOperation('old');
    const reviewed = await pendingProvider.reviewOperation('old', before.review!.version, 'accepted_uncertainty');
    expect(reviewed).toMatchObject({ state: 'uncertain', review: { disposition: 'reviewed', reviewedBy: 'Admin' } });
    expect(await pendingProvider.reviewOperation('old', before.review!.version, 'accepted_uncertainty')).toEqual(reviewed);
    expect((await pendingProvider.getOperationHistory('old')).events.at(-1)!.payload).toMatchObject({ state: 'uncertain', review: { disposition: 'reviewed' } });
  });
  it('ACK reconoce el informe y añade versión; conserva el incidente abierto', async () => {
    const incident: OperationalIncident = { id: 'episode', key: 'probe:resource', component: 'probe', resourceId: 'resource', canonicalResourceId: 'resource', category: 'infrastructure', kind: 'application', source: 'https-probe', status: 'open', actionable: true, openedAt: timestamp, updatedAt: timestamp, openingEventId: 1, lastEventId: 1, version: 1, evidence: { reasonCode: 'service_probe_unhealthy', observedAt: timestamp } };
    const provider = createFixtureProvider({ latencyMs: 0, data: { operations: [], requests: [], incidents: [incident] } }); await provider.login('admin', 'fixture');
    const ack = await provider.acknowledgeIncident('episode', 1);
    expect(ack).toMatchObject({ status: 'open', actionable: true, acknowledgement: { reportVersion: 1 } }); expect(ack.resolvedAt).toBeUndefined();
    expect((await provider.getIncidentVersions('episode')).events).toHaveLength(2);
    expect((await provider.getAttentionSummary()).counts.openIncidents).toBe(1);
    expect(await provider.getResourceExpectation('computer:desktop')).toMatchObject({ expectation: { mode: 'on-demand', version: 0 }, intent: null });
    expect(await provider.putResourceExpectation('computer:desktop', 0, 'always-on')).toMatchObject({ expectation: { mode: 'always-on', version: 1 } });
    await expect(provider.putResourceExpectation('computer:desktop', 0, 'observe')).rejects.toMatchObject({ status: 409 });
  });
});
