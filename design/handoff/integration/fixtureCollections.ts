import type { AttentionSummary, Operation, OperationReview, OperationalIncident, PageInfo, PageQuery, PowerIntent, Resource, ResourceExpectation, SecretRequest, SecretGrant, SecretAuditEvent } from '../ui/src/contract.ts';
import { ProviderError, type DataProvider } from './provider.ts';

export type FixtureCollectionSeed = {
  operations?: Operation[]; requests?: SecretRequest[]; grants?: SecretGrant[]; audit?: SecretAuditEvent[];
  incidents?: OperationalIncident[]; incidentVersions?: OperationalIncident[];
  /** Relaciones declaradas de la fixture; nunca se deducen de nombres. */
  aliases?: Record<string, string>; coverage?: AttentionSummary['coverage'];
};
type Methods = Pick<DataProvider, 'getOperations' | 'getActiveOperations' | 'getReviewOperations' | 'getCurrentIncidents' | 'getIncidentHistory' | 'getIncidentVersions' | 'getAttentionSummary' | 'reviewOperation' | 'acknowledgeIncident' | 'getResourceExpectation' | 'putResourceExpectation' | 'getSecretRequests' | 'getPendingSecretRequests' | 'getSecretRequestCounts' | 'getSecretGrants' | 'getSecretAudit'>;
type Deps = {
  seed?: FixtureCollectionSeed; ready: () => Promise<void>; resources: () => Resource[]; operations: () => Operation[];
  requests: () => SecretRequest[]; setRequests: (rows: SecretRequest[]) => void; grants: () => SecretGrant[];
  audit: () => SecretAuditEvent[]; setAudit: (rows: SecretAuditEvent[]) => void; record: (operation: Operation) => void;
};
const copy = <T,>(value: T): T => structuredClone(value);
function fail(status = 400, message = 'Cursor o filtros no válidos.'): never { throw new ProviderError({ kind: 'http', status, message }); }
const choice = (value: string | undefined, choices: readonly string[]) => { if (value && !choices.includes(value)) fail(); };
const text = (q: string | undefined, ...values: unknown[]) => !q || values.join(' ').toLowerCase().includes(q.toLowerCase());
const active = (operation: Operation) => operation.state === 'accepted' || operation.state === 'running';

