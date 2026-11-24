import { describe, expect, it } from 'vitest';
import type { DetailedResource } from '../ui/src/contract.ts';
import { inventorySources } from '../ui/src/lib/meModel.ts';
import { mapLayout, resourceGroup } from '../ui/src/lib/controlModel.ts';

const now = Date.parse('2026-11-14T10:00:00.000Z');
const resource: DetailedResource = {
  id: 'host:opaque:docker:full-id', name: 'worker', kind: 'service', state: 'running', location: 'local', account: 'VPS', detail: 'worker:1', actions: [], observedAt: new Date(now).toISOString(),
  catalog: { catalogId: 'catalog-fixture', provider: 'host', accountId: 'opaque', region: 'local', resourceType: 'docker-container', providerId: 'a'.repeat(64), lifecycle: 'active' },
  coverage: { state: 'healthy', observedAt: new Date(now).toISOString(), freshUntil: new Date(now + 180000).toISOString() }
};
describe('native host provider semantics', () => {
  it('labels host data without treating containers as Coolify projects', () => {
    expect(inventorySources([resource], now)[0]).toMatchObject({ title: 'Host · VPS', every: 'cada 60 s', status: 'lee bien' });
    expect(resourceGroup(resource).title).not.toContain('COOLIFY');
    expect(mapLayout([resource], [], 'location', now).zones[0]?.title).toBe('Host · VPS');
    expect(resourceGroup(resource, 'project').title).toBe('Sin proyecto');
  });
  it('expires at 180 seconds and distinguishes identical display names by account identity', () => {
    expect(inventorySources([resource], now + 180000)[0]?.status).toBe('antigua');
    const other: DetailedResource = { ...resource, id: 'other', catalog: { ...resource.catalog!, accountId: 'another-opaque' } };
    expect(inventorySources([resource, other], now)).toHaveLength(2);
  });
});
