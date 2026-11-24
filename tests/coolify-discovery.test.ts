import { describe, expect, it, vi } from 'vitest';
import { CatalogRepository } from '../server/catalog.js';
import { CoolifyCatalogDiscovery, CatalogDiscoveryScheduler } from '../server/coolify-discovery.js';
import { Store } from '../server/store.js';

describe('descubrimiento Coolify y cadence compartida', () => {
  it('persiste todos los recursos de Coolify sin conceder acciones', async () => {
    const store = new Store(':memory:'), catalog = new CatalogRepository(store);
    const connection = catalog.registerConnection({ provider: 'coolify', providerAccountId: 'https://coolify.example', name: 'Coolify', credentialRef: 'fixture' });
    const fetcher = vi.fn(async () => Response.json([
      { uuid: 'app-one', name: 'CMS', type: 'application', status: 'running:healthy' },
      { uuid: 'svc-two', name: 'Redis', type: 'service', status: 'running:healthy' }
    ]));
    const discovery = new CoolifyCatalogDiscovery(catalog, connection.id, 'https://coolify.example', 'fixture-token', fetcher as typeof fetch, () => Date.parse('2026-10-23T00:00:00Z'));

    await discovery.scan();
    expect(catalog.listResources().map(row => row.providerId).sort()).toEqual(['app-one', 'svc-two']);
    expect(catalog.mergeInventory([]).every(row => row.actions.length === 0)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    store.close();
  });

  it('una respuesta parcial falla el scope y conserva recursos anteriores', async () => {
    const store = new Store(':memory:'), catalog = new CatalogRepository(store);
    const connection = catalog.registerConnection({ provider: 'coolify', providerAccountId: 'https://coolify.example', name: 'Coolify', credentialRef: 'fixture' });
    let body: unknown = [{ uuid: 'app-one', name: 'CMS', type: 'application', status: 'running' }];
    let now = Date.parse('2026-10-23T00:00:00Z');
    const discovery = new CoolifyCatalogDiscovery(catalog, connection.id, 'https://coolify.example', 'fixture-token', async () => Response.json(body), () => now);
    await discovery.scan();
    now += 120_000;
    body = { resources: [] };
    await discovery.scan();
    expect(catalog.listResources()).toHaveLength(1);
    expect(catalog.listScopes().find(scope => scope.scopeKey === 'coolify:resources')).toMatchObject({ state: 'partial', errorCode: 'invalid_response' });
    store.close();
  });

  it('respeta Retry-After y evita sondear Coolify durante una limitación', async () => {
    const store=new Store(':memory:'),catalog=new CatalogRepository(store);
    const connection=catalog.registerConnection({provider:'coolify',providerAccountId:'https://coolify.example',name:'Coolify',credentialRef:'fixture'});
    let now=Date.parse('2026-10-23T00:00:00Z');
    const fetcher=vi.fn().mockResolvedValueOnce(new Response('{}',{status:429,headers:{'Retry-After':'600'}})).mockResolvedValueOnce(Response.json([]));
    const discovery=new CoolifyCatalogDiscovery(catalog,connection.id,'https://coolify.example','fixture-token',fetcher as typeof fetch,()=>now);
    await discovery.scan();now+=120_000;await discovery.scan();
    expect(fetcher).toHaveBeenCalledTimes(1);
    now+=480_000;await discovery.scan();
    expect(fetcher).toHaveBeenCalledTimes(2);
    store.close();
  });

  it('ejecuta Coolify cada 120 s y AWS cada 900 s sin scheduler por cliente', async () => {
    let now = 1_000_000;
    const aws = { scan: vi.fn(async () => ({ resources: [], failures: 0 })) };
    const coolify = { scan: vi.fn(async () => ({ resources: [], failures: 0 })) };
    const scheduler = new CatalogDiscoveryScheduler(aws, coolify, () => now);
    await scheduler.tick();
    expect(aws.scan).toHaveBeenCalledTimes(1);
    expect(coolify.scan).toHaveBeenCalledTimes(1);
    now += 120_000;
    await scheduler.tick();
    expect(aws.scan).toHaveBeenCalledTimes(1);
    expect(coolify.scan).toHaveBeenCalledTimes(2);
    now += 780_000;
    await scheduler.tick();
    expect(aws.scan).toHaveBeenCalledTimes(2);
    expect(coolify.scan).toHaveBeenCalledTimes(3);
    scheduler.close();
  });
});
