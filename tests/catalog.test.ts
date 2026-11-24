import { describe, expect, it } from 'vitest';
import { CatalogRepository } from '../server/catalog.js';
import { Store } from '../server/store.js';

const accountId = '123456789012';
const base = Date.parse('2026-10-23T00:00:00.000Z');
const observed = (offset = 0) => new Date(base + offset).toISOString();
function fixture(now: () => number = Date.now) {
  const store = new Store(':memory:');
  const catalog = new CatalogRepository(store, now);
  const connection = catalog.registerConnection({ provider: 'aws', providerAccountId: accountId, name: 'test-profile', credentialRef: 'server-config:aws/test-profile' });
  return { store, catalog, connection };
}

describe('catálogo persistente de infraestructura', () => {
  it('solo anuncia encendido/apagado con scope sano y observación vigente', () => {
    let currentNow = base + 51 * 60_000;
    const store = new Store(':memory:');
    const catalog = new CatalogRepository(store, () => currentNow);
    const connection = catalog.registerConnection({ provider: 'aws', providerAccountId: accountId, name: 'test-profile', credentialRef: 'server-config:aws/test-profile' });
    const snapshot = { providerId: 'i-fresh', resourceType: 'ec2-instance', region: 'us-east-1', name: 'fresh', state: 'running', detail: 't3.small', observedAt: observed(50 * 60_000), aliases: ['aws:test-profile:i-fresh'] };
    catalog.reconcileScope(connection.id, 'aws:ec2:us-east-1', [snapshot], { complete: true, observedAt: observed(50 * 60_000) });
    const aliases = new Set(['aws:test-profile:i-fresh']);
    const fresh = catalog.asResource(catalog.listResources()[0]!, aliases);
    expect(fresh.actions).toEqual(['stop', 'refresh']);

    catalog.reconcileScope(connection.id, 'aws:ec2:us-east-1', [], { complete: false, observedAt: observed(59 * 60_000), errorCode: 'access_denied' });
    const failedScope = catalog.asResource(catalog.listResources()[0]!, aliases);
    expect(failedScope.actions).toEqual(['refresh']);
    expect(failedScope.actionAvailability?.stop?.reasonCode).toBe('scope_unavailable');

    const newerSnapshot = { ...snapshot, observedAt: observed(99 * 60_000) };
    catalog.reconcileScope(connection.id, 'aws:ec2:us-east-1', [newerSnapshot], { complete: true, observedAt: observed(110 * 60_000) });
    currentNow = base + 121 * 60_000;
    const stale = catalog.asResource(catalog.listResources()[0]!, aliases);
    expect(stale.actions).toEqual(['refresh']);
    expect(stale.actionAvailability?.stop?.reasonCode).toBe('observation_stale');
    store.close();
  });

  it('mantiene identidad estable, alias legacy y proyecto indicado por tag', () => {
    const { store, catalog, connection } = fixture();
    const snapshot = { providerId: 'i-123', resourceType: 'ec2-instance', region: 'us-east-1', name: 'cms', state: 'running', detail: 't4g.small', observedAt: observed(), tags: { Project: 'prod-cms', Environment: 'production', PrivateToken: 'discard-me' }, aliases: ['aws:test-profile:i-123'] };
    catalog.reconcileScope(connection.id, 'aws:ec2:us-east-1', [snapshot], { complete: true, observedAt: observed() });
    const first = catalog.listResources({ includeRetired: true })[0]!;
    catalog.reconcileScope(connection.id, 'aws:ec2:us-east-1', [{ ...snapshot, name: 'cms-renamed', observedAt: observed(60_000) }], { complete: true, observedAt: observed(60_000) });
    const second = catalog.listResources({ includeRetired: true })[0]!;

    expect(first.catalogId).toBe(second.catalogId);
    expect(catalog.resolveAlias('aws:test-profile:i-123')?.catalogId).toBe(first.catalogId);
    expect(second).toMatchObject({ name: 'cms-renamed', state: 'running', lifecycle: 'active', project: 'prod-cms', environment: 'production' });
    expect(JSON.stringify(second)).not.toContain('discard-me');
    expect(catalog.listProjects()).toEqual([{ id: second.projectId, name: 'prod-cms', environments: ['production'], source: 'aws-tag' }]);
    store.close();
  });

  it('mantiene la identidad del servicio y su proyecto al mover una relación explícita a otro host', () => {
    const {store,catalog,connection}=fixture(()=>base);
    const firstHost={providerId:'i-old',resourceType:'ec2-instance',region:'us-east-1',name:'cms-old',state:'running',detail:'t3.small',observedAt:observed(),aliases:['aws:test-profile:i-old']};
    const nextHost={...firstHost,providerId:'i-new',name:'cms-new',aliases:['aws:test-profile:i-new']};
    catalog.reconcileScope(connection.id,'aws:ec2:us-east-1',[firstHost,nextHost],{complete:true,observedAt:observed()});
    const api=catalog as unknown as {configureServices(input:unknown[]):void;listServices():Array<{id:string;projectId:string|null;project:string|null;relations:Array<{resourceId:string|null;resourceAlias:string;relationType:string;evidence:string;active:boolean}>}>};
    const definition=(resourceId:string)=>({key:'rendicion',name:'Rendición',projectKey:'shop',projectName:'shop',environment:'production',criticality:'high',relations:[{resourceId,relationType:'hosted_on',evidence:'operator_confirmed'}]});
    api.configureServices([definition('aws:test-profile:i-old')]);
    const original=api.listServices()[0]!;
    expect(original).toMatchObject({key:'rendicion',name:'Rendición',project:'shop',environment:'production',criticality:'high',relations:[{resourceId:expect.any(String),resourceAlias:'aws:test-profile:i-old',relationType:'hosted_on',evidence:'operator_confirmed',active:true}]});
    api.configureServices([definition('aws:test-profile:i-new')]);
    const migrated=api.listServices()[0]!;
    expect(migrated.id).toBe(original.id);
    expect(migrated.projectId).toBe(original.projectId);
    expect(migrated.relations).toHaveLength(2);
    expect(migrated.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({resourceId:original.relations[0]!.resourceId,resourceAlias:'aws:test-profile:i-old',active:false}),
      expect.objectContaining({resourceAlias:'aws:test-profile:i-new',relationType:'hosted_on',evidence:'operator_confirmed',active:true})
    ]));
    store.close();
  });

  it('conserva una relación declarada sin resolverla hasta que el inventario observe el recurso', () => {
    const {store,catalog,connection}=fixture();
    const api=catalog as unknown as {configureServices(input:unknown[]):void;listServices():Array<{relations:Array<{resourceId:string|null;resourceAlias:string;resolved:boolean}>}>};
    api.configureServices([{key:'api',name:'API',criticality:'normal',relations:[{resourceId:'aws:test-profile:i-later',relationType:'hosted_on',evidence:'provider_metadata'}]}]);
    expect(api.listServices()[0]?.relations[0]).toMatchObject({resourceId:null,resourceAlias:'aws:test-profile:i-later',resolved:false});
    catalog.reconcileScope(connection.id,'aws:ec2:us-east-1',[{providerId:'i-later',resourceType:'ec2-instance',region:'us-east-1',name:'api-node',state:'running',detail:'t3.small',observedAt:observed(),aliases:['aws:test-profile:i-later']}],{complete:true,observedAt:observed()});
    expect(api.listServices()[0]?.relations[0]).toMatchObject({resourceId:expect.any(String),resolved:true});
    store.close();
  });

  it('no retira recursos tras un scope incompleto y exige dos snapshots completos separados', () => {
    const { store, catalog, connection } = fixture();
    const row = { providerId: 'i-123', resourceType: 'ec2-instance', region: 'us-east-1', name: 'cms', state: 'running', detail: 't4g.small', observedAt: observed() };
    const scope = 'aws:ec2:us-east-1';
    catalog.reconcileScope(connection.id, scope, [row], { complete: true, observedAt: observed() });
    catalog.reconcileScope(connection.id, scope, [], { complete: false, observedAt: observed(2 * 60 * 60_000), errorCode: 'page_failed' });
    expect(catalog.listResources({ includeRetired: true })[0]?.lifecycle).toBe('active');

    catalog.reconcileScope(connection.id, scope, [], { complete: true, observedAt: observed(3 * 60 * 60_000) });
    expect(catalog.listResources({ includeRetired: true })[0]?.lifecycle).toBe('candidate_missing');
    catalog.reconcileScope(connection.id, scope, [], { complete: true, observedAt: observed(3 * 60 * 60_000 + 14 * 60_000) });
    expect(catalog.listResources({ includeRetired: true })[0]?.lifecycle).toBe('candidate_missing');
    catalog.reconcileScope(connection.id, scope, [], { complete: true, observedAt: observed(3 * 60 * 60_000 + 15 * 60_000) });
    expect(catalog.listResources({ includeRetired: true })[0]?.lifecycle).toBe('retired');
    store.close();
  });

  it('reaparece sin cambiar UUID y conserva stateChangedAt mientras el estado no cambie', () => {
    const { store, catalog, connection } = fixture();
    const row = { providerId: 'i-123', resourceType: 'ec2-instance', region: 'us-east-1', name: 'cms', state: 'running', detail: 't4g.small', observedAt: observed() };
    const scope = 'aws:ec2:us-east-1';
    catalog.reconcileScope(connection.id, scope, [row], { complete: true, observedAt: observed() });
    const original = catalog.listResources()[0]!;
    catalog.reconcileScope(connection.id, scope, [], { complete: true, observedAt: observed(15 * 60_000) });
    catalog.reconcileScope(connection.id, scope, [{ ...row, observedAt: observed(30 * 60_000) }], { complete: true, observedAt: observed(30 * 60_000) });
    const returned = catalog.listResources()[0]!;
    expect(returned.catalogId).toBe(original.catalogId);
    expect(returned.lifecycle).toBe('active');
    expect(returned.stateChangedAt).toBe(original.stateChangedAt);
    catalog.reconcileScope(connection.id, scope, [{ ...row, state: 'stopped', observedAt: observed(45 * 60_000) }], { complete: true, observedAt: observed(45 * 60_000) });
    expect(catalog.listResources()[0]?.stateChangedAt).toBeNull();
    catalog.reconcileScope(connection.id, scope, [{ ...row, state: 'running', observedAt: observed(60 * 60_000), stateChangedAt: observed(59 * 60_000) }], { complete: true, observedAt: observed(60 * 60_000) });
    expect(catalog.listResources()[0]?.stateChangedAt).toBe(observed(59 * 60_000));
    store.close();
  });

  it('emite eventos durables solo cuando cambia el estado de cobertura', () => {
    const { store, catalog, connection } = fixture();
    const scope = 'aws:ec2:us-east-1';
    catalog.reconcileScope(connection.id, scope, [], { complete: true, observedAt: observed() });
    catalog.reconcileScope(connection.id, scope, [], { complete: true, observedAt: observed(60_000) });
    catalog.reconcileScope(connection.id, scope, [], { complete: false, state: 'partial', errorCode: 'page_failed', observedAt: observed(120_000) });
    catalog.reconcileScope(connection.id, scope, [], { complete: false, state: 'partial', errorCode: 'page_failed', observedAt: observed(180_000) });
    catalog.reconcileScope(connection.id, scope, [], { complete: true, observedAt: observed(240_000) });
    const events = store.eventsAfter(0).filter(event => event.type === 'coverage');
    expect(events.map(event => event.payload.state)).toEqual(['healthy', 'partial', 'healthy']);
    expect(events.map(event => event.aggregateId)).toEqual(Array(3).fill(`coverage:${connection.id}:${scope}`));
    store.close();
  });

  it('aplica una observación verificada de EC2 sin esperar al siguiente inventario', () => {
    const store = new Store(':memory:'), catalog = new CatalogRepository(store), connection = catalog.registerConnection({ provider: 'aws', providerAccountId: accountId, name: 'test-profile', credentialRef: 'server-config:aws/test-profile' });
    const initialAt = new Date().toISOString(), changedAt = new Date(Date.now() + 5_000).toISOString();
    catalog.reconcileScope(connection.id, 'aws:ec2:us-east-1', [{ providerId: 'i-verified', resourceType: 'ec2-instance', region: 'us-east-1', name: 'verified', state: 'running', detail: 't3.small', observedAt: initialAt, aliases: ['aws:test-profile:i-verified'] }], { complete: true, observedAt: initialAt });
    expect(catalog.applyVerifiedObservation('aws:test-profile:i-verified', 'stopped', changedAt)).toBe(true);
    expect(catalog.resolveAlias('aws:test-profile:i-verified')).toMatchObject({ state: 'stopped', observedAt: changedAt, stateChangedAt: null });
    expect(store.eventsAfter(0).filter(event => event.type === 'resource').at(-1)?.payload).toMatchObject({ state: 'stopped', reason: 'operation_verified' });
    expect(catalog.applyVerifiedObservation('aws:test-profile:i-verified', 'running', new Date(Date.now() - 1_000).toISOString())).toBe(false);
    expect(catalog.resolveAlias('aws:test-profile:i-verified')?.state).toBe('stopped');
    store.close();
  });

  it('deduplica perfiles de una misma cuenta y rechaza alias en conflicto sin media escritura', () => {
    const { store, catalog, connection } = fixture();
    const other = catalog.registerConnection({ provider: 'aws', providerAccountId: accountId, name: 'second-profile', credentialRef: 'server-config:aws/second-profile' });
    expect(other.id).toBe(connection.id);
    const scope = 'aws:ec2:us-east-1';
    const first = { providerId: 'i-1', resourceType: 'ec2-instance', region: 'us-east-1', name: 'one', state: 'running', detail: 't3.small', observedAt: observed(), aliases: ['legacy:shared'] };
    const second = { ...first, providerId: 'i-2', name: 'two' };
    catalog.reconcileScope(connection.id, scope, [first], { complete: true, observedAt: observed() });
    expect(() => catalog.reconcileScope(connection.id, scope, [second], { complete: true, observedAt: observed(60_000) })).toThrow();
    expect(catalog.listResources({ includeRetired: true })).toHaveLength(1);
    store.close();
  });
});