/** Modelo exclusivamente simulado, en memoria y por instancia del proveedor. */
export function createFixtureCollections(deps: Deps) {
  const reviews = new Map<string, OperationReview>();
  const expectations = new Map<string, ResourceExpectation>();
  const revoked = new Set<string>();
  const incidents = copy(deps.seed?.incidents ?? []);
  const versions = copy(deps.seed?.incidentVersions ?? incidents);
  let revision = Math.max(0, ...incidents.map(row => row.version), ...versions.map(row => row.version), ...deps.operations().map(row => row.review?.version ?? 0));
  const ordinals = new Map<string, Map<string, number>>();
  const cursors = new Map<string, { context: string; bound: number; last: number; expires: number }>();
  const canonical = (id: string): string => {
    const declared = deps.seed?.aliases?.[id];
    if (declared) return declared;
    const resource = deps.resources().find(row => row.id === id || `catalog:${row.catalog?.catalogId}` === id);
    return resource?.catalog ? `catalog:${resource.catalog.catalogId}` : id;
  };
  function index<T>(kind: string, rows: readonly T[], id: (row: T) => string, at: (row: T) => string): Map<string, number> {
    let keys = ordinals.get(kind);
    if (!keys) { keys = new Map(); ordinals.set(kind, keys); }
    const missing = rows.filter(row => !keys!.has(id(row))).sort((a, b) => at(a).localeCompare(at(b)) || id(a).localeCompare(id(b)));
    for (const row of missing) keys.set(id(row), keys.size + 1);
    return keys;
  }
  index('operations', deps.operations(), row => row.id, row => row.createdAt);
  index('requests', deps.requests(), row => row.id, row => row.createdAt);
  index('grants', deps.grants(), row => row.id, row => row.createdAt);
  index('incidents', incidents, row => row.id, row => row.openedAt);
  function page<T>(kind: string, query: PageQuery | undefined, rows: readonly T[], key: (row: T) => number, filter: (row: T) => boolean, defaultLimit = 25): { items: T[] } & PageInfo {
    const q = query ?? {};
    const limit = q.limit ?? defaultLimit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || q.cursor !== undefined && (typeof q.cursor !== 'string' || q.cursor.length > 2048)) fail();
    for (const field of ['q', 'actor', 'state', 'type', 'resourceId', 'view'] as const) if (q[field] !== undefined && typeof q[field] !== 'string') fail();
    if ((q.q?.length ?? 0) > 160 || (q.actor?.length ?? 0) > 100 || (q.state?.length ?? 0) > 40 || (q.type?.length ?? 0) > 80 || (q.resourceId?.length ?? 0) > 220 || (q.view?.length ?? 0) > 40) fail();
    const context = JSON.stringify([kind, q.q?.trim() ?? '', q.actor ?? '', q.state ?? '', q.type ?? '', q.resourceId ?? '', q.view ?? '']);
    const maximum = rows.reduce((value, row) => Math.max(value, key(row)), 0);
    const point = q.cursor ? cursors.get(q.cursor) : { context, bound: maximum, last: maximum + 1, expires: Date.now() + 1_800_000 };
    if (!point || point.context !== context || point.expires <= Date.now()) fail();
    const eligible = rows.filter(row => key(row) <= point.bound && key(row) < point.last && filter(row)).sort((a, b) => key(b) - key(a));
    const selected = eligible.slice(0, limit), hasMore = eligible.length > limit;
    let nextCursor: string | null = null;
    if (hasMore) {
      nextCursor = `fixture-${crypto.randomUUID()}`;
      cursors.set(nextCursor, { ...point, last: key(selected[selected.length - 1]!) });
    }
    return { items: copy(selected), nextCursor, hasMore };
  }
  function observe(): void {
    const rows = deps.operations(), keys = index('operations', rows, row => row.id, row => row.createdAt);
    for (const row of rows) {
      if (!reviews.has(row.id) && row.review) reviews.set(row.id, copy(row.review));
      if (!reviews.has(row.id) && row.action !== 'refresh' && ['failed', 'uncertain'].includes(row.state)) reviews.set(row.id, { disposition: 'pending', version: ++revision, canonicalResourceId: canonical(row.resourceId), updatedAt: row.updatedAt, reason: 'execution_not_confirmed', evidence: { kind: 'execution_result' } });
    }
    for (const row of rows) {
      const review = reviews.get(row.id);
      if (review?.disposition !== 'pending') continue;
      const later = rows.filter(candidate => candidate.action !== 'refresh' && candidate.state === 'succeeded' && canonical(candidate.resourceId) === canonical(row.resourceId) && keys.get(candidate.id)! > keys.get(row.id)!).sort((a, b) => keys.get(b.id)! - keys.get(a.id)!)[0];
      if (later) reviews.set(row.id, { disposition: 'superseded', version: ++revision, canonicalResourceId: canonical(row.resourceId), updatedAt: new Date().toISOString(), reason: row.action === later.action ? 'later_confirmed_same_target' : 'later_confirmed_new_power_intention', supersededByOperationId: later.id, evidence: { kind: 'later_confirmed_power', operationId: later.id, action: later.action, confirmedAt: later.updatedAt } });
    }
  }
  function decorate(operation: Operation): Operation { observe(); const review = reviews.get(operation.id); return copy(review ? { ...operation, review } : operation); }
  function operationPage(query?: PageQuery, forcedView?: 'active' | 'review') {
    observe(); const q = forcedView ? { ...query, view: forcedView } : query ?? {};
    choice(q.state, ['accepted', 'running', 'succeeded', 'failed', 'uncertain']); choice(q.type, ['start', 'stop', 'refresh', 'boot-windows', 'boot-cachyos', 'power']); choice(q.view, ['history', 'all', 'active', 'review']);
    const rows = deps.operations().map(decorate), keys = index('operations', rows, row => row.id, row => row.createdAt);
    const result = page('operations', q, rows, row => keys.get(row.id)!, row => (!q.actor || row.actor === q.actor) && (!q.state || row.state === q.state) && (!q.type || (q.type === 'power' ? row.action !== 'refresh' : row.action === q.type)) && (!q.resourceId || canonical(row.resourceId) === canonical(q.resourceId)) && (q.view !== 'active' || active(row)) && (q.view !== 'review' || row.review?.disposition === 'pending') && text(q.q?.trim(), row.resourceName, row.actor, row.message, row.action), query === undefined && !forcedView ? 100 : 25);
    return { operations: result.items, nextCursor: result.nextCursor, hasMore: result.hasMore };
  }
  function expireRequests(): void {
    const at = new Date().toISOString(), audit = [...deps.audit()]; let nextId = Math.max(0, ...audit.map(row => row.id));
    const rows = deps.requests().map(row => {
      if (!['pending', 'approved'].includes(row.state) || Date.parse(row.expiresAt) > Date.now()) return row;
      audit.push({ id: ++nextId, at, requestId: row.id, event: 'expired', actor: 'system' });
      return { ...row, state: 'expired' as const };
    });
    deps.setRequests(rows); deps.setAudit(audit);
  }
  function requestPage(query?: PageQuery, pending = false) {
    expireRequests(); const q = pending ? { ...query, state: 'pending' } : query ?? {};
    choice(q.state, ['pending', 'approved', 'denied', 'expired', 'delivered', 'failed']);
    const rows = deps.requests(), keys = index('requests', rows, row => row.id, row => row.createdAt);
    const result = page(pending ? 'pending-requests' : 'requests', q, rows, row => keys.get(row.id)!, row => (!q.state || row.state === q.state) && (!q.actor || row.agent === q.actor) && text(q.q?.trim(), row.name, row.project, row.agent, row.machine));
    return { requests: result.items, pendingCount: rows.filter(row => row.state === 'pending').length, nextCursor: result.nextCursor, hasMore: result.hasMore };
  }
  function incidentPage(query?: PageQuery, view: 'current' | 'history' = 'current') {
    const q = { ...query, view }; choice(q.state, ['open', 'unknown', 'resolved', 'information']); choice(q.type, ['application', 'observability', 'availability', 'coverage', 'budget', 'change']);
    const keys = index('incidents', incidents, row => row.id, row => row.openedAt);
    const result = page('incidents', q, incidents, row => keys.get(row.id)!, row => (view !== 'current' || ['open', 'unknown'].includes(row.status)) && (!q.state || row.status === q.state) && (!q.type || row.kind === q.type) && (!q.resourceId || row.canonicalResourceId === canonical(q.resourceId)) && text(q.q?.trim(), JSON.stringify(row)));
    return { incidents: result.items, nextCursor: result.nextCursor, hasMore: result.hasMore };
  }
  function expectation(id: string): ResourceExpectation {
    const resourceId = canonical(id), stored = expectations.get(resourceId);
    return copy(stored ?? { resourceId, mode: id.startsWith('computer:') ? 'on-demand' : 'observe', version: 0, updatedAt: null });
  }
  function intent(id: string): PowerIntent | null {
    observe(); const keys = ordinals.get('operations')!;
    const row = deps.operations().filter(value => value.action !== 'refresh' && canonical(value.resourceId) === canonical(id)).sort((a, b) => keys.get(b.id)! - keys.get(a.id)!)[0];
    if (!row) return null;
    const power = row.action === 'start' || row.action === 'stop';
    const expiresAt = new Date(Date.parse(row.state === 'succeeded' ? row.updatedAt : row.createdAt) + 600_000).toISOString();
    const confirmedStop = row.action === 'stop' && row.state === 'succeeded';
    const expected = power && row.state !== 'failed' && (confirmedStop || Date.now() < Date.parse(expiresAt));
    return { operationId: row.id, action: row.action, result: row.state, requestedAt: row.createdAt, ...(row.state === 'succeeded' ? { confirmedAt: row.updatedAt } : {}), targetPower: row.action === 'stop' ? 'off' : 'on', ...(row.action === 'boot-windows' ? { targetSystem: 'windows' as const } : row.action === 'boot-cachyos' ? { targetSystem: 'cachyos' as const } : {}), transition: { expected, ...(expected ? { reasonCode: confirmedStop ? 'intended_host_stop' : 'expected_ec2_transition' } : {}), expiresAt: expected && !confirmedStop ? expiresAt : null } };
  }
  const methods: Methods = {
    async getOperations(query) { await deps.ready(); return operationPage(query); },
    async getActiveOperations(query) { await deps.ready(); return operationPage(query, 'active'); },
    async getReviewOperations(query) { await deps.ready(); return operationPage(query, 'review'); },
    async getCurrentIncidents(query) { await deps.ready(); return incidentPage(query, 'current'); },
    async getIncidentHistory(query) { await deps.ready(); return incidentPage(query, 'history'); },
    async getIncidentVersions(id, query) {
      await deps.ready(); if (!incidents.some(row => row.id === id)) fail(404, 'Incidente no encontrado.');
      const result = page(`incident-versions:${id}`, query, versions.filter(row => row.id === id), row => row.version, () => true);
      return { events: result.items, nextCursor: result.nextCursor, hasMore: result.hasMore };
    },
    async getAttentionSummary() {
      await deps.ready(); observe(); expireRequests();
      const pending = deps.operations().filter(row => reviews.get(row.id)?.disposition === 'pending');
      const current = incidents.filter(row => row.actionable && ['open', 'unknown'].includes(row.status));
      const groups = new Set([...pending.map(row => canonical(row.resourceId)), ...current.map(row => row.canonicalResourceId ?? row.key)]);
      return { fetchedAt: new Date().toISOString(), counts: { attentionGroups: groups.size, active: deps.operations().filter(active).length, pendingReviews: pending.length, openIncidents: current.filter(row => row.status === 'open').length, unknownIncidents: current.filter(row => row.status === 'unknown').length, coverageProblems: current.filter(row => row.kind === 'coverage').length }, coverage: copy(deps.seed?.coverage ?? { scopes: 0, healthy: 0, partial: 0, failed: 0, stale: 0 }), pendingApprovals: deps.requests().filter(row => row.state === 'pending').length };
    },
    async reviewOperation(id, expectedVersion, reason) {
      await deps.ready(); observe(); choice(reason, ['checked_state', 'accepted_uncertainty', 'no_further_action']);
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) fail();
      const row = deps.operations().find(value => value.id === id), review = reviews.get(id);
      if (!row || !review) fail(404, 'Revisión no encontrada.');
      if (review.disposition === 'reviewed' && review.reason === reason) return decorate(row);
      if (review.version !== expectedVersion || review.disposition !== 'pending') fail(409, 'La revisión cambió.');
      const at = new Date().toISOString();
      reviews.set(id, { disposition: 'reviewed', version: ++revision, canonicalResourceId: canonical(row.resourceId), updatedAt: at, reason, reviewedBy: 'Admin', reviewedAt: at, evidence: { kind: 'human_review' } });
      const result = decorate(row); deps.record(result); return result;
    },
    async acknowledgeIncident(id, expectedVersion) {
      await deps.ready(); if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) fail();
      const index = incidents.findIndex(row => row.id === id); if (index < 0) fail(404, 'Incidente no encontrado.');
      const row = incidents[index]!; if (row.acknowledgement) return copy(row);
      if (row.version !== expectedVersion) fail(409, 'El informe cambió.');
      const result = { ...row, version: ++revision, acknowledgement: { by: 'Admin', at: new Date().toISOString(), reportVersion: expectedVersion } };
      incidents[index] = result; versions.push(copy(result)); return copy(result);
    },
    async getResourceExpectation(id) { await deps.ready(); return { expectation: expectation(id), intent: intent(id) }; },
    async putResourceExpectation(id, expectedVersion, mode) {
      await deps.ready(); choice(mode, ['observe', 'on-demand', 'always-on']);
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) fail();
      const current = expectation(id);
      if (current.mode === mode && current.version >= expectedVersion) return { expectation: current, intent: intent(id) };
      if (current.version !== expectedVersion) fail(409, 'La expectativa cambió.');
      expectations.set(current.resourceId, { ...current, mode, version: current.version + 1, updatedAt: new Date().toISOString() });
      return { expectation: expectation(id), intent: intent(id) };
    },
    async getSecretRequests(query) { await deps.ready(); return requestPage(query); },
    async getPendingSecretRequests(query) { await deps.ready(); return requestPage(query, true); },
    async getSecretRequestCounts() {
      await deps.ready(); expireRequests(); const counts: Record<string, number> = { pending: 0, approved: 0, denied: 0, expired: 0, delivered: 0, failed: 0 };
      for (const row of deps.requests()) counts[row.state] = (counts[row.state] ?? 0) + 1;
      return { counts };
    },
    async getSecretGrants(query) {
      await deps.ready(); const q = query ?? {}; choice(q.state, ['active', 'revoked', 'all']);
      const rows = deps.grants(), keys = index('grants', rows, row => row.id, row => row.createdAt);
      const result = page('grants', q, rows, row => keys.get(row.id)!, row => (q.state === 'all' || revoked.has(row.id) === (q.state === 'revoked')) && (!q.actor || row.agent === q.actor) && (!q.type || row.scope === q.type) && text(q.q?.trim(), row.name, row.project, row.agent, row.machine));
      return { grants: result.items, nextCursor: result.nextCursor, hasMore: result.hasMore };
    },
    async getSecretAudit(query) {
      await deps.ready(); expireRequests(); const q = query ?? {};
      const result = page('audit', q, deps.audit(), row => row.id, row => {
        const request = deps.requests().find(value => value.id === row.requestId);
        return (!q.actor || row.actor === q.actor) && (!q.type || row.event === q.type) && (!q.state || request?.state === q.state) && text(q.q?.trim(), row.event, row.actor, request?.name ?? '', request?.project ?? '');
      });
      return { events: result.items, nextCursor: result.nextCursor, hasMore: result.hasMore };
    },
  };
  return { methods, decorate, observe, expireRequests, revokeGrant(id: string) { const exists = deps.grants().some(row => row.id === id) && !revoked.has(id); if (exists) revoked.add(id); return { revoked: exists }; } };
}
