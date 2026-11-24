import type { CatalogResourceRecord, CatalogScopeRecord, CatalogSnapshot } from './catalog.js';
import type { Resource } from './types.js';
import { HOST_TTL_MS, type HostSnapshot } from './host-observation-schema.js';

export const hostAlias = (accountId: string): string => `host:${accountId}:machine`;
export function hostCatalogSnapshots(accountId: string, displayName: string, sample: HostSnapshot): { presence: CatalogSnapshot; docker: CatalogSnapshot[] } {
  return {
    presence: { providerId: 'machine', resourceType: 'linux-host', region: 'local', name: displayName, state: 'online', detail: 'Host · observación nativa', observedAt: sample.completedAt, aliases: [hostAlias(accountId)] },
    docker: sample.docker.containers.map(item => ({
      providerId: item.id, resourceType: 'docker-container', region: 'local', name: item.name,
      state: item.status, detail: `${item.image} · reinicios ${item.restartCount}`,
      observedAt: item.observedAt ?? sample.docker.observedAt,
      stateChangedAt: item.status === 'running' ? item.startedAt : item.status === 'exited' || item.status === 'dead' ? item.finishedAt : null,
      aliases: [`host:${accountId}:docker:${item.id}`]
    }))
  };
}
export function projectHostCatalogResource(record: CatalogResourceRecord, scope: CatalogScopeRecord | undefined, enabled: boolean, now: number): Resource {
  const observedAt = record.observedAt;
  const freshUntil = observedAt ? new Date(Date.parse(observedAt) + HOST_TTL_MS).toISOString() : null;
  const age = observedAt ? now - Date.parse(observedAt) : Infinity;
  const inTime = age >= -5000 && age < HOST_TTL_MS;
  const successAt = enabled ? scope?.lastSuccessAt ?? null : null;
  const coverageAge = successAt ? now - Date.parse(successAt) : Infinity;
  const coverageFreshUntil = successAt ? new Date(Date.parse(successAt) + HOST_TTL_MS).toISOString() : null;
  const coverageInTime = coverageAge >= -5000 && coverageAge < HOST_TTL_MS;
  const fresh = enabled && inTime && coverageInTime && scope?.state === 'healthy' && record.lifecycle === 'active';
  const presence = !enabled || !observedAt ? 'unknown' : !inTime ? 'stale' : fresh ? 'fresh' : 'unknown';
  const isHost = record.resourceType === 'linux-host';
  return {
    id: record.aliases[0] ?? `catalog:${record.catalogId}`, name: record.name, kind: isHost ? 'computer' : 'service',
    state: isHost ? fresh ? 'online' : 'unknown' : record.state, location: 'local', account: record.accountName,
    detail: record.detail, actions: [], observedAt, stateChangedAt: record.stateChangedAt,
    catalog: { catalogId: record.catalogId, provider: 'host', accountId: record.accountId, region: 'local', resourceType: record.resourceType, providerId: record.providerId, lifecycle: record.lifecycle },
    coverage: { state: !enabled || !scope || scope.state === 'healthy' && !coverageInTime ? 'unknown' : scope.state, observedAt: scope?.lastAttemptAt ?? null, freshUntil: coverageFreshUntil },
    health: { presence: { state: presence, source: 'host-native', observedAt, freshUntil }, control: { state: 'unavailable', source: 'host-native', observedAt, reasonCode: 'read_only_provider' }, service: { state: 'unknown', source: isHost ? 'host-native' : 'docker-health', observedAt: null, freshUntil: null } },
    ...(record.lifecycle === 'candidate_missing' ? { note: 'Ausente en una enumeración completa; se conserva el historial.' } : {})
  };
}
