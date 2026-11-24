import { describe, expect, it, vi } from 'vitest';
import { AwsCatalogDiscovery, type AwsDiscoveryIO } from '../server/aws-discovery.js';
import { CatalogRepository } from '../server/catalog.js';
import { Store } from '../server/store.js';
import type { AwsAccount } from '../server/types.js';

const accountId = '123456789012';
const base = Date.parse('2026-10-23T00:00:00.000Z');
const account: AwsAccount = { name: 'test-profile', accountId, accessKeyId: 'fixture-only', secretAccessKey: 'fixture-only', instances: [{ id: 'i-known', region: 'us-east-1', name: 'legacy-name', type: 't3.small' }] };
const instance = (id: string, tags: { Key?: string; Value?: string }[] = []) => ({
  InstanceId: id, InstanceType: 't4g.small', State: { Name: 'running' }, StateTransitionReason: 'User initiated (2026-10-22T23:00:00Z)', Tags: tags
});
function fixture() {
  const store = new Store(':memory:');
  const catalog = new CatalogRepository(store);
  catalog.registerConnection({ provider: 'aws', providerAccountId: accountId, name: account.name, credentialRef: 'fixture' });
  let failRegion: string | null = null;
  let identity = accountId;
  let currentTime = base;
  const io: AwsDiscoveryIO = {
    identity: async () => identity,
    regions: vi.fn(async () => ({ regions: ['us-east-1', 'us-west-2'] })),
    instances: vi.fn(async (_account, region, nextToken) => {
      if (region === failRegion) throw new Error('provider-secret');
      if (region === 'us-west-2') return { instances: [] };
      if (nextToken) return { instances: [instance('i-second', [{ Key: 'Project', Value: 'prod-cms' }, { Key: 'Environment', Value: 'production' }])] };
      return { instances: [instance('i-known', [{ Key: 'Name', Value: 'cms' }])], nextToken: 'instances-2' };
    }),
    now: () => currentTime
  };
  return { store, catalog, io, discovery: new AwsCatalogDiscovery(catalog, [account], io), failRegion: (value: string | null) => { failRegion = value; }, identity: (value: string) => { identity = value; }, advance: (ms: number) => { currentTime += ms; } };
}

