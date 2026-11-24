import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AwsCatalogDiscovery, type AwsDiscoveryIO } from '../server/aws-discovery.js';
import { InfrastructureAdapter, type Transport } from '../server/infrastructure.js';
import { CatalogRepository } from '../server/catalog.js';
import { Costs, type CostAccount, type CostReport } from '../server/costs.js';
import { AwsCloudEventIngest } from '../server/cloud-events.js';
import { tokenHash } from '../server/auth.js';
import { Store } from '../server/store.js';
import type { AwsAccount, Config, Resource } from '../server/types.js';

const SOURCE = '100000000002', PRODUCTION = '100000000001', SUSPENDED = '999999999999';
const stores: Store[] = [];
function accounts(): AwsAccount[] {
  return [
    { name: 'prod', accountId: SOURCE, accessKeyId: 'fixture', secretAccessKey: 'fixture', instances: [] },
    { name: 'shop-dev', accountId: PRODUCTION, displayName: 'shop · Producción', roleArn: 'arn:aws:iam::100000000001:role/infra-control-production-monitor', sourceAccount: 'prod', instances: [] },
    { name: 'lab', accountId: SUSPENDED, accessKeyId: 'fixture-g', secretAccessKey: 'fixture-g', enabled: false, disabledReason: 'account_suspended', instances: [{ id: 'i-abcdef1234567890', region: 'us-east-1', name: 'Historical', type: 't3.small' }] }
  ];
}
function config(aws = accounts()): Config {
  return { aws, origin: 'https://control.example.test', passwordHash: 'fixture', agentTokens: [], coolify: { url: '', token: '', resources: [] }, acs: { url: '', deviceId: '' } };
}
function fixture() {
  const store = new Store(':memory:'); stores.push(store);
  return { store, catalog: new CatalogRepository(store) };
}
function snapshot() {
  return { providerId: 'i-abcdef1234567890', resourceType: 'ec2-instance', region: 'us-east-1', name: 'Historical', state: 'running', detail: 't3.small', observedAt: new Date().toISOString(), aliases: ['aws:lab:i-abcdef1234567890', `aws:${SUSPENDED}:us-east-1:i-abcdef1234567890`] };
}
function providerRow(id = 'aws:lab:i-abcdef1234567890'): Resource {
  return { id, name: 'Historical', kind: 'ec2', state: 'running', account: 'lab', location: 'us-east-1', detail: 't3.small', observedAt: new Date().toISOString(), actions: ['stop', 'refresh'] };
}
function costRow(accountId: string, account: string): CostAccount {
  return { accountId, account, status: 'available', net: 10, usage: 10, adjustments: 0, currency: 'USD', estimated: true, services: [], daily: [], budgetsStatus: 'available', budgets: [], fetchedAt: new Date().toISOString() };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-14T12:00:00Z')); });
afterEach(() => {
  try { for (const store of stores.splice(0)) store.close(); }
  finally { vi.useRealTimers(); vi.restoreAllMocks(); }
});

describe('AWS activo, suspendido y etiquetas públicas', () => {
  it('registra todos los aliases y solo descubre cuentas activas con el contexto completo', async () => {
    const { store, catalog } = fixture(), aws = accounts();
    const old = catalog.registerConnection({ provider: 'aws', providerAccountId: SUSPENDED, name: 'lab', credentialRef: 'fixture' });
    catalog.reconcileScope(old.id, 'aws:ec2:us-east-1', [snapshot()], { complete: true, observedAt: new Date().toISOString() });
    const identity = vi.fn(async (account: AwsAccount, all?: readonly AwsAccount[]) => {
      expect(account.enabled).not.toBe(false); expect(all).toBe(aws); return account.accountId;
    });
    const regions = vi.fn(async (account: AwsAccount, all?: readonly AwsAccount[]) => {
      expect(account.enabled).not.toBe(false); expect(all).toBe(aws); return { regions: ['us-east-1'] };
    });
    const instances = vi.fn(async (account: AwsAccount, _region: string, _token?: string, all?: readonly AwsAccount[]) => {
      expect(account.enabled).not.toBe(false); expect(all).toBe(aws);
      return { instances: account.accountId === PRODUCTION ? [{ InstanceId: 'i-production', State: { Name: 'running' } }] : [] };
    });
    const io: AwsDiscoveryIO = { identity, regions, instances, now: () => Date.now() };
    const result = await new AwsCatalogDiscovery(catalog, aws, io).scan();
    expect(identity.mock.calls.map(([account]) => account.accountId).sort()).toEqual([PRODUCTION, SOURCE].sort());
    expect(regions).toHaveBeenCalledTimes(2);
    expect(instances).toHaveBeenCalledTimes(2);
    expect(result.resources.every(resource => resource.accountId !== SUSPENDED)).toBe(true);
    expect(catalog.connections().find(connection => connection.id === old.id)?.state).toBe('suspended');
    expect(catalog.connectionByAlias('aws', 'lab')?.id).toBe(old.id);
    expect(catalog.listResources({ includeRetired: true }).some(resource => resource.accountId === SUSPENDED)).toBe(true);
    const inventory = catalog.mergeInventory([providerRow(), providerRow(`aws:${SUSPENDED}:us-east-1:i-abcdef1234567890`)]);
    expect(inventory.some(resource => resource.catalog?.accountId === SUSPENDED || resource.id.includes('lab'))).toBe(false);
    const production = inventory.find(resource => resource.catalog?.accountId === PRODUCTION);
    expect(production).toMatchObject({ id: `aws:${PRODUCTION}:us-east-1:i-production`, account: 'shop · Producción', actions: [] });
    expect(catalog.connectionByAlias('aws', 'shop-dev')?.name).toBe('shop · Producción');
    expect(catalog.connectionByAlias('aws', 'shop · Producción')).toBeUndefined();
    expect(catalog.listScopes().filter(scope => scope.connectionId === old.id).every(scope => scope.state !== 'healthy')).toBe(true);
    expect(store).toBeDefined();
  });

  it('suspender conserva historia y reactivar no convierte scopes antiguos en saludables', () => {
    const { catalog } = fixture();
    const connection = catalog.registerConnection({ provider: 'aws', providerAccountId: SUSPENDED, name: 'lab', credentialRef: 'fixture' });
    catalog.reconcileScope(connection.id, 'aws:ec2:us-east-1', [snapshot()], { complete: true, observedAt: new Date().toISOString() });
    const before = catalog.listResources({ includeRetired: true })[0];
    const scope = catalog.listScopes()[0];
    catalog.configureServices([{ key: 'historical', name: 'Historical service', criticality: 'normal', relations: [{ resourceId: before.aliases[0], relationType: 'hosted_on', evidence: 'operator_confirmed' }] }]);
    catalog.setConnectionState(connection.id, 'suspended');
    catalog.registerConnection({ provider: 'aws', providerAccountId: SUSPENDED, name: 'lab', displayName: 'Lab', credentialRef: 'fixture' });
    expect(catalog.connections()[0].state).toBe('suspended');
    expect(catalog.listResources({ includeRetired: true })[0]).toMatchObject({ catalogId: before.catalogId, state: before.state, lifecycle: before.lifecycle, observedAt: before.observedAt, aliases: before.aliases });
    expect(catalog.asResource(before, new Set(before.aliases))).toMatchObject({ actions: [], coverage: { state: 'unknown' } });
    expect(catalog.listServices()[0].relations).toEqual([]);
    expect(catalog.listServices(true)[0].relations).toHaveLength(1);
    expect(catalog.applyVerifiedObservation(before.aliases[0], 'stopped', new Date(Date.now() + 1000).toISOString())).toBe(false);
    expect(catalog.applyAwsStateEvent({ accountId: SUSPENDED, region: 'us-east-1', instanceId: before.providerId, state: 'stopped', eventTime: new Date(Date.now() + 1000).toISOString(), eventId: 'fixture' }).status).toBe('ignored');
    expect(catalog.reconcileScope(connection.id, scope.scopeKey, [], { complete: true, observedAt: new Date(Date.now() + 1000).toISOString() }).applied).toBe(false);
    catalog.setConnectionState(connection.id, 'active');
    expect(catalog.listScopes()[0]).toMatchObject({ state: 'partial', generation: scope.generation, lastSuccessAt: scope.lastSuccessAt });
    expect(catalog.asResource(before, new Set(before.aliases)).actions).not.toContain('stop');
  });

  it('elimina aliases de providers incluso si todavía no existe una fila de recurso', () => {
    const { catalog } = fixture();
    const connection = catalog.registerConnection({ provider: 'aws', providerAccountId: SUSPENDED, name: 'lab', credentialRef: 'fixture' });
    catalog.setConnectionState(connection.id, 'suspended');
    expect(catalog.mergeInventory([providerRow(), providerRow(`aws:${SUSPENDED}:us-east-1:i-unknown`)])).toEqual([]);
    expect(catalog.isResourceReferenceActive(`aws:${SUSPENDED}:us-east-1:i-unknown`)).toBe(false);
    expect(catalog.isResourceReferenceActive('computer:desktop')).toBe(true);
  });

  it('InfrastructureAdapter excluye suspendidas antes del IO y mantiene solo el allowlist configurado', async () => {
    const cfg = config();
    cfg.aws[0].instances = [{ id: 'i-source', region: 'us-east-1', name: 'Source', type: 't3.small' }];
    const send = vi.fn(async () => ({ Reservations: [{ Instances: [{ InstanceId: 'i-source', State: { Name: 'running' } }] }] }));
    const ec2 = vi.fn((account: AwsAccount, _region: string, _attempts?: number, all?: readonly AwsAccount[]) => {
      expect(account.accountId).toBe(SOURCE); expect(all).toBe(cfg.aws); return { send };
    });
    const io = { ec2, fetch: vi.fn(async () => { throw new Error('Unexpected HTTP'); }), wait: vi.fn(async () => undefined), now: () => Date.now() } as unknown as Transport;
    const adapter = new InfrastructureAdapter(cfg, io);
    const inventory = await adapter.cloudInventory();
    expect(inventory.map(resource => resource.id)).toEqual(['aws:prod:i-source']);
    expect(ec2).toHaveBeenCalledTimes(1);
    expect(ec2.mock.calls[0][2]).toBe(2);
    await expect(adapter.perform(providerRow(), 'stop')).rejects.toThrow('Resource not permitted');
    await expect(adapter.perform({ ...providerRow(`aws:${PRODUCTION}:us-east-1:i-production`), account: 'shop · Producción' }, 'stop')).rejects.toThrow('Resource not permitted');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('Costs solo consulta activas, pasa todas las fuentes y re-etiqueta sin metadata privada', async () => {
    const { store } = fixture(), cfg = config();
    const ce = vi.fn((account: AwsAccount, all?: readonly AwsAccount[]) => {
      expect(account.accountId).not.toBe(SUSPENDED); expect(all).toBe(cfg.aws);
      return { send: async () => ({ ResultsByTime: [] }) };
    });
    const budgets = vi.fn((account: AwsAccount, all?: readonly AwsAccount[]) => {
      expect(account.accountId).not.toBe(SUSPENDED); expect(all).toBe(cfg.aws);
      return { send: async () => ({ Budgets: [] }) };
    });
    const costs = new Costs(cfg, store, { ce, budgets });
    const result = await costs.get();
    expect(result.accounts.map(row => row.accountId)).toEqual([SOURCE, PRODUCTION]);
    expect(result.accounts[1].account).toBe('shop · Producción');
    expect(Object.keys(result.accounts[1]).sort()).toEqual(Object.keys(costRow(PRODUCTION, 'fixture')).sort());
    expect(costs.cacheHealth()).toMatchObject({ configuredAccounts: 2, reservedCycles: 2 });
    expect(costs.cacheHealth([SUSPENDED])).toMatchObject({ configuredAccounts: 0, reservedCycles: 0 });
    await new Costs(cfg, store, { ce, budgets }).get();
    expect(ce).toHaveBeenCalledTimes(2);
    expect(budgets).toHaveBeenCalledTimes(2);
    expect(costs.getCached().report?.accounts).toEqual(result.accounts);
  });

  it('Costs no rescata filas suspendidas de un informe persistido ni pierde su reserva', async () => {
    const { store } = fixture(), cfg = config();
    const cached: CostReport = { accounts: cfg.aws.map(account => costRow(account.accountId, account.name)), fetchedAt: new Date().toISOString(), nextRefreshAt: new Date(Date.now() + 86400000).toISOString(), periodStart: '2026-11-01', periodEnd: '2026-11-14', policy: 'fixture' };
    store.putCache('costs-v1', cached, 86400000);
    const forbidden = () => { throw new Error('Unexpected AWS IO'); };
    const costs = new Costs(cfg, store, { ce: forbidden, budgets: forbidden });
    expect(costs.getCached().report?.accounts.map(row => row.accountId)).toEqual([SOURCE, PRODUCTION]);
    expect((await costs.get()).accounts.map(row => row.accountId)).toEqual([SOURCE, PRODUCTION]);
    expect(store.cache('cost-account-v1:' + SUSPENDED)).toBeDefined();
    expect(cached.accounts).toHaveLength(3);
  });

  it('rechaza eventos suspendidos y no aplica eventos pendientes al suspender una cuenta', async () => {
    const { store, catalog } = fixture();
    const aws = accounts();
    aws[2].enabled = true; delete aws[2].disabledReason;
    const connection = catalog.registerConnection({ provider: 'aws', providerAccountId: SUSPENDED, name: 'lab', credentialRef: 'fixture' });
    catalog.reconcileScope(connection.id, 'aws:ec2:us-east-1', [snapshot()], { complete: true, observedAt: new Date().toISOString() });
    const token = 'fixture-cloud-event-token-1234567890';
    const applied = vi.fn(), apply = vi.spyOn(catalog, 'applyAwsStateEvent'), finish = vi.spyOn(store, 'finishCloudEvent');
    const ingest = new AwsCloudEventIngest(store, catalog, aws, { [SUSPENDED]: tokenHash(token) }, applied);
    const event = { id: 'fixture-event', source: 'aws.ec2', 'detail-type': 'EC2 Instance State-change Notification', account: SUSPENDED, region: 'us-east-1', time: new Date().toISOString(), detail: { 'instance-id': 'i-abcdef1234567890', state: 'stopped' } };
    try {
      expect(ingest.accept(token, event).status).toBe('accepted');
      aws[2].enabled = false; aws[2].disabledReason = 'account_suspended';
      catalog.setConnectionState(connection.id, 'suspended');
      expect(() => ingest.accept(token, { ...event, id: 'another-event' })).toThrow('La cuenta del evento no está conectada.');
      await ingest.drain();
      expect(apply).not.toHaveBeenCalled();
      expect(applied).not.toHaveBeenCalled();
      expect(finish).toHaveBeenCalledWith(`${SUSPENDED}:fixture-event`, 'ignored', 'account_unavailable');
      expect(catalog.listResources({ includeRetired: true })[0].state).toBe('running');
    } finally { ingest.close(); }
  });
});