describe('descubrimiento AWS paginado y reconciliación', () => {
  it('verifica la cuenta STS, páginas y regiones antes de publicar recursos', async () => {
    const f = fixture();
    await f.discovery.scan();
    const rows = f.catalog.listResources();
    expect(rows).toHaveLength(2);
    expect(rows.find(row => row.providerId === 'i-known')).toMatchObject({ name: 'cms', state: 'running', stateChangedAt: '2026-10-22T23:00:00.000Z', aliases: expect.arrayContaining(['aws:test-profile:i-known']) });
    expect(rows.find(row => row.providerId === 'i-second')).toMatchObject({ project: 'prod-cms', environment: 'production' });
    expect(f.catalog.listScopes().filter(scope => scope.state === 'healthy').map(scope => scope.scopeKey).sort()).toEqual(['aws:ec2:us-east-1', 'aws:ec2:us-west-2', 'aws:identity', 'aws:regions']);
    expect(f.io.regions).toHaveBeenCalledTimes(1);
    expect(f.io.instances).toHaveBeenCalledTimes(3);
    f.store.close();
  });

  it('marca un scope fallido sin retirar recursos previamente observados y redacta errores', async () => {
    const f = fixture();
    await f.discovery.scan();
    f.advance(15 * 60_000);
    f.failRegion('us-east-1');
    await f.discovery.scan();
    expect(f.catalog.listResources().every(row => row.lifecycle === 'active')).toBe(true);
    expect(f.catalog.listScopes().find(scope => scope.scopeKey === 'aws:ec2:us-east-1')).toMatchObject({ state: 'failed', errorCode: 'provider_error' });
    expect(JSON.stringify(f.catalog.listScopes())).not.toContain('provider-secret');
    f.store.close();
  });

  it('detiene el barrido si la identidad real no coincide con la conexión', async () => {
    const f = fixture();
    f.identity('999999999999');
    await f.discovery.scan();
    expect(f.io.regions).not.toHaveBeenCalled();
    expect(f.io.instances).not.toHaveBeenCalled();
    expect(f.catalog.listResources()).toHaveLength(0);
    expect(f.catalog.listScopes().find(scope => scope.scopeKey === 'aws:identity')).toMatchObject({ state: 'failed', errorCode: 'account_mismatch' });
    f.store.close();
  });

  it('conserva la lectura de regiones legacy cuando AWS deniega enumerar regiones sin ocultar la cobertura fallida', async () => {
    const f=fixture();
    vi.mocked(f.io.regions).mockRejectedValueOnce(Object.assign(new Error('provider-secret'),{name:'UnauthorizedOperation'}));
    const result=await f.discovery.scan();
    expect(result.failures).toBe(1);
    expect(f.catalog.listResources()).toHaveLength(2);
    expect(vi.mocked(f.io.instances).mock.calls.map(call=>call[1])).toEqual(['us-east-1','us-east-1']);
    expect(f.catalog.listScopes().find(scope=>scope.scopeKey==='aws:regions')).toMatchObject({state:'failed',errorCode:'access_denied'});
    expect(f.catalog.listScopes().find(scope=>scope.scopeKey==='aws:ec2:us-east-1')).toMatchObject({state:'healthy',resourceCount:2});
    expect(JSON.stringify(f.catalog.listScopes())).not.toContain('provider-secret');
    f.store.close();
  });

  it('mantiene regiones previamente observadas si vence la caché y falla la enumeración posterior', async () => {
    const f=fixture();await f.discovery.scan();
    f.advance(24*60*60_000+1);
    vi.mocked(f.io.regions).mockRejectedValueOnce(Object.assign(new Error(),{name:'TimeoutError'}));
    vi.mocked(f.io.instances).mockClear();
    await f.discovery.scan();
    expect(new Set(vi.mocked(f.io.instances).mock.calls.map(call=>call[1]))).toEqual(new Set(['us-east-1','us-west-2']));
    expect(f.catalog.listScopes().find(scope=>scope.scopeKey==='aws:regions')).toMatchObject({state:'failed',errorCode:'timeout'});
    f.store.close();
  });

  it('no inventa regiones si no hay configuración ni evidencia previa cuando la enumeración falla', async () => {
    const f=fixture();
    vi.mocked(f.io.regions).mockRejectedValueOnce(Object.assign(new Error(),{name:'UnauthorizedOperation'}));
    await new AwsCatalogDiscovery(f.catalog,[{...account,instances:[]}],f.io).scan();
    expect(f.io.instances).not.toHaveBeenCalled();
    expect(f.catalog.listResources()).toEqual([]);
    expect(f.catalog.listScopes().find(scope=>scope.scopeKey==='aws:regions')).toMatchObject({state:'failed',errorCode:'access_denied'});
    f.store.close();
  });

  it('rechaza paginación repetida como snapshot parcial y no marca bajas', async () => {
    const f = fixture();
    await f.discovery.scan();
    const instances = f.io.instances as ReturnType<typeof vi.fn>;
    f.advance(15 * 60_000);
    instances.mockImplementation(async (_account: AwsAccount, region: string, _token?: string) => region === 'us-east-1'
      ? { instances: [instance('i-known')], nextToken: 'same' }
      : { instances: [] });
    await f.discovery.scan();
    expect(f.catalog.listResources().every(row => row.lifecycle === 'active')).toBe(true);
    expect(f.catalog.listScopes().find(scope => scope.scopeKey === 'aws:ec2:us-east-1')?.errorCode).toBe('repeated_page_token');
    f.store.close();
  });
});
